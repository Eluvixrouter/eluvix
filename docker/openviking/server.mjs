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
// Per-session buffered messages awaiting /commit
const sessionBuffers = new Map();

function buildMemoryRecord({ id, uri, score = 0.9, l0, l1, l2, category = 'general' }) {
  return {
    id,
    uri,
    score,
    L0: l0,
    L1: l1,
    L2: l2,
    abstract: l0,
    overview: l1,
    content: l2,
    category,
    created_at: new Date().toISOString()
  };
}

// Seed initial memory items for testing
const defaultUri = 'viking://user/default/memories';
memoryStore.set(defaultUri, [
  buildMemoryRecord({
    id: 'mem_ov_init_1',
    uri: `${defaultUri}/preferences`,
    score: 0.94,
    l0: 'Prefers TypeScript strict mode with no implicit any',
    l1: 'Coding guidelines: Strict typing, modern ESM modules, pnpm workspaces, and functional pure handlers.',
    l2: 'User preferences: Always enforce TypeScript strict compiler flags. Prefer pnpm workspace packages and avoid legacy CommonJS syntax in new components.'
  }),
  buildMemoryRecord({
    id: 'mem_ov_init_2',
    uri: `${defaultUri}/architecture`,
    score: 0.88,
    l0: 'Eluvix sovereign gateway on port 3588 with dual-protocol demuxing',
    l1: 'Infrastructure setup: Next.js console running on port 3588 with same-port HTTP/1.1 308 auto-upgrade to HTTPS.',
    l2: 'Architecture details: Port 3588 performs TCP first-byte sniffing to transparently upgrade cleartext HTTP clients to TLS without protocol mismatch errors.'
  })
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

async function handleRequest(req, res) {
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

  // POST /api/v1/sessions/:id/messages - Append turn messages to session buffer and index into user memory
  const messagesMatch = url.pathname.match(/^\/api\/v1\/sessions\/([^/]+)\/messages$/);
  if (req.method === 'POST' && messagesMatch) {
    const sessionId = decodeURIComponent(messagesMatch[1]);
    const body = await parseBody(req);
    const userId = body.user_id || req.headers['x-openviking-user'] || 'default';
    const targetUri = body.target_uri || `viking://user/${userId}/memories`;
    const messages = Array.isArray(body.messages) ? body.messages : [];

    const buf = sessionBuffers.get(sessionId) || [];
    buf.push(...messages);
    sessionBuffers.set(sessionId, buf);

    const existing = memoryStore.get(targetUri) || [];
    if (messages.length > 0) {
      const userMsg = messages.find(m => m && m.role === 'user');
      const assistantMsg = messages.find(m => m && m.role === 'assistant');
      const uText = userMsg ? String(userMsg.content || '') : '';
      const aText = assistantMsg ? String(assistantMsg.content || '') : '';
      const combined = [uText && `User: ${uText}`, aText && `Assistant: ${aText}`].filter(Boolean).join(' | ');
      if (combined) {
        existing.push(
          buildMemoryRecord({
            id: `mem_turn_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`,
            uri: `${targetUri}/turn_${Date.now()}`,
            score: 0.91,
            l0: (uText || combined).slice(0, 60),
            l1: `Turn memory (${sessionId}): ${combined.slice(0, 180)}`,
            l2: combined
          })
        );
        memoryStore.set(targetUri, existing);
      }
    }

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      status: 'buffered',
      session_id: sessionId,
      target_uri: targetUri,
      buffered_messages: buf.length
    }));
    return;
  }

  // POST /api/v1/sessions/:id/commit - Session context commit
  const commitMatch = url.pathname.match(/^\/api\/v1\/sessions\/([^/]+)\/commit$/);
  if (req.method === 'POST' && commitMatch) {
    const sessionId = decodeURIComponent(commitMatch[1]);
    const body = await parseBody(req);
    const userId = body.user_id || req.headers['x-openviking-user'] || 'default';
    const targetUri = body.target_uri || `viking://user/${userId}/memories`;
    const buffered = sessionBuffers.get(sessionId) || [];
    const messages = Array.isArray(body.messages) && body.messages.length > 0 ? body.messages : buffered;

    const existing = memoryStore.get(targetUri) || [];
    const newItems = [];

    // Extract significant facts from messages if not already indexed
    if (Array.isArray(body.messages) && body.messages.length > 0) {
      const lastUser = [...messages].reverse().find(m => m.role === 'user');
      const text = lastUser ? (typeof lastUser.content === 'string' ? lastUser.content : JSON.stringify(lastUser.content)) : 'Session turn';
      const newItem = buildMemoryRecord({
        id: `mem_commit_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`,
        uri: `${targetUri}/commit_${Date.now()}`,
        score: 0.9,
        l0: text.slice(0, 50),
        l1: `Session summary (${sessionId}): ${text.slice(0, 140)}`,
        l2: `Committed session transcript context: ${text}`
      });
      existing.push(newItem);
      newItems.push(newItem);
    }

    sessionBuffers.delete(sessionId);
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
    const item = buildMemoryRecord({
      id: `mem_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`,
      uri: `${targetUri}/item_${Date.now()}`,
      score: 0.95,
      l0: text.slice(0, 50),
      l1: `Memory note: ${text.slice(0, 140)}`,
      l2: text,
      category: body.category || 'general'
    });
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
}

// A rejected parseBody (oversized payload, aborted client) must never become
// an unhandled rejection — Node exits on those, killing the simulator.
// Oversized requests have already destroyed their socket, so the error
// response below is best-effort; the log line is the guaranteed outcome.
const server = http.createServer((req, res) => {
  handleRequest(req, res).catch(err => {
    console.error(`[OpenViking Simulator] Request error: ${err?.message || err}`);
    try {
      if (!res.headersSent && !res.writableEnded) {
        const status = err?.message === 'Payload too large' ? 413 : 500;
        res.writeHead(status, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err?.message || 'Internal error' }));
      } else if (!res.writableEnded) {
        res.end();
      }
    } catch {}
  });
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`[OpenViking Simulator] Listening on http://0.0.0.0:${PORT}`);
});
