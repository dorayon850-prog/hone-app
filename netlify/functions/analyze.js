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

  const { analysisData: data } = body;
  if (!data) return { statusCode: 400, headers, body: JSON.stringify({ error: 'Missing analysisData' }) };

  const FC_HEADERS = {
    'Content-Type': 'application/json',
    'Authorization': 'Bearer ' + FC_KEY,
  };

  const ANT_HEADERS = {
    'Content-Type': 'application/json',
    'x-api-key': ANT_KEY,
    'anthropic-version': '2023-06-01',
  };

  async function scrapePage(url) {
    try {
      const res = await fetch('https://api.firecrawl.dev/v2/scrape', {
        method: 'POST',
        headers: FC_HEADERS,
        body: JSON.stringify({ url, formats: ['markdown'] }),
      });
      const d = await res.json();
      const md = (d.data && d.data.markdown) ? d.data.markdown : '';
      return md.slice(0, 3000);
    } catch(e) { return ''; }
  }

  async function findListings(query) {
    try {
      const res = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: ANT_HEADERS,
        body: JSON.stringify({
          model: 'claude-sonnet-4-20250514',
          max_tokens: 800,
          tools: [{ type: 'web_search_20250305', name: 'web_search' }],
          messages: [{
            role: 'user',
            content: 'Search for this business and find: 1) official website URL 2) Google Business Profile URL 3) Yelp listing URL 4) LinkedIn company page URL. Business: ' + query + '. Return ONLY JSON with keys: website, googleBusiness, yelp, linkedin. Use empty string if not found.'
          }],
        }),
      });
      const d = await res.json();
      const text = (d.content || []).filter(b => b.type === 'text').map(b => b.text).join('');
      const match = text.replace(/```json|```/g,'').trim().match(/\{[\s\S]*\}/);
      if (match) return JSON.parse(match[0]);
    } catch(e) {}
    return { website: '', googleBusiness: '', yelp: '', linkedin: '' };
  }

  async function crawlWebsite(url) {
    const pages = [];
    try {
      const mapRes = await fetch('https://api.firecrawl.dev/v1/map', {
        method: 'POST',
        headers: FC_HEADERS,
        body: JSON.stringify({ url, limit: 20 }),
      });
      const mapData = await mapRes.json();
      const allUrls = (mapData.links || []).slice(0, 20);
      const priority = ['/', '/about', '/products', '/services', '/collection', '/shop'];
      const scored = allUrls.map(u => {
        const path = u.replace(url, '').toLowerCase();
        const score = priority.findIndex(p => path.includes(p));
        return { u, score: score === -1 ? 99 : score };
      }).sort((a, b) => a.score - b.score);
      const toScrape = [url, ...scored.map(s => s.u).filter(u2 => u2 !== url)].slice(0, 5);
      const results = await Promise.allSettled(toScrape.map(u => scrapePage(u).then(md => ({ url: u, content: md }))));
      results.forEach(r => { if (r.status === 'fulfilled' && r.value.content) pages.push(r.value); });
    } catch(e) {
      const md = await scrapePage(url);
      if (md) pages.push({ url, content: md });
    }
    return pages;
  }

  let allContent = [];
  let websiteUrl = '';
  let listingsFound = {};

  if (data.path === 'AC') {
    if (data.inputType === 'url') {
      websiteUrl = data.url;
    } else {
      const found = await findListings(data.businessQuery + ' ' + data.industry);
      listingsFound = found;
      websiteUrl = found.website || '';
    }

    if (websiteUrl) {
      const pages = await crawlWebsite(websiteUrl);
      pages.forEach(p => allContent.push({ source: 'WEBSITE', url: p.url, content: p.content }));
    }

    if (data.inputType === 'url') {
      const domain = data.url.replace(/https?:\/\/(www\.)?/,'').split('/')[0];
      listingsFound = await findListings(domain + ' ' + data.industry);
    }

    const listingSources = [
      { key: 'googleBusiness', label: 'GOOGLE BUSINESS PROFILE' },
      { key: 'yelp',           label: 'YELP LISTING' },
      { key: 'linkedin',       label: 'LINKEDIN PAGE' },
    ];

    await Promise.allSettled(
      listingSources
        .filter(s => listingsFound[s.key])
        .map(async s => {
          const md = await scrapePage(listingsFound[s.key]);
          if (md) allContent.push({ source: s.label, url: listingsFound[s.key], content: md });
        })
    );
  }

  const system = 'You are a GEO expert helping small businesses become visible to AI recommendation systems. Return ONLY valid JSON with no markdown, no backticks, no explanation.';
  let userMessage = '';

  if (data.path === 'AC') {
    const contentBlock = allContent.length > 0
      ? allContent.map(c => '--- ' + c.source + ': ' + c.url + ' ---\n' + c.content).join('\n\n')
      : 'No content retrieved. Analyze based on industry only.';

    const inputDesc = data.inputType === 'url' ? 'URL: ' + data.url : 'Business search: ' + data.businessQuery;

    userMessage = 'Analyze the complete public GEO presence of this business.\n\n' +
      inputDesc + '\nIndustry: ' + data.industry + '\nSources: ' + allContent.length + '\n\n' +
      'CONTENT:\n' + contentBlock + '\n\n' +
      'Return this JSON:\n' +
      '{"score":<0-100>,"entity":"<entity statement using real details>","bizDesc":"<100-150 word AI-optimized description>",' +
      '"faqs":[{"q":"<AI query question>","a":"<specific answer>"}],' +
      '"positioning":["<statement 1>","<statement 2>","<statement 3>"],' +
      '"schemaNote":"<placement instruction — mention platform if detected>",' +
      '"listingsConsistency":"<are name/description/category consistent across all surfaces? what is inconsistent?>",' +
      '"detectedProduct":"<main product or service found>","detectedProductDesc":"<one sentence>",' +
      '"detectedCustomer":"<who it is for>","detectedPrice":"<price if found or empty string>"}\n\n' +
      'Requirements: 5 FAQ pairs, 3 positioning statements. Be specific to actual content.';
  } else {
    userMessage = 'Analyze GEO readiness for: ' + data.bizName + ' in ' + data.location + '\n' +
      'Industry: ' + data.industry + '\nDoes: ' + data.bizDesc + '\n' +
      'Platforms: ' + ((data.platforms || []).join(', ') || 'None') + '\n' +
      'Bio: ' + (data.currentBio || 'None') + '\n\n' +
      'Return JSON: {"score":<0-40>,"gbpDesc":"<750 char max GBP description>",' +
      '"gbpFaqs":[{"q":"","a":""}],"directory":"<100-150 word directory description>",' +
      '"pageHeadline":"<website headline>","pageDesc":"<2 paragraph description>",' +
      '"pageServices":"<3-4 services with descriptions>","pageFaqs":[{"q":"","a":""}]}\n\n' +
      'Requirements: 3 GBP FAQs, 3 page FAQs. Last action step: build one-page website.';
  }

  try {
    const claudeRes = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: ANT_HEADERS,
      body: JSON.stringify({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 2500,
        system,
        messages: [{ role: 'user', content: userMessage }],
      }),
    });

    const claudeData = await claudeRes.json();
    if (claudeData.error) {
      return { statusCode: 400, headers, body: JSON.stringify({ error: 'Claude API error: ' + claudeData.error.message }) };
    }

    const text = (claudeData.content || []).filter(b => b.type === 'text').map(b => b.text).join('');
    const clean = text.replace(/^```json\s*/,'').replace(/\s*```$/,'').trim();

    if (!clean || clean[0] !== '{') {
      return { statusCode: 400, headers, body: JSON.stringify({ error: 'Non-JSON response: ' + clean.slice(0, 100) }) };
    }

    const result = JSON.parse(clean);
    result.pageCount = allContent.length;
    result.listingsFound = listingsFound;

    return { statusCode: 200, headers, body: JSON.stringify({ result }) };

  } catch (err) {
    return { statusCode: 500, headers, body: JSON.stringify({ error: 'Analysis failed: ' + err.message }) };
  }
};
