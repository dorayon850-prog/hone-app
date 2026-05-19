exports.handler = async (event) => {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Content-Type': 'application/json',
  };

  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers, body: '' };
  if (event.httpMethod !== 'POST') return { statusCode: 405, headers, body: JSON.stringify({ error: 'Method not allowed' }) };

  const FC_KEY  = process.env.FIRECRAWL_API_KEY;
  const ANT_KEY = process.env.ANTHROPIC_API_KEY;

  if (!FC_KEY || !ANT_KEY) {
    return { statusCode: 500, headers, body: JSON.stringify({ error: 'API keys not configured.' }) };
  }

  let body;
  try { body = JSON.parse(event.body); }
  catch { return { statusCode: 400, headers, body: JSON.stringify({ error: 'Invalid request body' }) }; }

  const { url, industry, inputType, businessQuery } = body;

  const FC_H  = { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + FC_KEY };
  const ANT_H = { 'Content-Type': 'application/json', 'x-api-key': ANT_KEY, 'anthropic-version': '2023-06-01' };

  const withTimeout = (p, ms) =>
    Promise.race([p, new Promise(r => setTimeout(() => r(null), ms))]);

  async function scrapePage(pageUrl) {
    try {
      const res = await withTimeout(
        fetch('https://api.firecrawl.dev/v2/scrape', {
          method: 'POST', headers: FC_H,
          body: JSON.stringify({ url: pageUrl, formats: ['markdown'] }),
        }),
        5000
      );
      if (!res) return '';
      const d = await res.json();
      return ((d.data && d.data.markdown) || '').slice(0, 2500);
    } catch(e) { return ''; }
  }

  // Score a URL by relevance to products and services
  function scoreUrl(u, base) {
    const path = u.replace(base, '').toLowerCase().split('?')[0];
    if (path === '' || path === '/') return 0;
    const HIGH = [/\/product/, /\/collection/, /\/service/, /\/shop/, /\/store/,
                  /\/course/, /\/program/, /\/offering/, /\/menu/, /\/work/,
                  /\/portfolio/, /\/digital/, /\/book/, /\/tool/, /\/resource/,
                  /\/pricing/, /\/package/, /\/plan/];
    const MED  = [/\/about/, /\/about-us/, /\/our-story/, /\/faq/, /\/help/];
    for (let i = 0; i < HIGH.length; i++) if (HIGH[i].test(path)) return i + 1;
    for (let i = 0; i < MED.length;  i++) if (MED[i].test(path))  return 50 + i;
    // Deeper paths under product/collection categories are valuable
    const parts = path.split('/').filter(Boolean);
    if (parts.length === 2 && HIGH.some(p => p.test('/' + parts[0]))) return 5;
    return 999;
  }

  let siteUrl = url || '';
  let allContent = [];
  let listingsFound = {};

  // If business name given, find website first
  if (inputType === 'name' && businessQuery) {
    try {
      const res = await withTimeout(
        fetch('https://api.anthropic.com/v1/messages', {
          method: 'POST', headers: ANT_H,
          body: JSON.stringify({
            model: 'claude-sonnet-4-20250514', max_tokens: 400,
            tools: [{ type: 'web_search_20250305', name: 'web_search' }],
            messages: [{ role: 'user',
              content: 'Find website and listings for: ' + businessQuery + ' ' + industry +
                '. Return ONLY JSON: {"website":"","googleBusiness":"","yelp":""}. Empty if not found.' }],
          }),
        }).then(r => r.json()),
        8000
      );
      if (res) {
        const text = (res.content || []).filter(b => b.type === 'text').map(b => b.text).join('');
        const match = text.replace(/```json|```/g,'').trim().match(/\{[\s\S]*?\}/);
        if (match) {
          const found = JSON.parse(match[0]);
          siteUrl = found.website || '';
          listingsFound = found;
        }
      }
    } catch(e) {}
  }

  if (siteUrl) {
    // Step 1: Map the full site to discover ALL real URLs
    let allUrls = [];
    try {
      const mapRes = await withTimeout(
        fetch('https://api.firecrawl.dev/v1/map', {
          method: 'POST', headers: FC_H,
          body: JSON.stringify({ url: siteUrl, limit: 50 }),
        }),
        8000
      );
      if (mapRes) {
        const mapData = await mapRes.json();
        allUrls = (mapData.links || []);
      }
    } catch(e) {}

    // Step 2: Score every discovered URL by relevance
    const base = siteUrl.replace(/\/$/, '');
    const scored = allUrls
      .filter(u => u.startsWith(base))
      .map(u => ({ u, score: scoreUrl(u, base) }))
      .sort((a, b) => a.score - b.score);

    // Pick homepage + top 4 most relevant pages
    const toScrape = [siteUrl];
    for (const s of scored) {
      if (s.u !== siteUrl && toScrape.length < 5) toScrape.push(s.u);
    }

    // Step 3: Scrape selected pages in parallel
    const scraped = await Promise.all(
      toScrape.map(u => scrapePage(u).then(md => ({ url: u, content: md })))
    );
    scraped.filter(p => p.content).forEach(p =>
      allContent.push({ source: 'WEBSITE', url: p.url, content: p.content })
    );

    // Step 4: Find public listings in parallel with scraping (already done above for name input)
    if (inputType === 'url') {
      const domain = siteUrl.replace(/https?:\/\/(www\.)?/,'').split('/')[0];
      try {
        const res = await withTimeout(
          fetch('https://api.anthropic.com/v1/messages', {
            method: 'POST', headers: ANT_H,
            body: JSON.stringify({
              model: 'claude-sonnet-4-20250514', max_tokens: 400,
              tools: [{ type: 'web_search_20250305', name: 'web_search' }],
              messages: [{ role: 'user',
                content: 'Find listings for: ' + domain + ' ' + industry +
                  '. Return ONLY JSON: {"googleBusiness":"","yelp":""}. Empty if not found.' }],
            }),
          }).then(r => r.json()),
          7000
        );
        if (res) {
          const text = (res.content || []).filter(b => b.type === 'text').map(b => b.text).join('');
          const match = text.replace(/```json|```/g,'').trim().match(/\{[\s\S]*?\}/);
          if (match) listingsFound = JSON.parse(match[0]);
        }
      } catch(e) {}
    }

    // Step 5: Scrape listings found
    const listingTargets = [
      listingsFound.googleBusiness && { source: 'GOOGLE BUSINESS PROFILE', url: listingsFound.googleBusiness },
      listingsFound.yelp && { source: 'YELP LISTING', url: listingsFound.yelp },
    ].filter(Boolean);

    if (listingTargets.length > 0) {
      const lScraped = await Promise.all(
        listingTargets.map(l => scrapePage(l.url).then(md => ({ ...l, content: md })))
      );
      lScraped.filter(l => l.content).forEach(l => allContent.push(l));
    }
  }

  return {
    statusCode: 200,
    headers,
    body: JSON.stringify({
      allContent,
      listingsFound,
      siteUrl,
      pageCount: allContent.length,
    }),
  };
};
