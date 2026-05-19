const FC_H = (key) => ({
  'Content-Type': 'application/json',
  'Authorization': 'Bearer ' + key,
});

const ANT_H = (key) => ({
  'Content-Type': 'application/json',
  'x-api-key': key,
  'anthropic-version': '2023-06-01',
});

const withTimeout = (p, ms) =>
  Promise.race([p, new Promise(r => setTimeout(() => r(null), ms))]);

async function scrapePage(pageUrl, fcKey) {
  try {
    const r = await withTimeout(
      fetch('https://api.firecrawl.dev/v2/scrape', {
        method: 'POST',
        headers: FC_H(fcKey),
        body: JSON.stringify({ url: pageUrl, formats: ['markdown'] }),
      }), 6000
    );
    if (!r) return '';
    const d = await r.json();
    return ((d.data && d.data.markdown) || '').slice(0, 3000);
  } catch(e) { return ''; }
}

function scoreUrl(u, base) {
  const path = u.replace(base, '').toLowerCase().split('?')[0];
  if (path === '' || path === '/') return 0;
  const HIGH = [/\/product/, /\/collection/, /\/service/, /\/shop/, /\/store/,
                /\/course/, /\/program/, /\/offering/, /\/menu/, /\/work/,
                /\/portfolio/, /\/digital/, /\/book/, /\/tool/, /\/resource/,
                /\/pricing/, /\/package/, /\/plan/];
  const MED  = [/\/about/, /\/about-us/, /\/faq/, /\/help/];
  for (let i = 0; i < HIGH.length; i++) if (HIGH[i].test(path)) return i + 1;
  for (let i = 0; i < MED.length; i++)  if (MED[i].test(path))  return 50 + i;
  const parts = path.split('/').filter(Boolean);
  if (parts.length === 2 && HIGH.some(p => p.test('/' + parts[0]))) return 5;
  return 999;
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

  let siteUrl     = url || '';
  let allContent  = [];
  let listingsFound = {};

  if (inputType === 'name' && businessQuery) {
    try {
      const r = await withTimeout(
        fetch('https://api.anthropic.com/v1/messages', {
          method: 'POST',
          headers: ANT_H(ANT_KEY),
          body: JSON.stringify({
            model: 'claude-sonnet-4-20250514', max_tokens: 400,
            tools: [{ type: 'web_search_20250305', name: 'web_search' }],
            messages: [{ role: 'user',
              content: 'Find website and listings for: ' + businessQuery + ' ' + industry +
                '. Return ONLY JSON: {"website":"","googleBusiness":"","yelp":""}. Empty if not found.' }],
          }),
        }).then(x => x.json()), 9000
      );
      if (r) {
        const text = (r.content || []).filter(b => b.type === 'text').map(b => b.text).join('');
        const match = text.replace(/```json|```/g,'').trim().match(/\{[\s\S]*?\}/);
        if (match) {
          const found = JSON.parse(match[0]);
          siteUrl = found.website || '';
          listingsFound = found;
        }
      }
    } catch(e) {}
  }

  if (siteUrl) {
    let allUrls = [];
    try {
      const mapRes = await withTimeout(
        fetch('https://api.firecrawl.dev/v1/map', {
          method: 'POST',
          headers: FC_H(FC_KEY),
          body: JSON.stringify({ url: siteUrl, limit: 50 }),
        }), 9000
      );
      if (mapRes) {
        const mapData = await mapRes.json();
        allUrls = mapData.links || [];
      }
    } catch(e) {}

    const base = siteUrl.replace(/\/$/, '');
    const scored = allUrls
      .filter(u => u.startsWith(base))
      .map(u => ({ u, score: scoreUrl(u, base) }))
      .sort((a, b) => a.score - b.score);

    const toScrape = [siteUrl];
    for (const s of scored) {
      if (s.u !== siteUrl && toScrape.length < 5) toScrape.push(s.u);
    }

    const [scraped, listingsResult] = await Promise.all([
      Promise.all(toScrape.map(u => scrapePage(u, FC_KEY).then(md => ({ url: u, content: md })))),
      inputType === 'url' ? withTimeout(
        fetch('https://api.anthropic.com/v1/messages', {
          method: 'POST',
          headers: ANT_H(ANT_KEY),
          body: JSON.stringify({
            model: 'claude-sonnet-4-20250514', max_tokens: 400,
            tools: [{ type: 'web_search_20250305', name: 'web_search' }],
            messages: [{ role: 'user',
              content: 'Find Google Business Profile and Yelp for: ' +
                siteUrl.replace(/https?:\/\/(www\.)?/,'').split('/')[0] + ' ' + industry +
                '. Return ONLY JSON: {"googleBusiness":"","yelp":""}. Empty if not found.' }],
          }),
        }).then(x => x.json()), 9000
      ) : Promise.resolve(null),
    ]);

    scraped.filter(p => p.content).forEach(p =>
      allContent.push({ source: 'WEBSITE', url: p.url, content: p.content })
    );

    if (listingsResult) {
      try {
        const text = (listingsResult.content || []).filter(b => b.type === 'text').map(b => b.text).join('');
        const match = text.replace(/```json|```/g,'').trim().match(/\{[\s\S]*?\}/);
        if (match) listingsFound = Object.assign(listingsFound, JSON.parse(match[0]));
      } catch(e) {}
    }

    const listingTargets = [
      listingsFound.googleBusiness && { source: 'GOOGLE BUSINESS PROFILE', url: listingsFound.googleBusiness },
      listingsFound.yelp && { source: 'YELP LISTING', url: listingsFound.yelp },
    ].filter(Boolean);

    if (listingTargets.length > 0) {
      const lScraped = await Promise.all(
        listingTargets.map(l => scrapePage(l.url, FC_KEY).then(md => ({ ...l, content: md })))
      );
      lScraped.filter(l => l.content).forEach(l => allContent.push(l));
    }
  }

  return res.status(200).json({ allContent, listingsFound, siteUrl, pageCount: allContent.length });
};

module.exports.config = { maxDuration: 55 };
