import http from 'node:http';
import vm from 'node:vm';

const PORT = Number(process.env.PORT || 3986);

function parseBody(req) {
  return new Promise((resolve) => {
    let raw = '';
    req.on('data', (chunk) => { raw += chunk; });
    req.on('end', () => {
      try { resolve(raw ? JSON.parse(raw) : {}); } catch { resolve({}); }
    });
  });
}

const server = http.createServer(async (req, res) => {
  res.setHeader('Content-Type', 'application/json');
  if (req.method === 'GET' && req.url === '/health') {
    res.end(JSON.stringify({ status: 'ok', service: 'eluvix-sandbox', runtime: 'isolated-vm' }));
    return;
  }
  if (req.method === 'POST' && req.url === '/v1/execute') {
    const body = await parseBody(req);
    const code = String(body.code || '');
    const timeoutMs = Math.min(30000, Math.max(500, Number(body.timeoutMs || 5000)));
    const logs = [];
    const start = Date.now();
    try {
      const sandboxConsole = {
        log: (...args) => logs.push(args.map(String).join(' ')),
        error: (...args) => logs.push(args.map(String).join(' '))
      };
      const context = vm.createContext({ console: sandboxConsole, Math, JSON, Date });
      const result = vm.runInContext(code, context, { timeout: timeoutMs });
      res.end(JSON.stringify({
        exitCode: 0,
        stdout: logs.join('\n'),
        result: result !== undefined ? String(result) : undefined,
        durationMs: Date.now() - start
      }));
    } catch (err) {
      res.end(JSON.stringify({
        exitCode: 1,
        stdout: logs.join('\n'),
        stderr: err instanceof Error ? err.message : String(err),
        durationMs: Date.now() - start
      }));
    }
    return;
  }
  res.statusCode = 404;
  res.end(JSON.stringify({ error: 'Not found' }));
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`[Eluvix Sandbox Sidecar] Listening on :${PORT}`);
});
