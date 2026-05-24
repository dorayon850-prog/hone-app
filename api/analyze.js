module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const ANT_KEY = process.env.ANTHROPIC_API_KEY;
  if (!ANT_KEY) return res.status(500).json({ error: 'API key not configured.' });

  const {
    analysisData: data,
    allContent   = [],
    listingsFound = {},
    competitors   = [],
    queryGaps     = [],
  } = req.body || {};

  if (!data) return res.status(400).json({ error: 'Missing analysisData' });

  const ANT_H = {
    'Content-Type': 'application/json',
    'x-api-key': ANT_KEY,
    'anthropic-version': '2023-06-01',
  };

  const system = `You are a senior GEO analyst conducting a comprehensive one-time assessment. This is the only report this business will receive so it must be complete and exhaustive — nothing can be left out.

CRITICAL RULES:
1. DETECT WHAT IS ALREADY IMPLEMENTED. Look for existing schema in script tags, structured data, entity language, consistent listings. Report what is already done accurately. Do not generate fix cards for things already correctly implemented.
2. FIND EVERYTHING THAT IS MISSING. Every schema type needed, every surface gap, every query opportunity, every listing inconsistency. This is one and done.
3. SCORE HONESTLY. A fully optimized site should score 70+. Detect schema from the crawled content — look for application/ld+json script blocks, meta tags, structured descriptions.
4. Return ONLY valid JSON — no markdown, no backticks, no explanation.`;

  const contentBlock = allContent.length > 0
    ? allContent.map(c => '--- ' + c.source + ': ' + (c.url || '') + ' ---\n' + (c.content || '').slice(0, 2500)).join('\n\n')
    : 'No content retrieved.';

  const competitorBlock = competitors.length > 0
    ? '\n\nCOMPETITOR CONTEXT:\n' + competitors.map(c => (c.name || '') + ': ' + (c.strength || '')).join('\n')
    : '';

  const queryGapBlock = queryGaps.length > 0
    ? '\n\nQUERY GAPS TO EVALUATE:\n' + queryGaps.map((q, i) => (i+1) + '. ' + q).join('\n')
    : '';

  let userMessage;

  if (data.path === 'AC') {
    const inputDesc = data.inputType === 'url' ? 'URL: ' + data.url : 'Business: ' + data.businessQuery;

    userMessage = `COMPREHENSIVE ONE-TIME GEO ASSESSMENT.
${inputDesc}
Industry: ${data.industry}
Sources read: ${allContent.length}
${competitorBlock}
${queryGapBlock}

FULL CONTENT:
${contentBlock}

DETECTION INSTRUCTIONS:
- Look for <script type="application/ld+json"> blocks — if found, note which schema types exist (FAQPage, Organization, LocalBusiness, Product, BreadcrumbList)
- Look for entity language — does the site clearly state what category it belongs to, where it operates, and who it serves?
- Look for consistent business name/description across all surfaces found
- Look for FAQ content already on the site
- Look for llms.txt signals in any of the crawled pages

This is a ONE-TIME assessment. Find and report on EVERYTHING. Nothing should be left for a follow-up.

Return this complete JSON:
{
  "score": <0-100: accurately reflects current GEO state. Existing schema and entity language must increase score. 70+ only for genuinely well-optimized sites>,
  "alreadyImplemented": ["<list every GEO element already correctly in place — e.g. faqSchema, entityStatement, organizationSchema, consistentListings, llmsTxt>"],
  "aiView": "<2-3 sentences: what AI currently says when asked to recommend this business — specific to real content found>",
  "strengths": "<3 specific GEO strengths found — reference actual content>",
  "weaknesses": "<3 specific gaps found — be precise about what is missing>",
  "entity": "<complete entity statement using real details — category, location, differentiator, audience>",
  "bizDesc": "<120-150 word AI-optimized description using actual products and services found>",
  "faqs": [{"q": "<conversational AI query>", "a": "<specific answer using real business details>"}],
  "positioning": ["<targets specific AI query>", "<statement 2>", "<statement 3>"],
  "schemaNote": "<SPECIFIC platform instruction: if Shopify detected say Online Store > Themes > Edit Code > theme.liquid before closing head tag. If WordPress say header.php or Yoast SEO plugin. Be precise>",
  "schemaOrganization": "<complete Organization schema JSON-LD string using real business details — only if not already implemented>",
  "schemaLocalBusiness": "<complete LocalBusiness or specific type schema JSON-LD string — only if location-based and not already implemented, empty string if not applicable>",
  "schemaProduct": "<complete Product schema JSON-LD string for main product if e-commerce detected and not already implemented, empty string if not applicable>",
  "listingsConsistency": "<detailed observation: which surfaces were found, whether name/description/category match exactly, what specifically differs>",
  "listingsGaps": ["<specific listing or directory missing that matters for this industry>"],
  "competitorGap": "<what the top competitor has for GEO that this business is missing — be specific, reference the competitor by name>",
  "queryGapAnalysis": "<which identified query gaps this business can own and what content would capture each one>",
  "llmsTxtContent": "<complete ready-to-host llms.txt file content built from everything found — include business name, entity statement, key pages, services, and audience>",
  "detectedProduct": "<main product or service name>",
  "detectedProductDesc": "<one sentence>",
  "detectedCustomer": "<who it is for>",
  "detectedPrice": "<price if found or empty>",
  "sourcesAnalyzed": <array of source label strings>,
  "completenessNote": "<honest statement about how comprehensive this assessment is — if no website content was retrieved, say so clearly>"
}

REQUIREMENTS:
- alreadyImplemented MUST accurately reflect what is already done — empty array only if nothing GEO-related exists
- 6 FAQ pairs minimum — written as real human conversational AI queries
- 3 positioning statements each targeting different specific queries
- schemaOrganization, schemaLocalBusiness, schemaProduct — generate these for missing schema types only
- llmsTxtContent must be a complete usable file
- competitorGap must name the competitor and be specific
- Score must reflect actual detected state — if schema is present, score accordingly`;

  } else {
    const socialBlock = allContent.length > 0
      ? '\nSOCIAL CONTENT:\n' + contentBlock
      : '';

    userMessage = `COMPREHENSIVE ONE-TIME GEO ASSESSMENT — no website.
Business: ${data.bizName}
Location: ${data.location}
Industry: ${data.industry}
Description: ${data.bizDesc}
Bio: ${data.currentBio || 'None'}${socialBlock}

This is a ONE-TIME assessment. Find and address everything.

Return this complete JSON:
{
  "score": <0-40: no website means ceiling regardless of listing quality>,
  "alreadyImplemented": ["<list any GEO elements already correctly in place across their existing platforms>"],
  "aiView": "<what AI currently finds when asked to recommend this business>",
  "strengths": "<what is working in their favor>",
  "weaknesses": "<primary gaps — be exhaustive>",
  "gbpDesc": "<optimized Google Business Profile description max 750 characters — use real service details and location>",
  "gbpFaqs": [{"q": "<question>", "a": "<specific answer using real details>"}],
  "gbpCategories": "<recommended primary and secondary Google Business Profile categories for this industry>",
  "directory": "<consistent 100-150 word description for all directories>",
  "directoryList": ["<specific directories that matter most for this industry>"],
  "pageHeadline": "<compelling website headline>",
  "pageDesc": "<2 paragraphs using real business details>",
  "pageServices": "<3-4 specific services with descriptions>",
  "pageFaqs": [{"q": "<question>", "a": "<answer>"}],
  "listingsConsistency": "<what was found and whether it is consistent>",
  "llmsTxtContent": "<complete llms.txt file for when they build their website>",
  "completenessNote": "<honest statement about the assessment — note if limited by lack of public content>"
}
3 GBP FAQs minimum. 3 page FAQs minimum. gbpCategories is required.`;
  }

  try {
    const claudeRes = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: ANT_H,
      body: JSON.stringify({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 4000,
        system,
        messages: [{ role: 'user', content: userMessage }],
      }),
    });

    const claudeData = await claudeRes.json();
    if (claudeData.error) {
      return res.status(400).json({ error: 'Claude error: ' + claudeData.error.message });
    }

    const text = (claudeData.content || [])
      .filter(b => b.type === 'text')
      .map(b => b.text)
      .join('');

    const clean = text.replace(/^```json\s*/,'').replace(/\s*```$/,'').trim();

    if (!clean || clean[0] !== '{') {
      return res.status(400).json({ error: 'Non-JSON response: ' + clean.slice(0, 100) });
    }

    const result = JSON.parse(clean);
    result.pageCount     = allContent.length;
    result.listingsFound = listingsFound;
    result.competitors   = competitors;
    result.queryGaps     = queryGaps;
    result.sourcesRead   = allContent.map(c => ({ source: c.source }));

    return res.status(200).json({ result });

  } catch(err) {
    return res.status(500).json({ error: 'Analysis failed: ' + err.message });
  }
};

module.exports.config = { maxDuration: 55 };
