const withTimeout = (p, ms) =>
  Promise.race([p, new Promise(r => setTimeout(() => r(null), ms))]);

async function scrapePage(pageUrl, fcKey) {
  try {
    const r = await withTimeout(
      fetch('https://api.firecrawl.dev/v2/scrape', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + fcKey },
        body: JSON.stringify({ url: pageUrl, formats: ['markdown'] }),
      }), 7000
    );
    if (!r) return '';
    const d = await r.json();
    return ((d.data && d.data.markdown) || '').slice(0, 3000);
  } catch(e) { return ''; }
}

function scoreUrl(u, base) {
  const path = u.replace(base, '').toLowerCase().split('?')[0];
  if (path === '' || path === '/') return 0;
  const HIGH = [
    /\/product/, /\/collection/, /\/service/, /\/shop/, /\/store/,
    /\/course/, /\/program/, /\/offering/, /\/menu/, /\/work/,
    /\/portfolio/, /\/digital/, /\/book/, /\/tool/, /\/resource/,
    /\/pricing/, /\/package/, /\/plan/, /\/about/, /\/about-us/,
  ];
  for (let i = 0; i < HIGH.length; i++) if (HIGH[i].test(path)) return i + 1;
  const parts = path.split('/').filter(Boolean);
  if (parts.length === 2 && HIGH.some(p => p.test('/' + parts[0]))) return 5;
  return 999;
}

async function claudeSearch(query, antKey, maxTokens) {
  try {
    const r = await withTimeout(
      fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-api-key': antKey, 'anthropic-version': '2023-06-01' },
        body: JSON.stringify({
          model: 'claude-sonnet-4-20250514',
          max_tokens: maxTokens || 600,
          tools: [{ type: 'web_search_20250305', name: 'web_search' }],
          messages: [{ role: 'user', content: query }],
        }),
      }).then(x => x.json()), 12000
    );
    if (!r) return null;
    const text = (r.content || []).filter(b => b.type === 'text').map(b => b.text).join('');
    return text;
  } catch(e) { return null; }
}

