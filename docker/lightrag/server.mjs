import http from 'node:http';

const PORT = Number(process.env.PORT || 9621);
const MAX_BODY_BYTES = 5 * 1024 * 1024; // 5 MB limit
const docs = [];

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
      res.end(JSON.stringify({ status: 'ok', service: 'eluvix-lightrag', indexed: docs.length }));
      return;
    }
    if (req.method === 'POST' && req.url === '/texts') {
      let body;
      try {
        body = await parseBody(req);
      } catch {
        res.statusCode = 413;
        res.end(JSON.stringify({ error: 'Payload too large (limit 5MB)' }));
        return;
      }
      const texts = Array.isArray(body.texts) ? body.texts : body.text ? [body.text] : [];
      for (const t of texts) {
        if (typeof t === 'string' && t.trim()) {
          docs.push({ text: t.trim(), source: body.file_source || 'lightrag://local', createdAt: Date.now() });
        }
      }
      res.end(JSON.stringify({ status: 'success', count: texts.length }));
      return;
    }
    if (req.method === 'POST' && req.url === '/query') {
      let body;
      try {
        body = await parseBody(req);
      } catch {
        res.statusCode = 413;
        res.end(JSON.stringify({ error: 'Payload too large (limit 5MB)' }));
        return;
      }
      const q = String(body.query || '').toLowerCase();
      const tokens = q.split(/\W+/).filter((w) => w.length > 2);
      const matches = docs
        .map((d) => {
          const lower = d.text.toLowerCase();
          const hits = tokens.filter((t) => lower.includes(t)).length;
          return { ...d, score: tokens.length ? hits / tokens.length : 0.5 };
        })
        .filter((d) => d.score > 0 || docs.length <= 5)
        .sort((a, b) => b.score - a.score)
        .slice(0, 6);
      const context = matches.map((m) => `[Source: ${m.source}]\n${m.text}`).join('\n\n');
      res.end(JSON.stringify({ response: context, results: matches }));
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
  console.log(`[Eluvix LightRAG Sidecar] Listening on :${PORT}`);
});
