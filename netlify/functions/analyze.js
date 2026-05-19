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

  const FC_HEADERS = { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + FC_KEY };
  const ANT_HEADERS = { 'Content-Type': 'application/json', 'x-api-key': ANT_KEY, 'anthropic-version': '2023-06-01' };

  async function scrapePage(url) {
    try {
      const res = await fetch('https://api.firecrawl.dev/v2/scrape', {
        method: 'POST', headers: FC_HEADERS,
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
        method: 'POST', headers: ANT_HEADERS,
        body: JSON.stringify({
          model: 'claude-sonnet-4-20250514', max_tokens: 800,
          tools: [{ type: 'web_search_20250305', name: 'web_search' }],
          messages: [{ role: 'user', content: 'Find these for: ' + query + '. Return ONLY JSON: {"website":"","googleBusiness":"","yelp":"","linkedin":""}. Use empty string if not found.' }],
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
        method: 'POST', headers: FC_HEADERS,
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

  async function readViaClaude(url, platform) {
    try {
      const res = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST', headers: ANT_HEADERS,
        body: JSON.stringify({
          model: 'claude-sonnet-4-20250514', max_tokens: 600,
          tools: [{ type: 'web_search_20250305', name: 'web_search' }],
          messages: [{ role: 'user', content: 'Visit this ' + platform + ' page and extract: business name, bio/description, what they sell, who their audience is, and any contact info. URL: ' + url + '. Return plain text only.' }],
        }),
      });
      const d = await res.json();
      return (d.content || []).filter(b => b.type === 'text').map(b => b.text).join('').slice(0, 2000);
    } catch(e) { return ''; }
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
      listingSources.filter(s => listingsFound[s.key]).map(async s => {
        const md = await scrapePage(listingsFound[s.key]);
        if (md) allContent.push({ source: s.label, url: listingsFound[s.key], content: md });
      })
    );

  } else if (data.path === 'B') {
    const socialLinks = data.socialLinks || {};
    const DIRECT_PLATFORMS = ['youtube', 'facebook', 'linkedin', 'yelp', 'google', 'other'];
    const SEARCH_PLATFORMS = ['instagram', 'tiktok'];

    await Promise.allSettled(
      Object.entries(socialLinks).filter(([,url]) => url).map(async ([platform, url]) => {
        let content = '';
        if (DIRECT_PLATFORMS.includes(platform)) {
          content = await scrapePage(url);
        } else {
          content = await readViaClaude(url, platform);
        }
        if (content) allContent.push({ source: platform.toUpperCase(), url, content });
      })
    );
  }

  const system = `You are a senior GEO (Generative Engine Optimization) analyst. Your job is to produce a thorough, specific, valuable report that justifies a $150-250 professional fee.

CRITICAL RULES:
1. Always return AT LEAST 6-8 findings even for well-optimized sites. Advanced sites have advanced opportunities.
2. Be specific to the actual content found -- never generic.
3. For well-optimized sites: identify competitive differentiation gaps, query-specific opportunities, and advanced schema types they are missing.
4. Always find something actionable in: entity clarity, FAQ coverage, positioning specificity, schema completeness, listings consistency, and content gaps.
5. Return ONLY valid JSON with no markdown, no backticks, no explanation.`;

  let userMessage = '';

  if (data.path === 'AC') {
    const contentBlock = allContent.length > 0
      ? allContent.map(c => '--- ' + c.source + ': ' + c.url + ' ---\n' + c.content).join('\n\n')
      : 'No content retrieved. Analyze based on industry only and note content could not be retrieved.';

    const inputDesc = data.inputType === 'url' ? 'URL: ' + data.url : 'Business search: ' + data.businessQuery;

    userMessage = `Analyze this business for GEO readiness. Produce a comprehensive professional report.

${inputDesc}
Industry: ${data.industry}
Sources found: ${allContent.length}

ALL RETRIEVED CONTENT:
${contentBlock}

Produce a THOROUGH analysis. Even well-optimized sites have GEO opportunities in:
- Missing schema types (Product, LocalBusiness, Organization, BreadcrumbList)
- FAQ coverage gaps (queries they should rank for but don't have answers to)
- Entity disambiguation (are they clearly differentiated from competitors?)
- Listing consistency (do all surfaces use identical language?)
- Content-query mismatch (do they have content matching how people actually ask AI?)
- Missing llms.txt
- Social proof signals AI systems can read

Return this exact JSON:
{
  "score": <0-100: be honest, most sites score 25-60, only truly exceptional GEO earns 70+>,
  "aiView": "<2-3 sentences: what an AI system ACTUALLY says when asked to recommend this type of business -- based on real content found. If content is thin, say so honestly>",
  "strengths": "<2-3 sentences: specific things working in their favor for GEO -- be precise>",
  "weaknesses": "<2-3 sentences: the most important gaps holding them back -- be specific>",
  "entity": "<complete entity statement using real business details: 1 paragraph>",
  "bizDesc": "<AI-optimized business description 100-150 words using actual products/services found>",
  "faqs": [
    {"q": "<conversational question people ask AI when looking for this business>", "a": "<specific answer using real details>"}
  ],
  "positioning": ["<statement targeting a specific high-intent AI query>", "<statement 2>", "<statement 3>"],
  "schemaNote": "<SPECIFIC platform instruction -- if Shopify detected say exactly where in Shopify. If WordPress say exactly where. Be specific>",
  "listingsConsistency": "<specific observation: what is consistent and what is inconsistent across the surfaces found>",
  "detectedProduct": "<main product or service name>",
  "detectedProductDesc": "<what it does in one sentence>",
  "detectedCustomer": "<who it is for>",
  "detectedPrice": "<price if found, empty string if not>",
  "sourcesAnalyzed": <array of source labels found>
}

REQUIREMENTS:
- 5 FAQ pairs minimum -- write questions the way people ACTUALLY ask AI tools
- 3 positioning statements -- each must target a different specific query
- Score honestly: if the site has decent copy but no schema, that is a 35-45
- The entity statement must be specific enough that an AI system reading it would immediately know the category, location, and differentiator`;

  } else {
    const socialBlock = allContent.length > 0
      ? '\n\nSOCIAL CONTENT:\n' + allContent.map(c => '--- ' + c.source + ' ---\n' + c.content).join('\n\n')
      : '';

    userMessage = `Analyze GEO readiness for a business without a website.

Business: ${data.bizName}
Location: ${data.location}
Industry: ${data.industry}
Description: ${data.bizDesc}
Bio: ${data.currentBio || 'None'}${socialBlock}

Return this exact JSON -- use real details from social content where available:
{
  "score": <0-40: no website means automatic ceiling>,
  "aiView": "<what AI says when asked to recommend this business -- likely nothing specific if they have no website>",
  "strengths": "<what is working in their favor>",
  "weaknesses": "<primary gaps>",
  "gbpDesc": "<optimized Google Business Profile description max 750 characters -- use real service details>",
  "gbpFaqs": [{"q": "<question>", "a": "<specific answer>"}],
  "directory": "<100-150 word description for all directories>",
  "pageHeadline": "<compelling website headline>",
  "pageDesc": "<2 paragraphs>",
  "pageServices": "<3-4 specific services with descriptions>",
  "pageFaqs": [{"q": "<question>", "a": "<answer>"}],
  "listingsConsistency": "<what was found across platforms and whether it is consistent>"
}

3 GBP FAQs, 3 page FAQs minimum.`;
  }

  try {
    const claudeRes = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST', headers: ANT_HEADERS,
      body: JSON.stringify({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 3000,
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
      return { statusCode: 400, headers, body: JSON.stringify({ error: 'Non-JSON response: ' + clean.slice(0,100) }) };
    }

    const result = JSON.parse(clean);
    result.pageCount    = allContent.length;
    result.listingsFound = listingsFound;
    result.sourcesRead  = allContent.map(c => ({ source: c.source }));

    return { statusCode: 200, headers, body: JSON.stringify({ result }) };

  } catch (err) {
    return { statusCode: 500, headers, body: JSON.stringify({ error: 'Analysis failed: ' + err.message }) };
  }
};
