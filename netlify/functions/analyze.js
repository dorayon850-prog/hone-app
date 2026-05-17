exports.handler = async (event) => {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Content-Type': 'application/json',
  };

  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers, body: '' };
  }

  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  const FC_KEY  = process.env.FIRECRAWL_API_KEY;
  const ANT_KEY = process.env.ANTHROPIC_API_KEY;

  if (!FC_KEY || !ANT_KEY) {
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ error: 'API keys not configured. Add FIRECRAWL_API_KEY and ANTHROPIC_API_KEY to Netlify environment variables.' }),
    };
  }

  let body;
  try { body = JSON.parse(event.body); }
  catch { return { statusCode: 400, headers, body: JSON.stringify({ error: 'Invalid request body' }) }; }

  const { analysisData } = body;
  if (!analysisData) {
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'Missing analysisData' }) };
  }

  const isPathA = analysisData.path === 'A';
  let crawledPages = [];

  // ── STEP 1: FIRECRAWL (Path A only) ──
  if (isPathA) {
    const FC_HEADERS = {
      'Content-Type': 'application/json',
      'Authorization': 'Bearer ' + FC_KEY,
    };

    try {
      // Map the site to discover URLs
      const mapRes = await fetch('https://api.firecrawl.dev/v1/map', {
        method: 'POST',
        headers: FC_HEADERS,
        body: JSON.stringify({ url: analysisData.url, limit: 20 }),
      });
      const mapData = await mapRes.json();
      const allUrls = (mapData.links || []).slice(0, 20);

      // Prioritize key pages
      const priority = ['/', '/about', '/products', '/services', '/collection', '/shop'];
      const scored = allUrls.map(u => {
        const path = u.replace(analysisData.url, '').toLowerCase();
        const score = priority.findIndex(p => path.includes(p));
        return { u, score: score === -1 ? 99 : score };
      }).sort((a, b) => a.score - b.score);

      const toScrape = [analysisData.url, ...scored.map(s => s.u).filter(u2 => u2 !== analysisData.url)].slice(0, 5);

      // Scrape pages in parallel
      const scrapeResults = await Promise.allSettled(
        toScrape.map(pageUrl =>
          fetch('https://api.firecrawl.dev/v2/scrape', {
            method: 'POST',
            headers: FC_HEADERS,
            body: JSON.stringify({ url: pageUrl, formats: ['markdown'] }),
          }).then(r => r.json())
        )
      );

      scrapeResults.forEach((result, i) => {
        if (result.status === 'fulfilled' && result.value.data && result.value.data.markdown) {
          crawledPages.push({
            url: toScrape[i],
            content: result.value.data.markdown.slice(0, 3000),
          });
        }
      });

    } catch (err) {
      // Map failed -- try homepage only
      try {
        const scrapeRes = await fetch('https://api.firecrawl.dev/v2/scrape', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + FC_KEY },
          body: JSON.stringify({ url: analysisData.url, formats: ['markdown'] }),
        });
        const scrapeData = await scrapeRes.json();
        if (scrapeData.data && scrapeData.data.markdown) {
          crawledPages.push({ url: analysisData.url, content: scrapeData.data.markdown.slice(0, 5000) });
        }
      } catch(e2) { /* homepage also failed */ }
    }
  }

  // ── STEP 2: CLAUDE ANALYSIS ──
  const system = 'You are a GEO (Generative Engine Optimization) expert helping small businesses become visible to AI recommendation systems like ChatGPT, Perplexity, and Google AI Overviews. Return ONLY valid JSON with no markdown, no backticks, no explanation.';

  let userMessage = '';

  if (isPathA) {
    const siteContent = crawledPages.length > 0
      ? crawledPages.map(p => '--- PAGE: ' + p.url + ' ---\n' + p.content).join('\n\n')
      : 'No content could be retrieved from this website.';

    userMessage = `Analyze the GEO readiness of this website for AI recommendations.

URL: ${analysisData.url}
Industry: ${analysisData.industry}
Pages crawled: ${crawledPages.length}

ACTUAL SITE CONTENT:
${siteContent}

Return this exact JSON — no markdown, no backticks:
{
  "score": <0-100>,
  "entity": "<1 paragraph entity statement: exactly what this business is, its category, location, key differentiator — use real details from the content>",
  "bizDesc": "<AI-optimized business description 100-150 words using actual products and services found>",
  "faqs": [
    {"q": "<conversational question someone asks ChatGPT when looking for this business>", "a": "<specific answer using real business details>"}
  ],
  "positioning": ["<statement 1>", "<statement 2>", "<statement 3>"],
  "schemaNote": "<specific placement instruction — mention Shopify if Shopify detected, WordPress if WordPress>",
  "detectedProduct": "<main product or service name found in content>",
  "detectedProductDesc": "<what it does in one sentence>",
  "detectedCustomer": "<who it is for based on actual content>",
  "detectedPrice": "<price if found, empty string if not>"
}

Requirements: 5 FAQ pairs, 3 positioning statements. All content must be specific to actual site content — not generic.`;

  } else {
    userMessage = `Analyze the GEO readiness of this business for AI recommendations.

Business Name: ${analysisData.bizName}
Location: ${analysisData.location}
Industry: ${analysisData.industry}
What They Do: ${analysisData.bizDesc}
Current Platforms: ${(analysisData.platforms || []).join(', ') || 'None specified'}
Current Bio: ${analysisData.currentBio || 'None provided'}

Return this exact JSON — no markdown, no backticks:
{
  "score": <0-40>,
  "gbpDesc": "<optimized Google Business Profile description max 750 characters — include city, services, compelling reason to choose them>",
  "gbpFaqs": [
    {"q": "<question>", "a": "<answer using their specific details>"}
  ],
  "directory": "<consistent 100-150 word description for all directory listings>",
  "pageHeadline": "<compelling headline for their one-page website>",
  "pageDesc": "<2-paragraph business description for one-page site>",
  "pageServices": "<services section listing main 3-4 services with brief descriptions>",
  "pageFaqs": [
    {"q": "<question>", "a": "<answer>"}
  ]
}

Requirements: 3 GBP FAQ pairs, 3 page FAQ pairs. Be specific to their business name, location, and services.`;
  }

  try {
    const claudeRes = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': ANT_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 2500,
        system,
        messages: [{ role: 'user', content: userMessage }],
      }),
    });

    const claudeData = await claudeRes.json();

    if (claudeData.error) {
      return {
        statusCode: 400,
        headers,
        body: JSON.stringify({ error: 'Claude API error: ' + claudeData.error.message }),
      };
    }

    const text = (claudeData.content || [])
      .filter(b => b.type === 'text')
      .map(b => b.text)
      .join('');

    const clean = text.replace(/^```json\s*/,'').replace(/\s*```$/,'').trim();

    if (!clean || clean[0] !== '{') {
      return {
        statusCode: 400,
        headers,
        body: JSON.stringify({ error: 'Claude returned non-JSON: ' + clean.slice(0, 100) }),
      };
    }

    const result = JSON.parse(clean);
    result.pageCount = crawledPages.length;

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({ result }),
    };

  } catch (err) {
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ error: 'Analysis failed: ' + err.message }),
    };
  }
};
