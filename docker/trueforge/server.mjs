// ============================================================================
// SIMULATOR — TrueForge Agent Harness Stand-in.
//
// This is a stand-in service used for local development of the Eluvix
// dashboard and orchestration flows. It mimics the shape of the TrueForge
// HTTP API (sessions, turns, SSE step execution, and tool approval events).
// See docker/README.md.
// ============================================================================
import http from 'http';

const PORT = parseInt(process.env.PORT || process.env.TRUEFORGE_PORT || '8790', 10);

const sessions = new Map();
const turns = new Map();

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
        res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, x-eluvix-origin, x-eluvix-hops');
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
      service: 'trueforge',
      version: 'v0.2.0',
      port: PORT,
      active_sessions: sessions.size
    }));
    return;
  }

  // Model list compatibility
  if (url.pathname === '/v1/models' || url.pathname === '/models') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      object: 'list',
      data: [
        { id: 'trueforge-agent', object: 'model', owned_by: 'trueforge' },
        { id: 'trueforge-coder', object: 'model', owned_by: 'trueforge' }
      ]
    }));
    return;
  }

  // POST /api/v1/sessions - Create agent session
  if (req.method === 'POST' && (url.pathname === '/api/v1/sessions' || url.pathname === '/sessions')) {
    const body = await parseBody(req);
    const sessionId = `sess_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`;
    const session = {
      id: sessionId,
      agent_id: body.agent_id || 'default',
      tools: body.tools || ['bash', 'file_reader', 'grep_search'],
      context: body.context || {},
      status: 'ready',
      created_at: new Date().toISOString()
    };
    sessions.set(sessionId, session);

    res.writeHead(201, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(session));
    return;
  }

  // GET /api/v1/sessions/:id - Get session info
  const sessionGetMatch = url.pathname.match(/^\/(?:api\/v1\/)?sessions\/([^/]+)$/);
  if (req.method === 'GET' && sessionGetMatch) {
    const sessionId = sessionGetMatch[1];
    const session = sessions.get(sessionId);
    if (!session) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Session not found', sessionId }));
      return;
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(session));
    return;
  }

  // POST /api/v1/sessions/:id/turns - Turn execution (streaming SSE or non-streaming)
  const turnMatch = url.pathname.match(/^\/(?:api\/v1\/)?sessions\/([^/]+)\/turns$/);
  if (req.method === 'POST' && turnMatch) {
    const sessionId = turnMatch[1];
    const body = await parseBody(req);
    const turnId = `turn_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`;
    const prompt = body.prompt || body.message || 'Run agent task';

    turns.set(turnId, { id: turnId, sessionId, prompt, status: 'running' });

    const wantsStream = req.headers.accept?.includes('text/event-stream') || body.stream !== false;

    if (wantsStream) {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache, no-transform',
        'Connection': 'keep-alive'
      });

      const sendEvent = (event, data) => {
        res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
      };

      sendEvent('turn.start', { turn_id: turnId, session_id: sessionId });

      setTimeout(() => {
        sendEvent('step.start', { step: 1, action: 'analyze', description: `Analyzing input: "${prompt.slice(0, 50)}"` });
      }, 50);

      setTimeout(() => {
        sendEvent('tool.call', {
          call_id: `call_${Date.now()}`,
          tool_name: 'inspect_repo',
          arguments: { query: 'components' },
          approval_required: false
        });
      }, 150);

      setTimeout(() => {
        sendEvent('tool.result', {
          call_id: `call_${Date.now()}`,
          tool_name: 'inspect_repo',
          output: 'Found 14 TypeScript files and packages/router-core'
        });
      }, 250);

      setTimeout(() => {
        sendEvent('step.start', { step: 2, action: 'formulate', description: 'Generating final solution...' });
      }, 350);

      setTimeout(() => {
        const output = `TrueForge agent processed prompt "${prompt.slice(0, 40)}..." successfully across 2 steps.`;
        sendEvent('turn.end', { turn_id: turnId, session_id: sessionId, status: 'completed', output });
        res.end();
      }, 450);

      return;
    }

    // Non-streaming response
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      turn_id: turnId,
      session_id: sessionId,
      status: 'completed',
      output: `TrueForge agent processed prompt "${prompt.slice(0, 40)}..." successfully.`,
      steps_executed: 2
    }));
    return;
  }

  // POST /api/v1/sessions/:id/turns/:turnId/events - Tool approval dispatch
  const eventMatch = url.pathname.match(/^\/(?:api\/v1\/)?sessions\/([^/]+)\/turns\/([^/]+)\/events$/);
  if (req.method === 'POST' && eventMatch) {
    const sessionId = eventMatch[1];
    const turnId = eventMatch[2];
    const body = await parseBody(req);

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      status: 'accepted',
      session_id: sessionId,
      turn_id: turnId,
      event: body.type || 'tool_approved',
      processed_at: new Date().toISOString()
    }));
    return;
  }

  // 404 handler
  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: 'Endpoint not found', path: url.pathname }));
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`[TrueForge Simulator] Listening on http://0.0.0.0:${PORT}`);
});
