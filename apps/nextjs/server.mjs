import { createServer as createHttpsServer } from 'node:https';
import { createServer as createHttpServer } from 'node:http';
import { createServer as createNetServer } from 'node:net';
import { parse, fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';
import next from 'next';
import { getOrCreateLocalCert, getOrCreateAuthConfig } from '@eluvix/router-core';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// Captured before getOrCreateAuthConfig() propagates the stored password
// into process.env — this is the value the OPERATOR actually set.
const operatorAdminPassword = process.env.ADMIN_PASSWORD;
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

// Deprecation (audit L-4, decision D6): the legacy Enclavix credential is
// honored for this release only, and loudly — a second, silent credential
// is exactly how it survived unnoticed. It migrates on first legacy login
// (see src/lib/legacy-credential.ts) and is removed in the next release.
if (process.env.LEGACY_ADMIN_PASSWORD) {
  console.warn('');
  console.warn('  ⚠ [Security] LEGACY ENCLAVIX CREDENTIAL ACTIVE');
  console.warn('  ⚠ A pre-rename credential from ~/.config/enclavix/auth.json is being honored');
  console.warn('  ⚠ alongside the current admin password. It is DEPRECATED and will be removed');
  console.warn('  ⚠ in the next release. Signing in with it once migrates it automatically;');
  console.warn('  ⚠ to retire it now, delete ~/.config/enclavix/auth.json.');
  console.warn('');
}

// Short operator-chosen passwords are brute-forceable even with login
// throttling; warn, don't block (audit L-3).
if (operatorAdminPassword && operatorAdminPassword.length < 16) {
  console.warn(
    `  ⚠ [Security] ADMIN_PASSWORD is only ${operatorAdminPassword.length} characters. ` +
      'Use at least 16 characters for the admin password.'
  );
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

/**
 * Whether the bind is confined to this machine. Drives decision D5
 * (plain-HTTP /api is refused on non-loopback binds) and the no-TLS
 * fallback (plain HTTP on a network interface is a fatal error, not a
 * silent downgrade — audit H-10).
 */
function isLoopbackBind(host) {
  const h = String(host || '').replace(/^\[|\]$/g, '').toLowerCase();
  return h === 'localhost' || h === '::1' || h.startsWith('127.');
}
const loopbackBind = isLoopbackBind(hostname);
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

function sanitizeRedirectPath(rawUrl) {
  if (!rawUrl || typeof rawUrl !== 'string') return '/';
  let p = rawUrl.replace(/^\/+/, '/');
  p = p.replace(/[\r\n\0]/g, '');
  return p;
}

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
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
          const safePath = sanitizeRedirectPath(req.url);
          const redirectUrl = `https://${hostname}:${currentPort}${safePath}`;
          res.writeHead(301, {
            Location: redirectUrl,
            'Content-Type': 'text/html'
          });
          res.end(`Redirecting to <a href="${escapeHtml(redirectUrl)}">${hostname}</a>...\n`);
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
    // On a loopback bind, serves /api directly for plain HTTP clients
    // (local tooling), while upgrading browser navigation to HTTPS via
    // 308 Permanent Redirect. On a non-loopback bind, decision D5:
    // /api/* gets the 308 too — API credentials must never cross the
    // network in plaintext (audit H-10).
    const httpServer = createHttpServer((req, res) => {
      const parsedUrl = parse(req.url, true);
      if (loopbackBind && parsedUrl.pathname && parsedUrl.pathname.startsWith('/api/')) {
        handle(req, res, parsedUrl);
        return;
      }

      const rawHost = (req.headers.host || '').split(':')[0].toLowerCase();
      const safeHost = (rawHost === 'localhost' || rawHost === '127.0.0.1' || rawHost === '::1' || rawHost === hostname)
        ? (rawHost === 'localhost' ? hostname : rawHost)
        : hostname;
      const safePath = sanitizeRedirectPath(req.url);
      const redirectUrl = `https://${safeHost}:${currentPort}${safePath}`;
      res.writeHead(308, {
        Location: redirectUrl,
        'Content-Type': 'text/html; charset=utf-8',
        Connection: 'close'
      });
      res.end(`Redirecting to <a href="${escapeHtml(redirectUrl)}">HTTPS</a>...\n`);
    });

    httpServer.requestTimeout = 600000;
    httpServer.headersTimeout = 65000;

    httpServer.on('upgrade', (req, socket) => {
      const rawHost = (req.headers.host || '').split(':')[0].toLowerCase();
      const safeHost = (rawHost === 'localhost' || rawHost === '127.0.0.1' || rawHost === '::1' || rawHost === hostname)
        ? (rawHost === 'localhost' ? hostname : rawHost)
        : hostname;
      const safePath = sanitizeRedirectPath(req.url);
      const redirectUrl = `wss://${safeHost}:${currentPort}${safePath}`;
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
      console.log(`  - Dual Protocol: http://${hostname}:${currentPort} and https://${hostname}:${currentPort} share one port (only browser navigation upgrades to HTTPS; /api/ stays plain HTTP by design)`);
      console.log(`  - TLS:          Enabled (mkcert)`);
      // The admin password is never printed (audit H-10): startup logs
      // end up in scrollback, screenshots, and bug reports. The auth
      // file path tells the operator where the credential lives.
      console.log(`  - Admin Pass:   [not printed — stored in ${auth.authFile}]`);
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
    // No TLS available (mkcert missing or generation failed). Serving
    // plain HTTP on a network interface would expose the dashboard, the
    // API, and every credential in transit — that is a fatal startup
    // error, not a fallback (audit H-10). Plain HTTP survives only on a
    // loopback bind, where traffic never leaves the machine.
    if (!loopbackBind) {
      console.error('');
      console.error('  ✖ [Security] TLS unavailable and the bind address is not loopback.');
      console.error(`  ✖ Bind host "${hostname}" would expose the Eluvix dashboard and API over plaintext HTTP`);
      console.error('  ✖ on a network interface. Refusing to start.');
      console.error('  ✖ Fix: install mkcert (https://github.com/FiloSottile/mkcert), or bind to loopback');
      console.error('  ✖ with BIND_HOST=127.0.0.1 if this instance is only used locally.');
      console.error('');
      process.exit(1);
    }

    // Plain HTTP mode on loopback only (mkcert not available)
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
      console.log(`  - TLS:          Disabled (loopback bind only — plaintext HTTP is confined to this machine; install mkcert for TLS)`);
      console.log(`  - Admin Pass:   [not printed — stored in ${auth.authFile}]`);
      console.log(`  - Config Path:  ${auth.authFile}\n`);
    });
  }
}

startServer().catch((err) => {
  console.error('Failed to start server:', err);
  process.exit(1);
});
