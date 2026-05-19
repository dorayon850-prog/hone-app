exports.handler = async (event) => {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Content-Type': 'application/json',
  };

  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers, body: '' };
  if (event.httpMethod !== 'POST') return { statusCode: 405, headers, body: JSON.stringify({ error: 'Method not allowed' }) };

  const ANT_KEY = process.env.ANTHROPIC_API_KEY;
  if (!ANT_KEY) return { statusCode: 500, headers, body: JSON.stringify({ error: 'API key not configured.' }) };

  let body;
  try { body = JSON.parse(event.body); }
  catch { return { statusCode: 400, headers, body: JSON.stringify({ error: 'Invalid request body' }) }; }

  const { analysisData: data, allContent = [], listingsFound = {} } = body;
  if (!data) return { statusCode: 400, headers, body: JSON.stringify({ error: 'Missing analysisData' }) };

  const ANT_H = { 'Content-Type': 'application/json', 'x-api-key': ANT_KEY, 'anthropic-version': '2023-06-01' };

  const system = `You are a senior GEO analyst. Produce a thorough report worth $150-250.
RULES: Always return 5-7 findings. Be specific to actual content. Score honestly. Return ONLY valid JSON — no markdown, no backticks.`;

  let userMessage = '';

  if (data.path === 'AC') {
    const contentBlock = allContent.length > 0
      ? allContent.map(c => '--- ' + c.source + ': ' + c.url + ' ---\n' + c.content).join('\n\n')
      : 'No content retrieved.';
    const inputDesc = data.inputType === 'url' ? 'URL: ' + data.url : 'Business: ' + data.businessQuery;

    userMessage = `Comprehensive GEO analysis.
${inputDesc}
Industry: ${data.industry}
Sources read: ${allContent.length}

CONTENT:
${contentBlock}

Return this JSON:
{
  "score": <0-100: no schema=max45, basic schema=max65, full GEO=70+>,
  "aiView": "<2-3 sentences: what AI currently says when asked to recommend this business>",
  "strengths": "<2-3 specific GEO strengths found>",
  "weaknesses": "<2-3 specific gaps>",
  "entity": "<complete entity statement: category, location, differentiator — use real details>",
  "bizDesc": "<100-150 word AI-optimized description using actual products/services found>",
  "faqs": [{"q":"<conversational AI query>","a":"<specific answer using real details>"}],
  "positioning": ["<targets specific AI query>","<statement 2>","<statement 3>"],
  "schemaNote": "<SPECIFIC platform instruction: if Shopify say Online Store > Themes > Edit Code > theme.liquid. If WordPress say header.php or Yoast plugin. If other platform be specific>",
  "listingsConsistency": "<what was found and whether information is consistent>",
  "detectedProduct": "<main product or service>",
  "detectedProductDesc": "<one sentence>",
  "detectedCustomer": "<who it is for>",
  "detectedPrice": "<price if found or empty>",
  "sourcesAnalyzed": <array of source label strings>
}
5 FAQs minimum. 3 positioning statements. Score honestly.`;

  } else {
    // Path B — social content
    const socialBlock = allContent.length > 0
      ? '\n\nSOCIAL CONTENT:\n' + allContent.map(c => '--- ' + c.source + ' ---\n' + c.content).join('\n\n')
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
  "aiView": "<what AI finds about this business>",
  "strengths": "<what works>",
  "weaknesses": "<primary gaps>",
  "gbpDesc": "<optimized GBP description max 750 characters>",
  "gbpFaqs": [{"q":"","a":""}],
  "directory": "<100-150 word directory description>",
  "pageHeadline": "<website headline>",
  "pageDesc": "<2 paragraphs>",
  "pageServices": "<3-4 services>",
  "pageFaqs": [{"q":"","a":""}],
  "listingsConsistency": "<what was found>"
}
3 GBP FAQs minimum. 3 page FAQs minimum.`;
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

  } catch(err) {
    return { statusCode: 500, headers, body: JSON.stringify({ error: 'Analysis failed: ' + err.message }) };
  }
};
