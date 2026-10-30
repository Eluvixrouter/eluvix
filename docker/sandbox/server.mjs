import http from 'node:http';
import vm from 'node:vm';

const PORT = Number(process.env.PORT || 3986);

function parseBody(req) {
  return new Promise((resolve, reject) => {
    let raw = '';
    const MAX_SIZE = 1024 * 1024; // 1 MB limit
    req.on('data', (chunk) => {
      raw += chunk;
      if (raw.length > MAX_SIZE) {
        req.destroy();
        reject(new Error('Payload too large'));
      }
    });
    req.on('end', () => {
      try { resolve(raw ? JSON.parse(raw) : {}); } catch { resolve({}); }
    });
    req.on('error', reject);
  });
}

const server = http.createServer(async (req, res) => {
  res.setHeader('Content-Type', 'application/json');
  if (req.method === 'GET' && req.url === '/health') {
    res.end(JSON.stringify({ status: 'ok', service: 'eluvix-sandbox', runtime: 'isolated-vm' }));
    return;
  }
  if (req.method === 'POST' && req.url === '/v1/execute') {
    let body;
    try {
      body = await parseBody(req);
    } catch {
      res.statusCode = 413;
      res.end(JSON.stringify({ exitCode: 1, stderr: 'Payload too large (limit 1MB)' }));
      return;
    }
    const code = String(body.code || '');
    const timeoutMs = Math.min(30000, Math.max(500, Number(body.timeoutMs || 5000)));
    const start = Date.now();
    try {
      const context = vm.createContext(Object.create(null));
      vm.runInContext(`
        this.Math = Math;
        this.JSON = JSON;
        this.Date = Date;
        this.logs = [];
        this.console = {
          log: (...args) => this.logs.push(args.map(String).join(' ')),
          error: (...args) => this.logs.push(args.map(String).join(' '))
        };
      `, context);
      const result = vm.runInContext(code, context, { timeout: timeoutMs });
      const logs = Array.from(vm.runInContext('this.logs', context) || []);
      res.end(JSON.stringify({
        exitCode: 0,
        stdout: logs.join('\n'),
        result: result !== undefined ? String(result) : undefined,
        durationMs: Date.now() - start
      }));
    } catch (err) {
      res.end(JSON.stringify({
        exitCode: 1,
        stdout: '',
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
