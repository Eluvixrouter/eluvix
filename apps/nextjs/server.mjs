import { createServer as createHttpsServer } from 'node:https';
import { createServer as createHttpServer } from 'node:http';
import { createServer as createNetServer } from 'node:net';
import { parse, fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';
import next from 'next';
import { getOrCreateLocalCert, getOrCreateAuthConfig } from '@eluvix/router-core';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const auth = getOrCreateAuthConfig();

if (!process.env.ADMIN_PASSWORD) {
  process.env.ADMIN_PASSWORD = auth.adminPassword;
}
if (!process.env.NEXTAUTH_SECRET) {
  process.env.NEXTAUTH_SECRET = auth.nextAuthSecret;
}
if (!process.env.LEGACY_ADMIN_PASSWORD) {
  try {
    const home = process.env.HOME || '';
    if (home) {
      const legacyPath = path.join(home, '.config', 'enclavix', 'auth.json');
      if (fs.existsSync(legacyPath)) {
        const parsed = JSON.parse(fs.readFileSync(legacyPath, 'utf8'));
        if (parsed.adminPassword) {
          process.env.LEGACY_ADMIN_PASSWORD = parsed.adminPassword;
        }
      }
    }
  } catch {}
}

function resolveHost() {
  const envHost = process.env.ELUVIX_HOST;
  if (envHost) return envHost;
  const raw = process.env.HOSTNAME || '';
  // Fall back to loopback if HOSTNAME is empty, '0.0.0.0', or a Docker hex container ID
  if (!raw || /^[0-9a-f]{12,}$/i.test(raw) || raw === '0.0.0.0') {
    return '127.0.0.1';
  }
  return raw;
}

const dev = process.env.NODE_ENV !== 'production';
const hostname = process.env.BIND_HOST || resolveHost();
const httpsPort = parseInt(process.env.PORT || '3588', 10);
// HTTP redirect port (default 3580, or customizable via HTTP_PORT)
const httpPort = parseInt(process.env.HTTP_PORT || '3580', 10);

if (!process.env.NEXTAUTH_URL) {
  process.env.NEXTAUTH_URL = `https://${hostname}:${httpsPort}`;
}

// In development mode, clean any stale production build artifacts to prevent CSS/manifest mismatches
if (dev) {
  const buildIdPath = path.join(__dirname, '.next', 'BUILD_ID');
  if (fs.existsSync(buildIdPath)) {
    console.log('[Dev] Clearing stale production .next artifacts for clean development styling...');
    try {
      fs.rmSync(path.join(__dirname, '.next'), { recursive: true, force: true });
    } catch {}
  }
}

const app = next({ dev, dir: __dirname, hostname, port: httpsPort });
const handle = app.getRequestHandler();

async function startServer() {
  await app.prepare();

  const certs = getOrCreateLocalCert(['localhost', '127.0.0.1', '::1', 'eluvix.local']);

  if (certs) {
    let currentPort = httpsPort;

    // 1. Primary HTTPS server for Next.js
    const httpsServer = createHttpsServer(
      { key: certs.key, cert: certs.cert },
      (req, res) => {
        // Redirect localhost to 127.0.0.1 to avoid NextAuth host mismatch issues
        if (req.headers.host && req.headers.host.startsWith('localhost:')) {
          const redirectUrl = `https://${hostname}:${currentPort}${req.url}`;
          res.writeHead(301, {
            Location: redirectUrl,
            'Content-Type': 'text/html'
          });
          res.end(`Redirecting to <a href="${redirectUrl}">${hostname}</a>...\n`);
          return;
        }

        if (!req.headers['x-forwarded-proto']) {
          req.headers['x-forwarded-proto'] = 'https';
        }
        if (!req.headers['x-forwarded-host'] && req.headers.host) {
          req.headers['x-forwarded-host'] = req.headers.host;
        }
        const parsedUrl = parse(req.url, true);
        handle(req, res, parsedUrl);
      }
    );

    httpsServer.requestTimeout = 600000; // 10 mins for heavy LLM generations
    httpsServer.headersTimeout = 65000;

    httpsServer.on('clientError', (err, socket) => {
      if (socket && socket.writable) {
        try {
          socket.end('HTTP/1.1 400 Bad Request\r\n\r\n');
        } catch {}
      }
    });

    // 2. HTTP Server for Auto-Upgrade / Redirects
    // Serves /api directly for plain HTTP clients, while upgrading browser navigation to HTTPS via 308 Permanent Redirect
    const httpServer = createHttpServer((req, res) => {
      const parsedUrl = parse(req.url, true);
      if (parsedUrl.pathname && parsedUrl.pathname.startsWith('/api/')) {
        handle(req, res, parsedUrl);
        return;
      }

      const rawHost = (req.headers.host || '').split(':')[0].toLowerCase();
      const safeHost = (rawHost === 'localhost' || rawHost === '127.0.0.1' || rawHost === '::1' || rawHost === hostname)
        ? (rawHost === 'localhost' ? hostname : rawHost)
        : hostname;
      const redirectUrl = `https://${safeHost}:${currentPort}${req.url}`;
      res.writeHead(308, {
        Location: redirectUrl,
        'Content-Type': 'text/html; charset=utf-8',
        Connection: 'close'
      });
      res.end(`Redirecting to <a href="${redirectUrl}">HTTPS</a>...\n`);
    });

    httpServer.requestTimeout = 600000;
    httpServer.headersTimeout = 65000;

    httpServer.on('upgrade', (req, socket) => {
      const rawHost = (req.headers.host || '').split(':')[0].toLowerCase();
      const safeHost = (rawHost === 'localhost' || rawHost === '127.0.0.1' || rawHost === '::1' || rawHost === hostname)
        ? (rawHost === 'localhost' ? hostname : rawHost)
        : hostname;
      const redirectUrl = `wss://${safeHost}:${currentPort}${req.url}`;
      socket.write(`HTTP/1.1 308 Permanent Redirect\r\nLocation: ${redirectUrl}\r\nConnection: close\r\n\r\n`);
      socket.destroy();
    });

    // 3. Dual-Protocol Demuxing Gateway on port 3588
    // Sniffs the first byte: 0x16 is TLS ClientHello -> httpsServer; otherwise plain HTTP -> httpServer
    const gateServer = createNetServer((socket) => {
      socket.on('error', () => {
        try { socket.destroy(); } catch {}
      });
      socket.setTimeout(10000, () => {
        try { socket.destroy(); } catch {}
      });
      socket.once('readable', () => {
        socket.setTimeout(0);
        const firstByte = socket.read(1);
        if (!firstByte) {
          try { socket.destroy(); } catch {}
          return;
        }
        socket.unshift(firstByte);
        if (firstByte[0] === 0x16) {
          httpsServer.emit('connection', socket);
        } else {
          httpServer.emit('connection', socket);
        }
      });
    });

    gateServer.on('error', (err) => {
      if (err.code === 'EADDRINUSE') {
        const nextPort = currentPort + 1;
        console.warn(`Port ${currentPort} is in use, trying ${nextPort}...`);
        currentPort = nextPort;
        gateServer.listen(currentPort, hostname);
      } else {
        console.error(err);
      }
    });

    gateServer.listen(currentPort, hostname, () => {
      process.env.NEXTAUTH_URL = `https://${hostname}:${currentPort}`;

      console.log(`\n  ▲ Next.js 14.2.35`);
      console.log(`  - Local:        https://${hostname}:${currentPort}`);
      console.log(`  - Auto-Upgrade: http://${hostname}:${currentPort} ➔ https://${hostname}:${currentPort} (Same-Port Dual Protocol)`);
      console.log(`  - TLS:          Enabled (mkcert)`);
      console.log(`  - Admin Pass:   ${auth.adminPassword}`);
      console.log(`  - Config Path:  ${auth.authFile}`);

      // Optional extra redirect port for HTTP_PORT (default 3580)
      if (httpPort && httpPort !== currentPort) {
        httpServer.on('error', (err) => {
          if (err.code !== 'EADDRINUSE') {
            console.warn('[HTTP Redirect Server]', err.message);
          }
        });

        httpServer.listen(httpPort, hostname, () => {
          console.log(`  - Extra HTTP:   http://${hostname}:${httpPort} ➔ https://${hostname}:${currentPort}\n`);
        });
      } else {
        console.log('');
      }
    });
  } else {
    // Plain HTTP mode if mkcert is not available
    let currentHttpPort = httpsPort;
    const server = createHttpServer((req, res) => {
      const parsedUrl = parse(req.url, true);
      handle(req, res, parsedUrl);
    });

    server.on('error', (err) => {
      if (err.code === 'EADDRINUSE') {
        const nextPort = currentHttpPort + 1;
        console.warn(`Port ${currentHttpPort} is in use, trying ${nextPort}...`);
        currentHttpPort = nextPort;
        server.listen(currentHttpPort, hostname);
      } else {
        console.error(err);
      }
    });

    server.listen(currentHttpPort, hostname, () => {
      process.env.NEXTAUTH_URL = `http://${hostname}:${currentHttpPort}`;
      console.log(`\n  ▲ Next.js 14.2.35`);
      console.log(`  - Local:        http://${hostname}:${currentHttpPort}`);
      console.log(`  - TLS:          Disabled`);
      console.log(`  - Admin Pass:   ${auth.adminPassword}`);
      console.log(`  - Config Path:  ${auth.authFile}\n`);
    });
  }
}

startServer().catch((err) => {
  console.error('Failed to start server:', err);
  process.exit(1);
});
