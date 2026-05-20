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

  const system = `You are a senior GEO analyst producing a comprehensive professional report worth $250.
CRITICAL RULES:
1. Return 6-8 findings minimum — even well-optimized sites have advanced opportunities
2. Be specific to actual content found — never generic
3. Score honestly: no schema = max 45, basic schema = max 65, full multi-surface GEO = 70+
4. Return ONLY valid JSON — no markdown, no backticks, no explanation`;

  const contentBlock = allContent.length > 0
    ? allContent.map(c => '--- ' + c.source + ': ' + (c.url || '') + ' ---\n' + (c.content || '').slice(0, 2500)).join('\n\n')
    : 'No content retrieved.';

  const competitorBlock = competitors.length > 0
    ? '\n\nCOMPETITOR CONTEXT:\n' + competitors.map(c =>
        c.name + ' (' + (c.website || '') + '): ' + (c.strength || '')
      ).join('\n')
    : '';

  const queryGapBlock = queryGaps.length > 0
    ? '\n\nQUERY GAPS TO ADDRESS:\n' + queryGaps.map((q, i) => (i+1) + '. ' + q).join('\n')
    : '';

  let userMessage;

  if (data.path === 'AC') {
    const inputDesc = data.inputType === 'url' ? 'URL: ' + data.url : 'Business: ' + data.businessQuery;

    userMessage = `Comprehensive GEO analysis.
${inputDesc}
Industry: ${data.industry}
Pages and surfaces read: ${allContent.length}
${competitorBlock}
${queryGapBlock}

FULL CONTENT:
${contentBlock}

Return this complete JSON:
{
  "score": <0-100>,
  "aiView": "<2-3 sentences: what AI currently says when asked to recommend this business — specific to real content found>",
  "strengths": "<3 specific GEO strengths found across all surfaces>",
  "weaknesses": "<3 specific gaps holding them back>",
  "entity": "<complete entity statement: category, location, differentiator, audience — use real details>",
  "bizDesc": "<120-150 word AI-optimized description using actual products and services found>",
  "faqs": [
    {"q": "<conversational AI query — how people actually ask>", "a": "<specific answer using real business details>"}
  ],
  "positioning": [
    "<statement targeting a specific high-intent AI search query>",
    "<statement 2>",
    "<statement 3>"
  ],
  "schemaNote": "<SPECIFIC platform instruction: if Shopify say Online Store > Themes > Edit Code > theme.liquid before closing head tag. If WordPress say header.php or Yoast SEO plugin. Be specific to what was detected>",
  "listingsConsistency": "<detailed observation: which surfaces were found, whether name/description/category are consistent, what specifically is inconsistent>",
  "competitorGap": "<what the top competitor has for GEO that this business is missing — be specific>",
  "queryGapAnalysis": "<which of the identified query gaps this business is best positioned to own and what content would capture them>",
  "detectedProduct": "<main product or service name>",
  "detectedProductDesc": "<one sentence>",
  "detectedCustomer": "<who it is for>",
  "detectedPrice": "<price if found or empty>",
  "sourcesAnalyzed": <array of source label strings>,
  "llmsTxtContent": "<complete ready-to-host llms.txt file content based on everything found — include business name, description, key pages, what they offer, and who they serve>",
  "schemaOrganization": "<complete Organization schema JSON-LD as a string — use real business details>",
  "schemaLocalBusiness": "<complete LocalBusiness or specific type schema JSON-LD as a string if location-based business detected>"
}

REQUIREMENTS:
- 6 FAQ pairs minimum — written as real human AI queries
- 3 positioning statements each targeting different specific queries
- competitorGap must reference what the specific competitor does that this business does not
- llmsTxtContent must be a complete usable file
- schemaOrganization must be valid JSON-LD with real business details
- Score honestly`;

  } else {
    const socialBlock = allContent.length > 0
      ? '\nSOCIAL CONTENT:\n' + contentBlock
      : '';

    userMessage = `GEO analysis — business without website.
Business: ${data.bizName}
Location: ${data.location}
Industry: ${data.industry}
Description: ${data.bizDesc}
Bio: ${data.currentBio || 'None'}${socialBlock}

Return JSON:
{
  "score": <0-40>,
  "aiView": "<what AI finds about this business right now>",
  "strengths": "<what works>",
  "weaknesses": "<primary gaps>",
  "gbpDesc": "<optimized GBP description max 750 characters — use real service details and location>",
  "gbpFaqs": [{"q": "<question>", "a": "<specific answer>"}],
  "directory": "<consistent 100-150 word description for all directories>",
  "pageHeadline": "<compelling website headline>",
  "pageDesc": "<2 paragraphs using real business details>",
  "pageServices": "<3-4 specific services with descriptions>",
  "pageFaqs": [{"q": "<question>", "a": "<answer>"}],
  "listingsConsistency": "<what was found and whether it is consistent>",
  "llmsTxtContent": "<complete llms.txt file for when they build their website>"
}
3 GBP FAQs minimum. 3 page FAQs minimum.`;
  }

  try {
    const claudeRes = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: ANT_H,
      body: JSON.stringify({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 3500,
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
