import http from 'http';

const PORT = parseInt(process.env.PORT || '8000', 10);

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
    res.end(JSON.stringify({ status: 'ok', service: 'vllm', port: PORT }));
    return;
  }

  if (url.pathname === '/v1/models' || url.pathname === '/models') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      object: 'list',
      data: [
        { id: 'meta-llama/Llama-3-8b', object: 'model', owned_by: 'vllm' },
        { id: 'meta-llama/Llama-3-70b', object: 'model', owned_by: 'vllm' },
        { id: 'mistralai/Mistral-7B-Instruct-v0.3', object: 'model', owned_by: 'vllm' }
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
        const model = payload.model || 'meta-llama/Llama-3-8b';

        const reply = {
          id: `chatcmpl-vllm-${Date.now()}`,
          object: 'chat.completion',
          created: Math.floor(Date.now() / 1000),
          model,
          choices: [
            {
              index: 0,
              message: {
                role: 'assistant',
                content: `[vLLM Inference Engine]: Successfully generated response with model ${model}.`
              },
              finish_reason: 'stop'
            }
          ],
          usage: {
            prompt_tokens: 35,
            completion_tokens: 25,
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
  console.log(`[vLLM] Inference Engine listening on port ${PORT}`);
});
