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
        { id: 'harness/trueforge', object: 'model', owned_by: 'trueforge' },
        { id: 'trueforge/default', object: 'model', owned_by: 'trueforge' },
        { id: 'trueforge/coder', object: 'model', owned_by: 'trueforge' },
        { id: 'trueforge/researcher', object: 'model', owned_by: 'trueforge' },
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
      agent_id: body.agentId || body.agent_id || 'default',
      tools: body.tools || ['bash', 'file_reader', 'grep_search'],
      context: body.context || body.metadata || {},
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
    const msgPrompt = Array.isArray(body.messages)
      ? ([...body.messages].reverse().find(m => m && m.role === 'user')?.content || '')
      : '';
    const prompt = String(body.input || body.prompt || body.message || msgPrompt || 'Run agent task');

    turns.set(turnId, { id: turnId, sessionId, prompt, status: 'running' });

    const wantsStream = req.headers.accept?.includes('text/event-stream') || body.stream !== false;
    const output = `TrueForge agent processed prompt "${prompt.slice(0, 60)}" successfully across 2 steps.`;

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
      }, 20);

      setTimeout(() => {
        sendEvent('tool.call', {
          call_id: `call_${Date.now()}`,
          tool_name: 'inspect_repo',
          arguments: { query: 'components' },
          approval_required: false
        });
      }, 40);

      setTimeout(() => {
        sendEvent('tool.result', {
          call_id: `call_${Date.now()}`,
          tool_name: 'inspect_repo',
          output: 'Found 14 TypeScript files and packages/router-core'
        });
      }, 60);

      setTimeout(() => {
        sendEvent('text-delta', { type: 'text-delta', turn_id: turnId, delta: output });
      }, 80);

      setTimeout(() => {
        sendEvent('turn.completed', { turn_id: turnId, session_id: sessionId, status: 'completed', output });
        res.end();
      }, 100);

      return;
    }

    // Non-streaming response
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      turn_id: turnId,
      session_id: sessionId,
      status: 'completed',
      output,
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
}

// A rejected parseBody (oversized payload, aborted client) must never become
// an unhandled rejection — Node exits on those, killing the simulator.
// Oversized requests have already destroyed their socket, so the error
// response below is best-effort; the log line is the guaranteed outcome.
const server = http.createServer((req, res) => {
  handleRequest(req, res).catch(err => {
    console.error(`[TrueForge Simulator] Request error: ${err?.message || err}`);
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
  console.log(`[TrueForge Simulator] Listening on http://0.0.0.0:${PORT}`);
});
