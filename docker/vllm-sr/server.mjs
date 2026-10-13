import http from 'http';

const PORT = parseInt(process.env.PORT || '8001', 10);

function inspectPromptGuard(messages) {
  const text = (messages || []).map(m => m.content || '').join('\n');
  const injectionPatterns = [
    /ignore (all )?previous instructions/i,
    /system override/i,
    /disregard (all )?prior/i,
    /jailbreak/i
  ];
  for (const pat of injectionPatterns) {
    if (pat.test(text)) {
      return { passed: false, reason: `Pattern match: ${pat}` };
    }
  }
  return { passed: true };
}

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
    res.end(JSON.stringify({ status: 'ok', service: 'vllm-sr', port: PORT }));
    return;
  }

  if (url.pathname === '/v1/models' || url.pathname === '/models') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      object: 'list',
      data: [
        { id: 'meta-llama/Llama-3-8b-instruct', object: 'model', owned_by: 'vllm-sr' },
        { id: 'mistralai/Mistral-7B-v0.1', object: 'model', owned_by: 'vllm-sr' },
        { id: 'vllm-sr-semantic-guard', object: 'model', owned_by: 'vllm-sr' }
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
        const guardCheck = inspectPromptGuard(payload.messages);

        if (!guardCheck.passed) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            error: {
              message: `vLLM-sr Semantic Guard Violation: ${guardCheck.reason}`,
              type: 'prompt_injection_violation',
              code: 'content_policy_violation'
            }
          }));
          return;
        }

        const model = payload.model || 'meta-llama/Llama-3-8b-instruct';
        const reply = {
          id: `chatcmpl-sr-${Date.now()}`,
          object: 'chat.completion',
          created: Math.floor(Date.now() / 1000),
          model,
          vllm_sr: {
            semantic_guard: 'passed',
            route: 'primary-engine'
          },
          choices: [
            {
              index: 0,
              message: {
                role: 'assistant',
                content: `[vLLM-sr Semantic Router]: Prompt verified clean. Response delivered from ${model}.`
              },
              finish_reason: 'stop'
            }
          ],
          usage: {
            prompt_tokens: 30,
            completion_tokens: 22,
            total_tokens: 52
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
  console.log(`[vLLM-sr] Semantic Router listening on port ${PORT}`);
});