function extractJson(text) {
  if (!text) return null;
  try {
    const match = text.replace(/```json|```/g,'').trim().match(/\{[\s\S]*\}/);
    return match ? JSON.parse(match[0]) : null;
  } catch(e) { return null; }
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const FC_KEY  = process.env.FIRECRAWL_API_KEY;
  const ANT_KEY = process.env.ANTHROPIC_API_KEY;
  if (!FC_KEY || !ANT_KEY) return res.status(500).json({ error: 'API keys not configured.' });

  const { url, industry, inputType, businessQuery } = req.body || {};

  let siteUrl      = url || '';
  let allContent   = [];
  let listingsFound = {};
  let competitors  = [];

  // ── STEP 1: Find website if business name given ──
  if (inputType === 'name' && businessQuery) {
    const text = await claudeSearch(
      'Find website and listings for: ' + businessQuery + ' ' + industry +
      '. Return ONLY JSON: {"website":"","googleBusiness":"","yelp":"","linkedin":"","facebook":""}. Empty if not found.',
      ANT_KEY, 500
    );
    const found = extractJson(text);
    if (found) {
      siteUrl = found.website || '';
      listingsFound = found;
    }
  }

  if (siteUrl) {
    const base = siteUrl.replace(/\/$/, '');

    // ── STEP 2: Map full site to discover ALL real URLs ──
    let allUrls = [];
    try {
      const mapRes = await withTimeout(
        fetch('https://api.firecrawl.dev/v1/map', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + FC_KEY },
          body: JSON.stringify({ url: siteUrl, limit: 50 }),
        }), 10000
      );
      if (mapRes) {
        const mapData = await mapRes.json();
        allUrls = mapData.links || [];
      }
    } catch(e) {}

    // Score and select top 12 pages
    const scored = allUrls
      .filter(u => u.startsWith(base))
      .map(u => ({ u, score: scoreUrl(u, base) }))
      .sort((a, b) => a.score - b.score);

    const toScrape = [siteUrl];
    for (const s of scored) {
      if (s.u !== siteUrl && toScrape.length < 12) toScrape.push(s.u);
    }

    // ── STEP 3: Scrape all selected pages + find listings + find competitors — ALL IN PARALLEL ──
    const domain = siteUrl.replace(/https?:\/\/(www\.)?/,'').split('/')[0];

    const [scraped, listingsText, competitorText, socialText] = await Promise.all([
      // Scrape up to 12 pages in parallel
      Promise.all(toScrape.map(u => scrapePage(u, FC_KEY).then(md => ({ url: u, content: md })))),

      // Find ALL public listings
      inputType === 'url' ? claudeSearch(
        'Find ALL public listings for: ' + domain + ' ' + industry +
        '. Return ONLY JSON: {"googleBusiness":"","yelp":"","linkedin":"","facebook":"","appleMapsBing":""}. Empty if not found.',
        ANT_KEY, 600
      ) : Promise.resolve(null),

      // Find top 2 competitors in same category
      claudeSearch(
        'Name the top 2 direct competitors to a ' + industry + ' business like ' + domain +
        ' that have strong AI search visibility. Return ONLY JSON: {"competitor1":{"name":"","website":"","strength":""},"competitor2":{"name":"","website":"","strength":""}}',
        ANT_KEY, 500
      ),

      // Find social media presence
      claudeSearch(
        'Find social media profiles for: ' + domain +
        '. Return ONLY JSON: {"instagram":"","tiktok":"","youtube":"","twitter":""}. Empty if not found.',
        ANT_KEY, 400
      ),
    ]);

    // Add scraped website pages
    scraped.filter(p => p.content).forEach(p =>
      allContent.push({ source: 'WEBSITE', url: p.url, content: p.content })
    );

    // Process listings result
    if (listingsText && inputType === 'url') {
      const found = extractJson(listingsText);
      if (found) listingsFound = Object.assign(listingsFound, found);
    }

    // Process competitor data
    if (competitorText) {
      const comp = extractJson(competitorText);
      if (comp) competitors = [comp.competitor1, comp.competitor2].filter(Boolean);
    }

    // Process social profiles
    const socials = socialText ? extractJson(socialText) : null;

    // ── STEP 4: Scrape all listings and social profiles in parallel ──
    const allExternalUrls = [
      listingsFound.googleBusiness && { source: 'GOOGLE BUSINESS PROFILE', url: listingsFound.googleBusiness },
      listingsFound.yelp            && { source: 'YELP LISTING',            url: listingsFound.yelp },
      listingsFound.linkedin        && { source: 'LINKEDIN PAGE',           url: listingsFound.linkedin },
      listingsFound.facebook        && { source: 'FACEBOOK PAGE',           url: listingsFound.facebook },
      socials && socials.youtube    && { source: 'YOUTUBE CHANNEL',         url: socials.youtube },
    ].filter(Boolean);

    if (allExternalUrls.length > 0) {
      const externalScraped = await Promise.all(
        allExternalUrls.map(l => scrapePage(l.url, FC_KEY).then(md => ({ ...l, content: md })))
      );
      externalScraped.filter(l => l.content).forEach(l => allContent.push(l));
    }

    // ── STEP 5: Query gap analysis ──
    const queryGapText = await claudeSearch(
      'What are the top 5 specific questions people ask ChatGPT or Perplexity when looking for a ' + industry + ' business like ' + domain + ' that this business should be answering but probably is not? Return ONLY JSON: {"gaps":["<question 1>","<question 2>","<question 3>","<question 4>","<question 5>"]}',
      ANT_KEY, 400
    );
    const queryGaps = queryGapText ? (extractJson(queryGapText) || {}).gaps || [] : [];

    return res.status(200).json({
      allContent,
      listingsFound,
      competitors,
      queryGaps,
      siteUrl,
      pageCount: allContent.length,
      pagesScraped: scraped.filter(p => p.content).length,
    });
  }

  return res.status(200).json({ allContent, listingsFound, competitors: [], queryGaps: [], siteUrl, pageCount: 0 });
};

module.exports.config = { maxDuration: 55 };
