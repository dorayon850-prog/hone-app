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

  const ANT_H = {
    'Content-Type': 'application/json',
    'x-api-key': ANT_KEY,
    'anthropic-version': '2023-06-01',
  };

  // Trim content to keep prompt small and Claude fast
  const trimmed = allContent.map(c => ({
    source: c.source,
    url: c.url,
    content: (c.content || '').slice(0, 1500),
  }));

  const contentBlock = trimmed.length > 0
    ? trimmed.map(c => '--- ' + c.source + ' ---\n' + c.content).join('\n\n')
    : 'No content retrieved.';

  const inputDesc = data.path === 'AC'
    ? (data.inputType === 'url' ? data.url : data.businessQuery)
    : data.bizName;

  const userMessage = data.path === 'AC'
    ? `GEO analysis for: ${inputDesc} (${data.industry})

CONTENT (${trimmed.length} sources):
${contentBlock}

Return ONLY this JSON (no markdown, no backticks):
{"score":<0-100>,"aiView":"<what AI says about this business>","strengths":"<2 strengths>","weaknesses":"<2 gaps>","entity":"<entity statement>","bizDesc":"<120 word description>","faqs":[{"q":"<query>","a":"<answer>"},{"q":"<query>","a":"<answer>"},{"q":"<query>","a":"<answer>"},{"q":"<query>","a":"<answer>"},{"q":"<query>","a":"<answer>"}],"positioning":["<statement 1>","<statement 2>","<statement 3>"],"schemaNote":"<platform-specific instruction>","listingsConsistency":"<consistency observation>","detectedProduct":"<product name>","detectedProductDesc":"<one sentence>","detectedCustomer":"<who>","detectedPrice":"<price or empty>","sourcesAnalyzed":<array of source names>}`

    : `GEO analysis for: ${data.bizName}, ${data.location} (${data.industry})
Description: ${data.bizDesc}
Social content: ${contentBlock}

Return ONLY this JSON (no markdown, no backticks):
{"score":<0-40>,"aiView":"<what AI finds>","strengths":"<what works>","weaknesses":"<gaps>","gbpDesc":"<GBP description max 750 chars>","gbpFaqs":[{"q":"","a":""},{"q":"","a":""},{"q":"","a":""}],"directory":"<directory description>","pageHeadline":"<headline>","pageDesc":"<2 paragraphs>","pageServices":"<services>","pageFaqs":[{"q":"","a":""},{"q":"","a":""},{"q":"","a":""}],"listingsConsistency":"<observation>"}`;

  try {
    // 8 second timeout on Claude call — fail fast rather than hang
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 8000);

    const claudeRes = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: ANT_H,
      signal: controller.signal,
      body: JSON.stringify({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 1500,
        messages: [{ role: 'user', content: userMessage }],
      }),
    });

    clearTimeout(timer);

    const claudeData = await claudeRes.json();

    if (claudeData.error) {
      return { statusCode: 400, headers, body: JSON.stringify({ error: 'Claude error: ' + claudeData.error.message }) };
    }

    const text = (claudeData.content || [])
      .filter(b => b.type === 'text')
      .map(b => b.text)
      .join('');

    const clean = text.replace(/^```json\s*/,'').replace(/\s*```$/,'').trim();

    if (!clean || clean[0] !== '{') {
      return { statusCode: 400, headers, body: JSON.stringify({ error: 'Non-JSON response: ' + clean.slice(0,80) }) };
    }

    const result = JSON.parse(clean);
    result.pageCount     = trimmed.length;
    result.listingsFound = listingsFound;
    result.sourcesRead   = trimmed.map(c => ({ source: c.source }));

    return { statusCode: 200, headers, body: JSON.stringify({ result }) };

  } catch(err) {
    const msg = err.name === 'AbortError'
      ? 'Claude took too long. Please try again.'
      : 'Analysis failed: ' + err.message;
    return { statusCode: 500, headers, body: JSON.stringify({ error: msg }) };
  }
};
