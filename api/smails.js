// Temp mail proxy: mail.tm first, mail.gw as backup (same API).
const PROVIDERS = ['https://api.mail.tm', 'https://api.mail.gw'];
const sleep = ms => new Promise(r => setTimeout(r, ms));

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
async function f(url, opt = {}, ms = 4000, notes) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  const tag = url.replace(/^https:\/\/api\./, '').split('/')[0];
  try {
    const r = await fetch(url, {
      ...opt,
      headers: { 'User-Agent': UA, 'Accept': 'application/json', 'Accept-Language': 'en-US,en;q=0.9', ...(opt.headers || {}) },
      signal: ctrl.signal
    });
    if (!r.ok && notes) notes.push(tag + ':' + r.status);
    return r;
  } catch (e) {
    if (notes) notes.push(tag + ':' + (e.name === 'AbortError' ? 'timeout' : 'fail'));
    throw e;
  } finally { clearTimeout(t); }
}
const jsonOpt = (method, body, auth) => ({
  method,
  headers: { 'Content-Type': 'application/json', ...(auth ? { Authorization: auth } : {}) },
  body: body === undefined ? undefined : JSON.stringify(body)
});
const rnd = n => Math.random().toString(36).substring(2, 2 + n);

async function createOn(base, customPrefix, notes) {
  const dr = await f(base + '/domains', {}, 4000, notes);
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

    const ar = await f(base + '/accounts', jsonOpt('POST', { address, password }), 4000, notes);
    if (ar.status === 429) { await sleep(1200); continue; }
    if (!ar.ok) continue;

    let tr = await f(base + '/token', jsonOpt('POST', { address, password }), 4000, notes);
    if (tr.status === 429) { await sleep(1200); tr = await f(base + '/token', jsonOpt('POST', { address, password })); }
    if (!tr.ok) continue;
    const td = await tr.json();
    if (td && td.token) return { address, token: td.token, password };
  }
  return null;
}


