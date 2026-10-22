// ============================================================================
// SIMULATOR — OpenViking Context Database Stand-in.
//
// This is a stand-in service used for local development of the Eluvix
// dashboard and orchestration flows. It mimics the shape of the OpenViking
// HTTP API (L0/L1/L2 hierarchical context recall and session commit).
// See docker/README.md.
// ============================================================================
import http from 'http';

const PORT = parseInt(process.env.PORT || process.env.OPENVIKING_PORT || '1933', 10);

// In-memory memory store mapped by URI prefix
const memoryStore = new Map();

// Seed initial memory items for testing
const defaultUri = 'viking://user/default/memories';
memoryStore.set(defaultUri, [
  {
    id: 'mem_ov_init_1',
    uri: `${defaultUri}/preferences`,
    score: 0.94,
    L0: 'Prefers TypeScript strict mode with no implicit any',
    L1: 'Coding guidelines: Strict typing, modern ESM modules, pnpm workspaces, and functional pure handlers.',
    L2: 'User preferences: Always enforce TypeScript strict compiler flags. Prefer pnpm workspace packages and avoid legacy CommonJS syntax in new components.',
    created_at: new Date().toISOString()
  },
  {
    id: 'mem_ov_init_2',
    uri: `${defaultUri}/architecture`,
    score: 0.88,
    L0: 'Eluvix sovereign gateway on port 3588 with dual-protocol demuxing',
    L1: 'Infrastructure setup: Next.js console running on port 3588 with same-port HTTP/1.1 308 auto-upgrade to HTTPS.',
    L2: 'Architecture details: Port 3588 performs TCP first-byte sniffing to transparently upgrade cleartext HTTP clients to TLS without protocol mismatch errors.',
    created_at: new Date().toISOString()
  }
]);

function applyCors(req, res) {
  const origin = req.headers.origin;
  if (origin && origin !== 'null') {
    try {
      const u = new URL(origin);
      const host = u.hostname.replace(/^\[|\]$/g, '');
      if (
        host === 'localhost' ||
        host === '127.0.0.1' ||
        host === '::1' ||
        host.endsWith('.local') ||
        u.protocol === 'app:' ||
        u.protocol === 'vscode-webview:'
      ) {
        res.setHeader('Access-Control-Allow-Origin', origin);
        res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
        res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Api-Key, X-OpenViking-User');
        res.setHeader('Vary', 'Origin');
      }
    } catch {}
  }
}

async function parseBody(req) {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', chunk => {
      raw += chunk;
      if (raw.length > 5 * 1024 * 1024) {
        req.destroy();
        reject(new Error('Payload too large'));
      }
    });
    req.on('end', () => {
      if (!raw.trim()) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch (err) {
        resolve({ _raw: raw });
      }
    });
    req.on('error', reject);
  });
}

