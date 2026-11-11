// Temp mail proxy: mail.tm first, mail.gw as backup (same API).
const PROVIDERS = ['https://api.mail.tm', 'https://api.mail.gw'];
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function f(url, opt = {}, ms = 9000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  try { return await fetch(url, { ...opt, signal: ctrl.signal }); }
  finally { clearTimeout(t); }
}
const jsonOpt = (method, body, auth) => ({
  method,
  headers: { 'Content-Type': 'application/json', ...(auth ? { Authorization: auth } : {}) },
  body: body === undefined ? undefined : JSON.stringify(body)
});
const rnd = n => Math.random().toString(36).substring(2, 2 + n);

async function createOn(base, customPrefix) {
  const dr = await f(base + '/domains');
  if (!dr.ok) return null;
  const dd = await dr.json();
  const list = (Array.isArray(dd) ? dd : dd['hydra:member'] || [])
    .filter(d => d && d.domain && d.isActive !== false && d.isPrivate !== true);
  if (!list.length) return null;

  for (let attempt = 0; attempt < 5; attempt++) {
    let username = (attempt === 0 && customPrefix) ? customPrefix : 'u' + rnd(10);
    username = username.toLowerCase().replace(/[^a-z0-9]/g, '') || 'u' + rnd(10);
    const domain = list[attempt % list.length].domain;
    const address = username + '@' + domain;
    const password = rnd(8) + 'Aa1!' + rnd(4);

    const ar = await f(base + '/accounts', jsonOpt('POST', { address, password }));
    if (ar.status === 429) { await sleep(1200); continue; }
    if (!ar.ok) continue;

    let tr = await f(base + '/token', jsonOpt('POST', { address, password }));
    if (tr.status === 429) { await sleep(1200); tr = await f(base + '/token', jsonOpt('POST', { address, password })); }
    if (!tr.ok) continue;
    const td = await tr.json();
    if (td && td.token) return { address, token: td.token, password };
  }
  return null;
}

// Try each provider until one accepts the token (tokens belong to one provider).
async function upstream(path, method, body, auth) {
  let last = null;
  for (const base of PROVIDERS) {
    try {
      const r = await f(base + path, jsonOpt(method, method === 'POST' ? body || {} : undefined, auth));
      if (r.status !== 401 && r.status !== 404 && !(r.status >= 500)) return r;
      last = r;
    } catch (e) { /* try next */ }
  }
  return last;
}

async function pass(res, r) {
  const text = await r.text();
  res.status(r.status);
  res.setHeader('Content-Type', r.headers.get('content-type') || 'application/json');
  return res.send(text);
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  if (req.method === 'OPTIONS') return res.status(204).end();

  const path = String((req.query && req.query.path) || '');
  if (path && !path.startsWith('/')) return res.status(400).json({ error: 'bad path' });
  const auth = req.headers.authorization || '';
  let body = req.body;
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch (e) { body = {}; } }
  body = body || {};

  try {
    // CREATE MAILBOX
    if (req.method === 'POST' && !path) {
      const prefix = body.username ? String(body.username) : null;
      for (const base of PROVIDERS) {
        try {
          const acc = await createOn(base, prefix);
          if (acc) return res.status(200).json(acc);
        } catch (e) { /* try next provider */ }
      }
      return res.status(502).json({ error: 'mailbox creation failed' });
    }

    // TOKEN
    if (req.method === 'POST' && path === '/token') {
      const r = await upstream('/token', 'POST', body);
      if (!r) return res.status(502).json({ error: 'upstream failed' });
      return pass(res, r);
    }

    // LIST MESSAGES
    if (req.method === 'GET' && path === '/messages') {
      const r = await upstream('/messages', 'GET', undefined, auth);
      if (!r) return res.status(502).json({ error: 'upstream failed' });
      if (!r.ok) return pass(res, r);
      const data = await r.json();
      const items = Array.isArray(data) ? data : data['hydra:member'] || [];
      return res.status(200).json(items.map(m => ({
        id: m.id,
        subject: m.subject || '',
        from_addr: m.from ? m.from.address || '' : '',
        from_name: m.from ? m.from.name || '' : '',
        created_at: m.createdAt || '',
        intro: m.intro || '',
        seen: !!m.seen
      })));
    }

    // MESSAGE DETAIL
    if (req.method === 'GET' && path.startsWith('/messages/')) {
      const id = path.replace(/^\/messages\//, '');
      const r = await upstream('/messages/' + encodeURIComponent(id), 'GET', undefined, auth);
      if (!r) return res.status(502).json({ error: 'upstream failed' });
      if (!r.ok) return pass(res, r);
      const d = await r.json();
      const htmlArr = Array.isArray(d.html) ? d.html : d.html ? [d.html] : [];
      return res.status(200).json({
        id: d.id,
        subject: d.subject || '',
        from_addr: d.from ? d.from.address || '' : '',
        from_name: d.from ? d.from.name || '' : '',
        created_at: d.createdAt || '',
        text: Array.isArray(d.text) ? d.text.join('\n') : d.text || '',
        html: htmlArr,
        has_html: htmlArr.length > 0
      });
    }

    // FALLBACK
    const r = await upstream(path, req.method, body, auth);
    if (!r) return res.status(502).json({ error: 'upstream failed' });
    return pass(res, r);
  } catch (e) {
    return res.status(502).json({ error: 'upstream failed', detail: String((e && e.message) || e) });
  }
};
