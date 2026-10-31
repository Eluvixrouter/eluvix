// ============================================================================
// SIMULATOR — not a real Agentgateway service.
//
// This is a canned-response stand-in used for local development of the
// Eluvix dashboard and orchestration flows. It mimics the shape of the
// Agentgateway HTTP API with hardcoded/heuristic replies; no model is loaded
// and no real inference or routing happens here. Do not benchmark,
// demo, or draw conclusions about the real service from its responses.
// See docker/README.md.
// ============================================================================
import http from 'http';

const PORT = parseInt(process.env.PORT || '8003', 10);
const MAX_BODY_BYTES = 5 * 1024 * 1024; // 5 MB

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
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'ok', service: 'agentgateway', port: PORT }));
      return;
    }

    if (url.pathname === '/v1/models' || url.pathname === '/models') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        object: 'list',
        data: [
          { id: 'agentgateway-mcp', object: 'model', owned_by: 'agentgateway' },
          { id: 'agentgateway-a2a', object: 'model', owned_by: 'agentgateway' }
        ]
      }));
      return;
    }

    if (url.pathname === '/v1/gateways' || url.pathname === '/gateways') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        gateways: [
          {
            id: 'agentgateway-primary',
            accessPolicy: 'restrictive',
            protocols: ['mcp', 'a2a'],
            activeConnections: 3,
            mcpEndpoints: ['/mcp/tools', '/mcp/resources']
          }
        ]
      }));
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
        const model = payload.model || 'agentgateway-mcp';

        const reply = {
          id: `chatcmpl-gw-${Date.now()}`,
          object: 'chat.completion',
          created: Math.floor(Date.now() / 1000),
          model,
          agent_gateway: {
            policy: 'restrictive',
            verifiedProtocols: ['mcp', 'a2a']
          },
          choices: [
            {
              index: 0,
              message: {
                role: 'assistant',
                content: `[Agent Gateway - MCP/A2A Verified]: Access policy enforced. Protocol bridge routed to model ${model}.`
              },
              finish_reason: 'stop'
            }
          ],
          usage: {
            prompt_tokens: 38,
            completion_tokens: 24,
            total_tokens: 62
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
  console.log(`[Agent-Gateway] Gateway listening on port ${PORT}`);
});
