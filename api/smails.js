export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  if (req.method === 'OPTIONS') return res.status(204).end();

  const path = String(req.query.path || '');
  if (path && !path.startsWith('/')) return res.status(400).json({ error: 'bad path' });

  const headers = {};
  if (req.headers.authorization) headers['Authorization'] = req.headers.authorization;

  let body;
  if (req.method === 'POST' && req.body && Object.keys(req.body).length) {
    headers['Content-Type'] = 'application/json';
    body = JSON.stringify(req.body);
  }

  try {
    const r = await fetch('https://smails.dev/api/mailbox' + path, { method: req.method, headers, body });
    const text = await r.text();
    res.status(r.status);
    res.setHeader('Content-Type', r.headers.get('content-type') || 'application/json');
    res.send(text);
  } catch (e) {
    res.status(502).json({ error: 'upstream failed' });
  }
}