const server = http.createServer(async (req, res) => {
  applyCors(req, res);

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);

  // Health check
  if (url.pathname === '/health' || url.pathname === '/healthz') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      status: 'ok',
      service: 'openviking',
      version: 'v0.5.1',
      port: PORT,
      memories_count: Array.from(memoryStore.values()).reduce((acc, list) => acc + list.length, 0)
    }));
    return;
  }

  // Model list compatibility
  if (url.pathname === '/v1/models' || url.pathname === '/models') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      object: 'list',
      data: [
        { id: 'openviking-context', object: 'model', owned_by: 'openviking' }
      ]
    }));
    return;
  }

  // POST /api/v1/search/find - Hierarchical memory recall
  if (req.method === 'POST' && (url.pathname === '/api/v1/search/find' || url.pathname === '/search/find')) {
    const body = await parseBody(req);
    const targetUri = body.target_uri || body.uri || 'viking://user/default/memories';
    const query = (body.query || '').toLowerCase().trim();
    const limit = Math.max(1, Math.min(20, body.limit || 5));
    const scoreThreshold = body.score_threshold || 0.4;

    // Find all matching memories across exact URI or prefix
    let matches = [];
    for (const [key, items] of memoryStore.entries()) {
      if (key === targetUri || key.startsWith(targetUri) || targetUri.startsWith(key)) {
        matches.push(...items);
      }
    }

    // Fallback if none found for user
    if (matches.length === 0) {
      matches = memoryStore.get(defaultUri) || [];
    }

    // Rank / filter results
    const results = matches
      .map(item => {
        let score = item.score || 0.85;
        if (query) {
          const l0Match = item.L0.toLowerCase().includes(query);
          const l1Match = item.L1.toLowerCase().includes(query);
          const l2Match = item.L2.toLowerCase().includes(query);
          if (l0Match) score = Math.min(0.99, score + 0.1);
          else if (l1Match || l2Match) score = Math.min(0.95, score + 0.05);
          else score = Math.max(0.45, score - 0.2);
        }
        return { ...item, score };
      })
      .filter(item => item.score >= scoreThreshold)
      .sort((a, b) => b.score - a.score)
      .slice(0, limit);

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      status: 'success',
      target_uri: targetUri,
      query: body.query || '',
      results,
      count: results.length
    }));
    return;
  }

  // POST /api/v1/sessions/:id/commit - Session context commit
  const commitMatch = url.pathname.match(/^\/api\/v1\/sessions\/([^/]+)\/commit$/);
  if (req.method === 'POST' && commitMatch) {
    const sessionId = commitMatch[1];
    const body = await parseBody(req);
    const targetUri = body.target_uri || `viking://session/${sessionId}/memories`;
    const messages = Array.isArray(body.messages) ? body.messages : [];

    const existing = memoryStore.get(targetUri) || [];
    const newItems = [];

    // Extract significant facts from messages
    if (messages.length > 0) {
      const lastUser = [...messages].reverse().find(m => m.role === 'user');
      const text = lastUser ? (typeof lastUser.content === 'string' ? lastUser.content : JSON.stringify(lastUser.content)) : 'Session turn';
      const newItem = {
        id: `mem_commit_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`,
        uri: `${targetUri}/commit_${Date.now()}`,
        score: 0.9,
        L0: text.slice(0, 40) + '...',
        L1: `Session summary (${sessionId}): ${text.slice(0, 100)}`,
        L2: `Committed session transcript context: ${text}`,
        created_at: new Date().toISOString()
      };
      existing.push(newItem);
      newItems.push(newItem);
    }

    memoryStore.set(targetUri, existing);

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      status: 'committed',
      session_id: sessionId,
      target_uri: targetUri,
      memories_created: newItems.length,
      total_memories: existing.length
    }));
    return;
  }

  // GET /api/v1/memories - List memories
  if (req.method === 'GET' && url.pathname === '/api/v1/memories') {
    const targetUri = url.searchParams.get('target_uri') || defaultUri;
    const items = memoryStore.get(targetUri) || [];
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      status: 'success',
      target_uri: targetUri,
      memories: items
    }));
    return;
  }

  // POST /api/v1/memories - Add manual memory
  if (req.method === 'POST' && url.pathname === '/api/v1/memories') {
    const body = await parseBody(req);
    const targetUri = body.target_uri || defaultUri;
    const text = body.text || body.content || '';
    const existing = memoryStore.get(targetUri) || [];
    const item = {
      id: `mem_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`,
      uri: `${targetUri}/item_${Date.now()}`,
      score: 0.95,
      L0: text.slice(0, 35) + '...',
      L1: `Memory note: ${text.slice(0, 90)}`,
      L2: text,
      category: body.category || 'general',
      created_at: new Date().toISOString()
    };
    existing.push(item);
    memoryStore.set(targetUri, existing);

    res.writeHead(201, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'created', memory: item }));
    return;
  }

  // DELETE /api/v1/memories - Clear memories
  if (req.method === 'DELETE' && url.pathname === '/api/v1/memories') {
    const targetUri = url.searchParams.get('target_uri');
    if (targetUri) {
      memoryStore.delete(targetUri);
    } else {
      memoryStore.clear();
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'cleared' }));
    return;
  }

  // 404 handler
  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: 'Endpoint not found', path: url.pathname }));
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`[OpenViking Simulator] Listening on http://0.0.0.0:${PORT}`);
});
