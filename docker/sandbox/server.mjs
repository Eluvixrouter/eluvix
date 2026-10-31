import http from 'node:http';
import vm from 'node:vm';

const PORT = Number(process.env.PORT || 3986);
const MAX_SIZE = 2 * 1024 * 1024; // 2 MB limit
const EXPECTED_INTERNAL_TOKEN = process.env.SANDBOX_AUTH_TOKEN;

function isLocalOrigin(origin) {
  try {
    const u = new URL(origin);
    const host = u.hostname.replace(/^\[|\]$/g, '');
    return (
      host === 'localhost' ||
      host === '127.0.0.1' ||
      host === '::1' ||
      u.protocol === 'app:' ||
      u.protocol === 'vscode-webview:'
    );
  } catch {
    return false;
  }
}

function parseBody(req) {
  return new Promise((resolve, reject) => {
    let raw = '';
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

  // Restrict to internal: validate Host header against DNS rebinding
  const host = (req.headers.host || '').split(':')[0].toLowerCase();
  const allowedHosts = new Set(['localhost', '127.0.0.1', '::1', 'sandbox', 'eluvix-sandbox']);
  if (!allowedHosts.has(host) && !host.endsWith('.internal')) {
    res.statusCode = 403;
    res.end(JSON.stringify({ error: 'Forbidden host: sandbox is restricted to internal callers' }));
    return;
  }

  // Restrict to internal: block external cross-origin requests
  const origin = req.headers.origin;
  if (origin && origin !== 'null' && !isLocalOrigin(origin)) {
    res.statusCode = 403;
    res.end(JSON.stringify({ error: 'External cross-origin requests forbidden' }));
    return;
  }

  // Internal token verification if SANDBOX_AUTH_TOKEN is configured
  if (EXPECTED_INTERNAL_TOKEN) {
    const authHeader = req.headers.authorization || '';
    const token = req.headers['x-sandbox-token'] || 
      (authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null);
    if (!token || token !== EXPECTED_INTERNAL_TOKEN) {
      res.statusCode = 401;
      res.end(JSON.stringify({ error: 'Unauthorized: invalid sandbox internal token' }));
      return;
    }
  }

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
      res.end(JSON.stringify({ exitCode: 1, stderr: 'Payload too large (limit 2MB)' }));
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
      // Safely serialize logs inside VM realm to prevent host prototype pollution
      let logs = [];
      try {
        const rawJson = vm.runInContext('JSON.stringify(this.logs)', context);
        logs = JSON.parse(rawJson || '[]');
      } catch {
        logs = [];
      }
      res.end(JSON.stringify({
        exitCode: 0,
        stdout: Array.isArray(logs) ? logs.join('\n') : '',
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
