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

  // ── Scrape a URL with Firecrawl ──
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

  // ── Use Claude web search to read a social page ──
  async function readViaClaude(url, platform) {
    try {
      const res = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: ANT_HEADERS,
        body: JSON.stringify({
          model: 'claude-sonnet-4-20250514',
          max_tokens: 600,
          tools: [{ type: 'web_search_20250305', name: 'web_search' }],
          messages: [{
            role: 'user',
            content: 'Visit this ' + platform + ' page and tell me: the business name, bio/description, what they sell or offer, who their audience is, and any key details visible. URL: ' + url + '. Return only the plain text of what you find — no commentary.'
          }],
        }),
      });
      const d = await res.json();
      const text = (d.content || []).filter(b => b.type === 'text').map(b => b.text).join('');
      return text.slice(0, 2000);
    } catch(e) { return ''; }
  }

  // ── Platforms readable directly via Firecrawl ──
  const DIRECT_PLATFORMS = ['youtube', 'facebook', 'linkedin', 'yelp', 'google', 'other'];
  // ── Platforms that need web search (login-walled) ──
  const SEARCH_PLATFORMS = ['instagram', 'tiktok'];

  // ── Read a social link based on platform ──
  async function readSocialLink(platform, url) {
    if (DIRECT_PLATFORMS.includes(platform)) {
      const md = await scrapePage(url);
      return { platform, url, content: md, method: 'direct' };
    } else {
      const text = await readViaClaude(url, platform);
      return { platform, url, content: text, method: 'search' };
    }
  }

  // ── Find listings via web search ──
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
            content: 'Find these for: ' + query + '. Return ONLY JSON: {"website":"","googleBusiness":"","yelp":"","linkedin":""}. Use empty string if not found.'
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

  // ── Crawl website ──
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

  // ════════════════════════════════════════
  // PATH AC — Website URL or Business Name
  // ════════════════════════════════════════
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

  // ════════════════════════════════════════
  // PATH B — Manual + Social Links
  // ════════════════════════════════════════
  } else if (data.path === 'B') {
    const socialLinks = data.socialLinks || {};
    const linkEntries = Object.entries(socialLinks).filter(([, url]) => url);

    if (linkEntries.length > 0) {
      // Read all social links in parallel
      const reads = await Promise.allSettled(
        linkEntries.map(([platform, url]) => readSocialLink(platform, url))
      );
      reads.forEach(r => {
        if (r.status === 'fulfilled' && r.value.content) {
          allContent.push({
            source: r.value.platform.toUpperCase(),
            url: r.value.url,
            content: r.value.content,
            method: r.value.method,
          });
        }
      });
    }
  }

  // ════════════════════════════════════════
  // CLAUDE ANALYSIS
  // ════════════════════════════════════════
  const system = 'You are a GEO expert helping small businesses become visible to AI recommendation systems. Return ONLY valid JSON with no markdown, no backticks, no explanation.';
  let userMessage = '';

  if (data.path === 'AC') {
    const contentBlock = allContent.length > 0
      ? allContent.map(c => '--- ' + c.source + ': ' + c.url + ' ---\n' + c.content).join('\n\n')
      : 'No content retrieved.';
    const inputDesc = data.inputType === 'url' ? 'URL: ' + data.url : 'Business search: ' + data.businessQuery;

    userMessage = 'Analyze GEO presence.\n\n' + inputDesc + '\nIndustry: ' + data.industry + '\n\nCONTENT:\n' + contentBlock + '\n\n' +
      'Return JSON:\n{"score":<0-100>,"entity":"<entity statement>","bizDesc":"<100-150 word description>",' +
      '"faqs":[{"q":"<AI query>","a":"<answer>"}],"positioning":["<1>","<2>","<3>"],' +
      '"schemaNote":"<placement instruction>","listingsConsistency":"<consistency across surfaces>",' +
      '"detectedProduct":"<product>","detectedProductDesc":"<one sentence>","detectedCustomer":"<who>","detectedPrice":"<price or empty>"}\n\n' +
      '5 FAQs, 3 positioning statements. Be specific to real content found.';

  } else {
    // Path B — include social content if found
    const socialBlock = allContent.length > 0
      ? '\n\nSOCIAL CONTENT RETRIEVED:\n' + allContent.map(c => '--- ' + c.source + ' ---\n' + c.content).join('\n\n')
      : '';

    userMessage = 'Analyze GEO readiness.\n\n' +
      'Business: ' + data.bizName + '\nLocation: ' + data.location + '\nIndustry: ' + data.industry + '\n' +
      'Does: ' + data.bizDesc + '\nBio: ' + (data.currentBio || 'None') +
      socialBlock + '\n\n' +
      'Return JSON:\n{"score":<0-40>,' +
      '"gbpDesc":"<750 char max GBP description using real details from social content if available>",' +
      '"gbpFaqs":[{"q":"","a":""}],' +
      '"directory":"<100-150 word directory description>",' +
      '"pageHeadline":"<website headline>",' +
      '"pageDesc":"<2 paragraphs>",' +
      '"pageServices":"<3-4 services>",' +
      '"pageFaqs":[{"q":"","a":""}]}\n\n' +
      '3 GBP FAQs, 3 page FAQs. Use real details from social content where available.';
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
    result.sourcesRead = allContent.map(c => ({ source: c.source, method: c.method || 'direct' }));

    return { statusCode: 200, headers, body: JSON.stringify({ result }) };

  } catch (err) {
    return { statusCode: 500, headers, body: JSON.stringify({ error: 'Analysis failed: ' + err.message }) };
  }
};
