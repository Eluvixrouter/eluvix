// ============================================================================
// SIMULATOR — not a real agent router service.
//
// This is a canned-response stand-in used for local development of the
// Eluvix dashboard and orchestration flows. It mimics the shape of the
// agent router HTTP API with hardcoded/heuristic replies; no model is loaded
// and no real inference or routing happens here. Do not benchmark,
// demo, or draw conclusions about the real service from its responses.
// See docker/README.md.
// ============================================================================
import http from 'http';
import fs from 'fs';

const PORT = parseInt(process.env.PORT || '8002', 10);
const MAX_BODY_BYTES = 5 * 1024 * 1024; // 5 MB
const CONFIG_PATH = process.env.AGENT_ROUTER_CONFIG_PATH || '/config/routing.json';

const DEFAULT_ROUTES = {
  preference: 'balanced',
  agents: [
    { id: 'antigravity-1', name: 'Google Antigravity', capability: 'general', status: 'ready' },
    { id: 'codex-1', name: 'OpenAI Codex', capability: 'coding', status: 'ready' },
    { id: 'claude-1', name: 'Claude Code', capability: 'full-stack', status: 'ready' }
  ]
};

let activeRoutesConfig = { ...DEFAULT_ROUTES };
let lastConfigMtimeMs = 0;

function syncMountedConfig() {
  try {
    if (!fs.existsSync(CONFIG_PATH)) return;
    const stat = fs.statSync(CONFIG_PATH);
    if (stat.mtimeMs === lastConfigMtimeMs) return;
    const raw = fs.readFileSync(CONFIG_PATH, 'utf-8').trim();
    if (!raw) return;
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object' && Object.keys(parsed).length > 0) {
      activeRoutesConfig = {
        ...DEFAULT_ROUTES,
        ...parsed
      };
      lastConfigMtimeMs = stat.mtimeMs;
    }
  } catch (err) {
    console.warn(`[AgentRouter] Could not reload mounted config at ${CONFIG_PATH}:`, err?.message || err);
  }
}

syncMountedConfig();

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
        res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
        res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
        res.setHeader('Vary', 'Origin');
      }
    } catch {}
  }
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    let size = 0;
    req.on('data', chunk => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        req.destroy();
        reject(new Error('Payload too large'));
        return;
      }
      body += chunk;
    });
    req.on('end', () => resolve(body));
    req.on('error', reject);
  });
}

const server = http.createServer(async (req, res) => {
  try {
    applyCors(req, res);

    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }

    let url;
    try {
      url = new URL(req.url || '/', `http://${req.headers.host || '127.0.0.1'}`);
    } catch {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Invalid URL' }));
      return;
    }

    if (url.pathname === '/health' || url.pathname === '/healthz') {
      syncMountedConfig();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'ok', service: 'agent-router', port: PORT, configLoaded: lastConfigMtimeMs > 0 }));
      return;
    }

    syncMountedConfig();

    if (url.pathname === '/v1/models' || url.pathname === '/models') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        object: 'list',
        data: [
          { id: 'agent-router-balanced', object: 'model', owned_by: 'agent-router' },
          { id: 'agent-router-speed', object: 'model', owned_by: 'agent-router' },
          { id: 'agent-router-reasoning', object: 'model', owned_by: 'agent-router' }
        ]
      }));
      return;
    }

    if (url.pathname === '/v1/routes') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(activeRoutesConfig));
      return;
    }

    if ((url.pathname === '/v1/chat/completions' || url.pathname === '/chat/completions') && req.method === 'POST') {
      let body;
      try {
        body = await readBody(req);
      } catch (err) {
        res.writeHead(413, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Payload too large (limit 5MB)' }));
        return;
      }

      try {
        const payload = JSON.parse(body || '{}');
        const model = payload.model || 'agent-router-balanced';

        let targetAgent = 'antigravity-1';
        const prompt = (payload.messages || []).map(m => m.content || '').join('\n');
        if (/code|function|debug|refactor/i.test(prompt)) {
          targetAgent = 'codex-1';
        } else if (/terminal|bash|cli|agent/i.test(prompt)) {
          targetAgent = 'claude-1';
        }

        const reply = {
          id: `chatcmpl-ar-${Date.now()}`,
          object: 'chat.completion',
          created: Math.floor(Date.now() / 1000),
          model,
          agent_router: {
            dispatchedAgent: targetAgent,
            capability: 'autonomous-execution'
          },
          choices: [
            {
              index: 0,
              message: {
                role: 'assistant',
                content: `[Agent Router]: Task analyzed and dispatched to autonomous agent ${targetAgent}.`
              },
              finish_reason: 'stop'
            }
          ],
          usage: {
            prompt_tokens: 40,
            completion_tokens: 20,
            total_tokens: 60
          }
        };

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(reply));
      } catch (err) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err.message }));
      }
      return;
    }

    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Endpoint not found' }));
  } catch (err) {
    if (!res.headersSent) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Internal Server Error' }));
    }
  }
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`[Agent-Router] Dispatcher listening on port ${PORT}`);
});
