export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  if (req.method === 'OPTIONS') return res.status(204).end();

  const path = String(req.query.path || '');
  if (path && !path.startsWith('/')) return res.status(400).json({ error: 'bad path' });

  try {
    // ============ CREATE MAILBOX ============
    if (req.method === 'POST' && !path) {
      const customPrefix = req.body && req.body.username
        ? String(req.body.username).toLowerCase().replace(/[^a-z0-9]/g, '')
        : null;

      const domainsRes = await fetch('https://api.mail.tm/domains');
      if (!domainsRes.ok) return res.status(502).json({ error: 'domains failed' });
      const domainsData = await domainsRes.json();
      const domains = domainsData['hydra:member'] || [];
      if (!domains.length) return res.status(502).json({ error: 'no domains' });
      const domain = domains[0].domain;

      let account = null;
      for (let attempt = 0; attempt < 4; attempt++) {
        let username = (attempt === 0 && customPrefix)
          ? customPrefix
          : 'u' + Math.random().toString(36).substring(2, 13);
        username = username.toLowerCase().replace(/[^a-z0-9]/g, '');
        if (!username) username = 'u' + Math.random().toString(36).substring(2, 13);

        const password = Math.random().toString(36).substring(2, 10)
          + 'Aa1!' + Math.random().toString(36).substring(2, 6);
        const address = username + '@' + domain;

        const accRes = await fetch('https://api.mail.tm/accounts', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ address, password })
        });
        if (!accRes.ok) continue;

        const tokenRes = await fetch('https://api.mail.tm/token', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ address, password })
        });
        if (!tokenRes.ok) continue;
        const tokenData = await tokenRes.json();
        if (!tokenData || !tokenData.token) continue;

        account = { address, token: tokenData.token };
        break;
      }

      if (!account) return res.status(502).json({ error: 'mailbox creation failed' });
      return res.status(200).json(account);
    }

    // ============ LIST MESSAGES ============
    if (req.method === 'GET' && path === '/messages') {
      const r = await fetch('https://api.mail.tm/messages', {
        headers: { 'Authorization': req.headers.authorization || '' }
      });
      if (!r.ok) {
        const text = await r.text();
        res.status(r.status);
        res.setHeader('Content-Type', r.headers.get('content-type') || 'application/json');
        res.send(text);
        return;
      }
      const data = await r.json();
      const items = data['hydra:member'] || [];
      const messages = items.map(m => ({
        id: m.id,
        subject: m.subject || '',
        from_addr: m.from ? (m.from.address || '') : '',
        from_name: m.from ? (m.from.name || '') : '',
        created_at: m.createdAt || '',
        intro: m.intro || '',
        seen: !!m.seen
      }));
      return res.status(200).json(messages);
    }

    // ============ MESSAGE DETAIL ============
    if (req.method === 'GET' && path.startsWith('/messages/')) {
      const id = path.replace(/^\/messages\//, '');
      const r = await fetch('https://api.mail.tm/messages/' + encodeURIComponent(id), {
        headers: { 'Authorization': req.headers.authorization || '' }
      });
      if (!r.ok) {
        const text = await r.text();
        res.status(r.status);
        res.setHeader('Content-Type', r.headers.get('content-type') || 'application/json');
        res.send(text);
        return;
      }
      const data = await r.json();
      const htmlArr = Array.isArray(data.html)
        ? data.html
        : (data.html ? [data.html] : []);
      const textBody = Array.isArray(data.text)
        ? data.text.join('\n')
        : (data.text || '');
      return res.status(200).json({
        id: data.id,
        subject: data.subject || '',
        from_addr: data.from ? (data.from.address || '') : '',
        from_name: data.from ? (data.from.name || '') : '',
        created_at: data.createdAt || '',
        text: textBody,
        html: htmlArr,
        has_html: htmlArr.length > 0
      });
    }

    // ============ FALLBACK ============
    const r = await fetch('https://api.mail.tm' + path, {
      method: req.method,
      headers: {
        'Content-Type': 'application/json',
        ...(req.headers.authorization ? { 'Authorization': req.headers.authorization } : {})
      },
      body: req.method === 'POST' ? JSON.stringify(req.body || {}) : undefined
    });
    const text = await r.text();
    res.status(r.status);
    res.setHeader('Content-Type', r.headers.get('content-type') || 'application/json');
    res.send(text);
  } catch (e) {
    res.status(502).json({ error: 'upstream failed', detail: String((e && e.message) || e) });
  }
    }
