import http from 'node:http';

const PORT = Number(process.env.PORT || 8004);
const MAX_BODY_BYTES = 5 * 1024 * 1024; // 5 MB limit
const factsByGroup = new Map();

function parseBody(req) {
  return new Promise((resolve, reject) => {
    let raw = '';
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        req.destroy();
        reject(new Error('Payload too large'));
        return;
      }
      raw += chunk;
    });
    req.on('end', () => {
      try { resolve(raw ? JSON.parse(raw) : {}); } catch { resolve({}); }
    });
    req.on('error', reject);
  });
}

const server = http.createServer(async (req, res) => {
  res.setHeader('Content-Type', 'application/json');

  try {
    if (req.method === 'GET' && req.url === '/health') {
      res.end(JSON.stringify({ status: 'ok', service: 'eluvix-graphiti', groups: factsByGroup.size }));
      return;
    }
    if (req.method === 'POST' && req.url === '/messages') {
      let body;
      try {
        body = await parseBody(req);
      } catch {
        res.statusCode = 413;
        res.end(JSON.stringify({ error: 'Payload too large (limit 5MB)' }));
        return;
      }
      const groupId = String(body.group_id || 'default');
      const msgs = Array.isArray(body.messages) ? body.messages : [];
      const list = factsByGroup.get(groupId) || [];
      const nowIso = new Date().toISOString();
      for (const m of msgs) {
        const content = typeof m.content === 'string' ? m.content.trim() : '';
        if (content) {
          list.push({
            uuid: `edge-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
            fact: content,
            role: m.role || 'user',
            valid_at: m.timestamp || nowIso,
            invalid_at: null
          });
        }
      }
      factsByGroup.set(groupId, list.slice(-200));
      res.end(JSON.stringify({ status: 'ok', added: msgs.length }));
      return;
    }
    if (req.method === 'POST' && req.url === '/search') {
      let body;
      try {
        body = await parseBody(req);
      } catch {
        res.statusCode = 413;
        res.end(JSON.stringify({ error: 'Payload too large (limit 5MB)' }));
        return;
      }
      const groupId = String(body.group_id || 'default');
      const query = String(body.query || '').toLowerCase();
      const maxFacts = Number(body.max_facts || 10);
      const list = factsByGroup.get(groupId) || [];
      const terms = query.split(/\W+/).filter((w) => w.length > 2);
      const ranked = list
        .map((item) => {
          const lower = item.fact.toLowerCase();
          const hits = terms.filter((t) => lower.includes(t)).length;
          return { ...item, score: terms.length ? hits / terms.length : 0.5 };
        })
        .filter((item) => item.score > 0 || list.length <= 5)
        .sort((a, b) => b.score - a.score)
        .slice(0, maxFacts);
      res.end(JSON.stringify({ facts: ranked }));
      return;
    }
    res.statusCode = 404;
    res.end(JSON.stringify({ error: 'Not found' }));
  } catch (err) {
    if (!res.headersSent) {
      res.statusCode = 500;
      res.end(JSON.stringify({ error: 'Internal Server Error' }));
    }
  }
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`[Eluvix Graphiti Sidecar] Listening on :${PORT}`);
});
