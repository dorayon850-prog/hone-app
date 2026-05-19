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

  const FC_H  = { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + FC_KEY };
  const ANT_H = { 'Content-Type': 'application/json', 'x-api-key': ANT_KEY, 'anthropic-version': '2023-06-01' };

  // Timeout wrapper
  const withTimeout = (promise, ms) =>
    Promise.race([promise, new Promise(r => setTimeout(() => r(null), ms))]);

  // Scrape one page
  async function scrapePage(url) {
    try {
      const res = await withTimeout(fetch('https://api.firecrawl.dev/v2/scrape', {
        method: 'POST', headers: FC_H,
        body: JSON.stringify({ url, formats: ['markdown'] }),
      }), 6000);
      if (!res) return '';
      const d = await res.json();
      return ((d.data && d.data.markdown) ? d.data.markdown : '').slice(0, 2500);
    } catch(e) { return ''; }
  }

  // ── SMART PAGE SELECTION ──
  // Step 1: broad pattern match (fast, no API call)
  // Step 2: if not enough found, ask Claude to pick from remaining URLs
  const PRIORITY_PATTERNS = [
    // Homepage
    /^\/$/,
    // Standard page names
    /\/about/, /\/about-us/, /\/our-story/,
    // Products & services
    /\/product/, /\/products/, /\/services/, /\/service/,
    /\/store/, /\/shop/, /\/collection/, /\/collections/,
    /\/offering/, /\/offerings/, /\/work/, /\/portfolio/,
    /\/menu/, /\/catalog/, /\/catalogue/,
    // Digital specific
    /\/course/, /\/courses/, /\/program/, /\/programs/,
    /\/book/, /\/books/, /\/digital/, /\/download/,
    /\/tool/, /\/tools/, /\/resource/, /\/resources/,
    // Common business pages
    /\/pricing/, /\/price/, /\/packages/, /\/plans/,
    /\/faq/, /\/faqs/, /\/help/,
  ];

  function scoreUrl(url, baseUrl) {
    const path = url.replace(baseUrl, '').toLowerCase().split('?')[0];
    // Exact homepage
    if (path === '' || path === '/') return 0;
    // Pattern match
    for (let i = 0; i < PRIORITY_PATTERNS.length; i++) {
      if (PRIORITY_PATTERNS[i].test(path)) return i + 1;
    }
    // Deeper product/collection pages (e.g. /collections/mindset, /products/money-reset)
    if (path.split('/').length === 3 &&
        /product|collection|service|course|shop/.test(path)) return 5;
    return 999;
  }

  // Ask Claude to pick the best pages from a list when pattern matching isn't enough
  async function claudePickPages(allUrls, baseUrl, industry) {
    try {
      const urlList = allUrls.slice(0, 30).join('\n');
      const res = await withTimeout(
        fetch('https://api.anthropic.com/v1/messages', {
          method: 'POST', headers: ANT_H,
          body: JSON.stringify({
            model: 'claude-sonnet-4-20250514',
            max_tokens: 300,
            messages: [{ role: 'user', content:
              `A ${industry} business has these URLs:\n${urlList}\n\nPick the 3 most likely to contain product, service, or offering information (not homepage, not blog posts, not policy pages). Return ONLY a JSON array of the full URLs: ["url1","url2","url3"]`
            }],
          }),
        }).then(r => r.json()),
        5000
      );
      if (!res) return [];
      const text = (res.content || []).filter(b => b.type === 'text').map(b => b.text).join('');
      const match = text.match(/\[[\s\S]*\]/);
      return match ? JSON.parse(match[0]) : [];
    } catch(e) { return []; }
  }

  // Crawl website with smart page selection
  async function crawlWebsite(url, industry) {
    const pages = [];
    let selectedUrls = [url]; // always include homepage

    try {
      const mapRes = await withTimeout(fetch('https://api.firecrawl.dev/v1/map', {
        method: 'POST', headers: FC_H,
        body: JSON.stringify({ url, limit: 30 }),
      }), 5000);

      if (mapRes) {
        const mapData = await mapRes.json();
        const allUrls = (mapData.links || []).filter(u => u !== url);

        // Step 1: Pattern-based scoring
        const scored = allUrls.map(u => ({ u, score: scoreUrl(u, url) }))
          .sort((a, b) => a.score - b.score);

        const patternMatched = scored.filter(s => s.score < 999).map(s => s.u).slice(0, 3);
        const unmatched = scored.filter(s => s.score === 999).map(s => s.u);

        if (patternMatched.length >= 2) {
          // Enough pattern matches — use them
          selectedUrls = [url, ...patternMatched].slice(0, 4);
        } else {
          // Step 2: Not enough pattern matches — ask Claude to pick
          const claudePicks = unmatched.length > 0
            ? await claudePickPages(unmatched, url, industry)
            : [];
          selectedUrls = [url, ...patternMatched, ...claudePicks]
            .filter((u, i, arr) => arr.indexOf(u) === i) // dedupe
            .slice(0, 4);
        }
      }
    } catch(e) {
      // Map failed — homepage only
    }

    // Scrape selected pages in parallel
    const results = await Promise.all(
      selectedUrls.map(u => scrapePage(u).then(md => ({ url: u, content: md })))
    );
    results.forEach(r => { if (r.content) pages.push(r); });
    return pages;
  }

  // Find listings and crawl in parallel
  async function findListingsAndCrawl(url, industry) {
    const [pages, listingsResult] = await Promise.all([
      crawlWebsite(url, industry),
      withTimeout(
        fetch('https://api.anthropic.com/v1/messages', {
          method: 'POST', headers: ANT_H,
          body: JSON.stringify({
            model: 'claude-sonnet-4-20250514', max_tokens: 600,
            tools: [{ type: 'web_search_20250305', name: 'web_search' }],
            messages: [{ role: 'user',
              content: 'Find public listings for: ' +
                url.replace(/https?:\/\/(www\.)?/,'').split('/')[0] + ' ' + industry +
                '. Return ONLY JSON: {"googleBusiness":"","yelp":"","linkedin":""}. Empty string if not found.' }],
          }),
        }).then(r => r.json()),
        8000
      )
    ]);

    let listings = { googleBusiness: '', yelp: '', linkedin: '' };
    if (listingsResult) {
      try {
        const text = (listingsResult.content || []).filter(b => b.type === 'text').map(b => b.text).join('');
        const match = text.replace(/```json|```/g,'').trim().match(/\{[\s\S]*\}/);
        if (match) listings = JSON.parse(match[0]);
      } catch(e) {}
    }

    // Scrape up to 2 listings in parallel
    const listingUrls = [
      listings.googleBusiness && { source: 'GOOGLE BUSINESS PROFILE', url: listings.googleBusiness },
      listings.yelp && { source: 'YELP LISTING', url: listings.yelp },
    ].filter(Boolean).slice(0, 2);

    const listingPages = await Promise.all(
      listingUrls.map(l => scrapePage(l.url).then(md => ({ ...l, content: md })))
    );

    return { pages, listings, listingPages: listingPages.filter(l => l.content) };
  }

  // Find business by name
  async function findBusinessByName(query, industry) {
    try {
      const res = await withTimeout(
        fetch('https://api.anthropic.com/v1/messages', {
          method: 'POST', headers: ANT_H,
          body: JSON.stringify({
            model: 'claude-sonnet-4-20250514', max_tokens: 600,
            tools: [{ type: 'web_search_20250305', name: 'web_search' }],
            messages: [{ role: 'user',
              content: 'Find for: ' + query + ' ' + industry +
                '. Return ONLY JSON: {"website":"","googleBusiness":"","yelp":""}. Empty if not found.' }],
          }),
        }).then(r => r.json()),
        8000
      );
      if (!res) return { website: '', googleBusiness: '', yelp: '' };
      const text = (res.content || []).filter(b => b.type === 'text').map(b => b.text).join('');
      const match = text.replace(/```json|```/g,'').trim().match(/\{[\s\S]*\}/);
      return match ? JSON.parse(match[0]) : { website: '', googleBusiness: '', yelp: '' };
    } catch(e) { return { website: '', googleBusiness: '', yelp: '' }; }
  }

  // Read social platform
  async function readSocial(platform, url) {
    const DIRECT = ['youtube','facebook','linkedin','yelp','google','other'];
    if (DIRECT.includes(platform)) {
      const content = await scrapePage(url);
      return { source: platform.toUpperCase(), url, content };
    }
    try {
      const res = await withTimeout(
        fetch('https://api.anthropic.com/v1/messages', {
          method: 'POST', headers: ANT_H,
          body: JSON.stringify({
            model: 'claude-sonnet-4-20250514', max_tokens: 400,
            tools: [{ type: 'web_search_20250305', name: 'web_search' }],
            messages: [{ role: 'user',
              content: 'What does this ' + platform + ' page show? Business name, bio, what they sell, audience. URL: ' + url + '. Brief plain text.' }],
          }),
        }).then(r => r.json()),
        7000
      );
      if (!res) return { source: platform.toUpperCase(), url, content: '' };
      const text = (res.content || []).filter(b => b.type === 'text').map(b => b.text).join('').slice(0, 1500);
      return { source: platform.toUpperCase(), url, content: text };
    } catch(e) { return { source: platform.toUpperCase(), url, content: '' }; }
  }

  // ── GATHER CONTENT ──
  let allContent = [];
  let listingsFound = {};

  if (data.path === 'AC') {
    if (data.inputType === 'url') {
      const { pages, listings, listingPages } = await findListingsAndCrawl(data.url, data.industry);
      pages.forEach(p => allContent.push({ source: 'WEBSITE', url: p.url, content: p.content }));
      listingPages.forEach(l => allContent.push(l));
      listingsFound = listings;
    } else {
      const found = await findBusinessByName(data.businessQuery, data.industry);
      listingsFound = found;
      if (found.website) {
        const pages = await crawlWebsite(found.website, data.industry);
        pages.forEach(p => allContent.push({ source: 'WEBSITE', url: p.url, content: p.content }));
      }
      const listingUrls = [
        found.googleBusiness && { source: 'GOOGLE BUSINESS PROFILE', url: found.googleBusiness },
        found.yelp && { source: 'YELP LISTING', url: found.yelp },
      ].filter(Boolean);
      const lp = await Promise.all(listingUrls.map(l => scrapePage(l.url).then(md => ({ ...l, content: md }))));
      lp.filter(l => l.content).forEach(l => allContent.push(l));
    }

  } else if (data.path === 'B') {
    const reads = await Promise.all(
      Object.entries(data.socialLinks || {})
        .filter(([,u]) => u)
        .map(([platform, url]) => readSocial(platform, url))
    );
    reads.filter(r => r.content).forEach(r => allContent.push(r));
  }

  // ── CLAUDE ANALYSIS ──
  const system = `You are a senior GEO analyst. Produce a thorough report worth $150-250.
RULES: Return 5-7 findings minimum. Be specific to actual content found. For well-optimized sites find advanced opportunities. Return ONLY valid JSON — no markdown, no backticks.`;

  let userMessage = '';

  if (data.path === 'AC') {
    const contentBlock = allContent.length > 0
      ? allContent.map(c => '--- ' + c.source + ': ' + c.url + ' ---\n' + c.content).join('\n\n')
      : 'No content retrieved.';
    const inputDesc = data.inputType === 'url' ? 'URL: ' + data.url : 'Search: ' + data.businessQuery;

    userMessage = `Comprehensive GEO analysis.
${inputDesc}
Industry: ${data.industry}
Sources: ${allContent.length}

CONTENT:
${contentBlock}

Return this JSON:
{
  "score": <0-100: no schema=max45, basic schema=max65, full GEO=70+>,
  "aiView": "<what AI says when asked to recommend this business — specific to real content>",
  "strengths": "<2-3 specific GEO strengths found>",
  "weaknesses": "<2-3 specific gaps found>",
  "entity": "<complete entity statement: category, location, differentiator>",
  "bizDesc": "<AI-optimized 100-150 word description using actual products/services found>",
  "faqs": [{"q":"<conversational AI query>","a":"<specific answer using real details>"}],
  "positioning": ["<targets specific query>","<statement 2>","<statement 3>"],
  "schemaNote": "<SPECIFIC platform instruction — if Shopify: Online Store > Themes > Edit Code > theme.liquid. If WordPress: header.php or Yoast plugin>",
  "listingsConsistency": "<what was found and whether descriptions are consistent>",
  "detectedProduct": "<main product or service name>",
  "detectedProductDesc": "<one sentence>",
  "detectedCustomer": "<who it is for>",
  "detectedPrice": "<price if found or empty>",
  "sourcesAnalyzed": <array of source labels>
}
5 FAQs minimum. 3 positioning statements. Score honestly.`;

  } else {
    const socialBlock = allContent.length > 0
      ? '\n\nSOCIAL CONTENT:\n' + allContent.map(c => '--- ' + c.source + ' ---\n' + c.content).join('\n\n')
      : '';

    userMessage = `GEO analysis — no website.
Business: ${data.bizName}
Location: ${data.location}
Industry: ${data.industry}
Does: ${data.bizDesc}
Bio: ${data.currentBio || 'None'}${socialBlock}

Return JSON:
{
  "score": <0-40>,
  "aiView": "<what AI finds about this business>",
  "strengths": "<what works>",
  "weaknesses": "<primary gaps>",
  "gbpDesc": "<750 char GBP description>",
  "gbpFaqs": [{"q":"","a":""}],
  "directory": "<100-150 word directory description>",
  "pageHeadline": "<website headline>",
  "pageDesc": "<2 paragraphs>",
  "pageServices": "<3-4 services>",
  "pageFaqs": [{"q":"","a":""}],
  "listingsConsistency": "<what was found>"
}
3 GBP FAQs, 3 page FAQs minimum.`;
  }

  try {
    const claudeRes = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST', headers: ANT_H,
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
      return { statusCode: 400, headers, body: JSON.stringify({ error: 'Non-JSON: ' + clean.slice(0,100) }) };
    }

    const result = JSON.parse(clean);
    result.pageCount     = allContent.length;
    result.listingsFound = listingsFound;
    result.sourcesRead   = allContent.map(c => ({ source: c.source }));

    return { statusCode: 200, headers, body: JSON.stringify({ result }) };

  } catch (err) {
    return { statusCode: 500, headers, body: JSON.stringify({ error: 'Analysis failed: ' + err.message }) };
  }
};
