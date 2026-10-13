import http from 'http';

const PORT = parseInt(process.env.PORT || '8002', 10);

const server = http.createServer(async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  const url = new URL(req.url, `http://${req.headers.host}`);

  if (url.pathname === '/health' || url.pathname === '/healthz') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok', service: 'agent-router', port: PORT }));
    return;
  }

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
    res.end(JSON.stringify({
      preference: 'balanced',
      agents: [
        { id: 'antigravity-1', name: 'Google Antigravity', capability: 'general', status: 'ready' },
        { id: 'codex-1', name: 'OpenAI Codex', capability: 'coding', status: 'ready' },
        { id: 'claude-1', name: 'Claude Code', capability: 'full-stack', status: 'ready' }
      ]
    }));
    return;
  }

  if ((url.pathname === '/v1/chat/completions' || url.pathname === '/chat/completions') && req.method === 'POST') {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
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
    });
    return;
  }

  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: 'Endpoint not found' }));
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`[Agent-Router] Dispatcher listening on port ${PORT}`);
});