// ---- Backup provider: tempmail.lol (token does not start with "eyJ") ----
const LOL = 'https://api.tempmail.lol/v2';
const isLol = t => !String(t).startsWith('eyJ') && !String(t).startsWith('gm_');
const bearer = a => String(a || '').replace(/^Bearer\s+/i, '');
const lolFrom = x => { const m = String(x || '').match(/^(.*?)\s*<([^>]+)>\s*$/); return m ? { name: m[1].replace(/"/g, ''), addr: m[2] } : { name: '', addr: String(x || '') }; };

async function lolCreate(notes) {
  const r = await f(LOL + '/inbox/create', jsonOpt('POST', {}), 6000, notes);
  if (!r.ok) return null;
  const d = await r.json();
  return d && d.address && d.token ? { address: d.address, token: d.token, password: '' } : null;
}
const LOL_CACHE = new Map(); // token -> { t, emails }
async function lolEmails(token, notes) {
  const hit = LOL_CACHE.get(token);
  if (hit && Date.now() - hit.t < 8000) return hit.emails;           // fresh copy, spare the API
  let r = await f(LOL + '/inbox?token=' + encodeURIComponent(token), {}, 6000, notes);
  if (r.status === 429) {                                             // rate limited: wait once, retry
    await sleep(1500);
    r = await f(LOL + '/inbox?token=' + encodeURIComponent(token), {}, 6000, notes);
  }
  if (r.status === 429 && hit) return hit.emails;                     // still limited: show the last copy
  if (r.status === 400 || r.status === 404) return 'expired';
  if (!r.ok) return null;
  const d = await r.json();
  if (d.expired) return 'expired';
  LOL_CACHE.set(token, { t: Date.now(), emails: d.emails || [] });
  return d.emails || [];
}


// ---- Provider: Guerrilla Mail (token starts with "gm_") ----
const GM = 'https://api.guerrillamail.com/ajax.php';
const sidOf = t => bearer(t).replace(/^gm_/, '');
const stripTags = h => String(h || '').replace(/<style[\s\S]*?<\/style>/gi, ' ').replace(/<script[\s\S]*?<\/script>/gi, ' ').replace(/<br\s*\/?>/gi, '\n').replace(/<\/p>/gi, '\n').replace(/<[^>]*>/g, ' ').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/[ \t]+/g, ' ').replace(/\n\s*\n+/g, '\n').trim();

async function gmCreate(notes) {
  const r = await f(GM + '?f=get_email_address&lang=en&ip=127.0.0.1&agent=ztemp', {}, 6000, notes);
  if (!r.ok) return null;
  const d = await r.json();
  return d && d.email_addr && d.sid_token ? { address: d.email_addr, token: 'gm_' + d.sid_token, password: '' } : null;
}
async function gmList(token, notes) {
  const r = await f(GM + '?f=check_email&seq=0&sid_token=' + encodeURIComponent(sidOf(token)), {}, 6000, notes);
  if (!r.ok) return null;
  const d = await r.json();
  if (!d || !Array.isArray(d.list)) return null;
  return d.list.filter(m => m.mail_from !== 'no-reply@guerrillamail.com').sort((a, b) => Number(b.mail_timestamp) - Number(a.mail_timestamp));
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
      const notes = [];
      for (const base of PROVIDERS) {
        try {
          const acc = await createOn(base, prefix, notes);
          if (acc) return res.status(200).json(acc);
        } catch (e) { /* try next provider */ }
      }
      try { const acc = await gmCreate(notes); if (acc) return res.status(200).json(acc); } catch (e) { /* next */ }
      try { const acc = await lolCreate(notes); if (acc) return res.status(200).json(acc); } catch (e) { /* none worked */ }
      return res.status(502).json({ error: 'mailbox creation failed', detail: notes.join(', ') });
    }

    // TOKEN
    if (req.method === 'POST' && path === '/token') {
      const r = await upstream('/token', 'POST', body);
      if (!r) return res.status(502).json({ error: 'upstream failed' });
      return pass(res, r);
    }

    // Guerrilla Mail tokens
    if (req.method === 'GET' && bearer(auth).startsWith('gm_') && (path === '/messages' || path.startsWith('/messages/'))) {
      const notes = [];
      if (path === '/messages') {
        let list = null;
        try { list = await gmList(auth, notes); } catch (e) { /* noted */ }
        if (!list) return res.status(502).json({ error: 'upstream failed', detail: notes.join(', ') || 'gm: no list' });
        return res.status(200).json(list.map(m => { const x = lolFrom(m.mail_from); return { id: String(m.mail_id), subject: m.mail_subject || '', from_addr: x.addr, from_name: x.name, created_at: new Date(Number(m.mail_timestamp) * 1000).toISOString(), intro: m.mail_excerpt || '', seen: String(m.mail_read) === '1' }; }));
      }
      const id = decodeURIComponent(path.replace('/messages/', ''));
      let d = null;
      try {
        const r = await f(GM + '?f=fetch_email&email_id=' + encodeURIComponent(id) + '&sid_token=' + encodeURIComponent(sidOf(auth)), {}, 6000, notes);
        if (r.ok) d = await r.json();
      } catch (e) { /* noted */ }
      if (!d || !d.mail_id) return res.status(502).json({ error: 'upstream failed', detail: notes.join(', ') || 'gm: no mail' });
      const x = lolFrom(d.mail_from);
      const html = d.mail_body ? [d.mail_body] : [];
      return res.status(200).json({ id, subject: d.mail_subject || '', from_addr: x.addr, from_name: x.name, created_at: new Date(Number(d.mail_timestamp) * 1000).toISOString(), text: stripTags(d.mail_body), html, has_html: html.length > 0 });
    }

    // tempmail.lol tokens
    if (req.method === 'GET' && isLol(bearer(auth)) && (path === '/messages' || path.startsWith('/messages/'))) {
      const notes = [];
      let emails = null;
      try { emails = await lolEmails(bearer(auth), notes); } catch (e) { /* noted */ }
      if (emails === 'expired') return res.status(401).json({ error: 'expired' });
      if (!emails) return res.status(502).json({ error: 'upstream failed', detail: notes.join(', ') });
      if (path === '/messages') {
        return res.status(200).json(emails.map(m => { const x = lolFrom(m.from); return { id: String(m.date), subject: m.subject || '', from_addr: x.addr, from_name: x.name, created_at: new Date(m.date).toISOString(), intro: (m.body || '').slice(0, 100), seen: false }; }));
      }
      const id = decodeURIComponent(path.replace('/messages/', ''));
      const m = emails.find(e => String(e.date) === id);
      if (!m) return res.status(404).json({ error: 'not found' });
      const x = lolFrom(m.from);
      return res.status(200).json({ id, subject: m.subject || '', from_addr: x.addr, from_name: x.name, created_at: new Date(m.date).toISOString(), text: m.body || '', html: m.html ? [m.html] : [], has_html: !!m.html });
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
