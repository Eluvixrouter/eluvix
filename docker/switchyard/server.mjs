import http from 'http';

const PORT = parseInt(process.env.PORT || '8080', 10);

function estimateComplexity(messages) {
  if (!messages || messages.length === 0) return { score: 1, label: 'simple' };
  const text = messages.map(m => m.content || '').join('\n');
  const hasCode = /```/g.test(text);
  const hasStructured = /(\{|\[)\s*"[^"]+"\s*:/g.test(text);
  const hasComplexTerms = /\b(architecture|refactor|benchmark|root cause|diagnose|formal verification|complexity|quantum|theorem|optimization)\b/i.test(text);

  if (hasComplexTerms || (hasCode && text.length > 2000)) return { score: 4, label: 'frontier' };
  if (hasCode || hasStructured || text.length > 1000) return { score: 3, label: 'heavy' };
  if (text.length > 200) return { score: 2, label: 'moderate' };
  return { score: 1, label: 'simple' };
}

let activeSwConfig = {
  strategy: 'cost-complexity',
  upstreams: []
};

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
        res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
        res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
        res.setHeader('Vary', 'Origin');
      }
    } catch {}
  }
}

const server = http.createServer(async (req, res) => {
  // CORS restricted to local origins
  applyCors(req, res);

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  const url = new URL(req.url, `http://${req.headers.host}`);

  if (url.pathname === '/' || url.pathname === '/health' || url.pathname === '/healthz') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok', service: 'switchyard', port: PORT }));
    return;
  }

  if (url.pathname === '/v1/config' || url.pathname === '/config') {
    const expectedToken = process.env.SWITCHYARD_AUTH_TOKEN || process.env.ADMIN_PASSWORD;
    if (expectedToken && req.method === 'POST') {
      const authHeader = (req.headers.authorization || '').replace(/^Bearer\s+/i, '').trim();
      if (authHeader !== expectedToken) {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Unauthorized: invalid or missing auth token' }));
        return;
      }
    }

    if (req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(activeSwConfig));
      return;
    }
    if (req.method === 'POST') {
      let body = '';
      req.on('data', chunk => { body += chunk; });
      req.on('end', () => {
        try {
          const parsed = JSON.parse(body || '{}');
          activeSwConfig = { ...activeSwConfig, ...parsed };
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: true, config: activeSwConfig }));
        } catch (err) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: err.message }));
        }
      });
      return;
    }
  }

  if (url.pathname === '/v1/models' || url.pathname === '/models') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      object: 'list',
      data: [
        { id: 'switchyard-auto', object: 'model', owned_by: 'switchyard', tier: 'tier-1' },
        { id: 'deepseek-ai/deepseek-coder-6.7b', object: 'model', owned_by: 'switchyard', tier: 'tier-2' },
        { id: 'codellama/CodeLlama-7b-hf', object: 'model', owned_by: 'switchyard', tier: 'tier-2' }
      ]
    }));
    return;
  }

  if (url.pathname === '/v1/tiers') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      tiers: [
        { id: 'tier-1', name: 'Lemonade / Local Fast', costPer1k: 0.0, maxComplexity: 2 },
        { id: 'tier-2', name: 'Ollama / Local Reasoning', costPer1k: 0.0, maxComplexity: 3 },
        { id: 'tier-3', name: 'Antigravity / Codex', costPer1k: 0.001, maxComplexity: 4 },
        { id: 'tier-4', name: 'Claude Code / Frontier', costPer1k: 0.003, maxComplexity: 4 }
      ],
      defaultStrategy: 'lowest-cost'
    }));
    return;
  }

  if ((url.pathname === '/v1/chat/completions' || url.pathname === '/chat/completions') && req.method === 'POST') {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      try {
        const payload = JSON.parse(body || '{}');
        const complexity = estimateComplexity(payload.messages || []);
        const requestedModel = payload.model || 'switchyard-auto';

        let selectedTier = 'tier-1';
        if (complexity.score >= 4) selectedTier = 'tier-4';
        else if (complexity.score >= 3) selectedTier = 'tier-3';
        else if (complexity.score >= 2) selectedTier = 'tier-2';

        const reply = {
          id: `chatcmpl-sw-${Date.now()}`,
          object: 'chat.completion',
          created: Math.floor(Date.now() / 1000),
          model: requestedModel,
          switchyard: {
            strategy: 'cost-complexity',
            dispatchedTier: selectedTier,
            complexityScore: complexity.score,
            complexityLabel: complexity.label
          },
          choices: [
            {
              index: 0,
              message: {
                role: 'assistant',
                content: `[Switchyard Balancer - Dispatched via ${selectedTier} (Complexity ${complexity.score}/${complexity.label})]: Processing completed for model ${requestedModel}.`
              },
              finish_reason: 'stop'
            }
          ],
          usage: {
            prompt_tokens: 42,
            completion_tokens: 28,
            total_tokens: 70
          }
        };

        if (payload.stream) {
          res.writeHead(200, {
            'Content-Type': 'text/event-stream; charset=utf-8',
            'Cache-Control': 'no-cache, no-transform',
            'Connection': 'keep-alive'
          });
          const id = `chatcmpl-sw-${Date.now()}`;
          const created = Math.floor(Date.now() / 1000);
          const chunkRole = {
            id,
            object: 'chat.completion.chunk',
            created,
            model: requestedModel,
            choices: [{ index: 0, delta: { role: 'assistant', content: '' }, finish_reason: null }]
          };
          res.write(`data: ${JSON.stringify(chunkRole)}\n\n`);

          const chunkContent = {
            id,
            object: 'chat.completion.chunk',
            created,
            model: requestedModel,
            choices: [{ index: 0, delta: { content: reply.choices[0].message.content }, finish_reason: null }]
          };
          res.write(`data: ${JSON.stringify(chunkContent)}\n\n`);

          const chunkStop = {
            id,
            object: 'chat.completion.chunk',
            created,
            model: requestedModel,
            choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
            usage: reply.usage
          };
          res.write(`data: ${JSON.stringify(chunkStop)}\n\n`);
          res.write('data: [DONE]\n\n');
          res.end();
          return;
        }

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
  console.log(`[Switchyard] Balancer listening on port ${PORT}`);
});
