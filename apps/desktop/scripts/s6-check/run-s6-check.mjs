#!/usr/bin/env node
/**
 * S-6 settling check — HTTP layer (security audit C-1 / H-12 / H-13).
 *
 * Starts the REAL DesktopRouterServer (built dist) under plain node with
 * an isolated XDG config dir, then fires the requests a drive-by website
 * or a token-less local process would make, and asserts the post-fix
 * responses. Run the Electron companion (run-s6-electron.cjs) for the
 * real-browser half.
 *
 * Usage: node apps/desktop/scripts/s6-check/run-s6-check.mjs
 * Exit code 0 = every case behaved as required post-fix.
 */
import fs from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

// Isolated app state BEFORE router-core is loaded (getAppPaths reads the
// XDG env lazily per call, so setting it here is sufficient).
const xdgRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'eluvix-s6-xdg-'));
process.env.XDG_CONFIG_HOME = path.join(xdgRoot, 'config');
process.env.XDG_DATA_HOME = path.join(xdgRoot, 'data');

const require = createRequire(import.meta.url);
const { DesktopRouterServer } = require('../../dist/main/server.js');

const PORT = 39117;
const EVIL_ORIGIN = 'https://evil.example';
const results = [];

function check(name, ok, detail) {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name} — ${detail}`);
}

function request({ port, isHttps, method, path: reqPath, headers = {}, body }) {
  return new Promise((resolve, reject) => {
    const mod = isHttps ? https : http;
    const req = mod.request(
      { host: '127.0.0.1', port, method, path: reqPath, headers, rejectUnauthorized: false },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () =>
          resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString('utf8') })
        );
      }
    );
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

const server = new DesktopRouterServer(PORT);
await server.start();
const isHttps = server.getIsHttps();
const token = server.getDesktopToken();
const tokenFile = server.getDesktopTokenFile();
const markerConfig = JSON.stringify({
  upstreams: [{ id: 'pwned', name: 'pwned', endpoint: 'http://evil.example', models: ['*'], priority: 1 }]
});
const base = { port: PORT, isHttps };

try {
  const mode = fs.statSync(tokenFile).mode & 0o777;
  check('token file is 0o600 inside the isolated config dir',
    mode === 0o600 && tokenFile.startsWith(xdgRoot) && token.length >= 32,
    `mode=${mode.toString(8)} file=${tokenFile}`);

  let r = await request({ ...base, method: 'POST', path: '/api/config',
    headers: { Origin: EVIL_ORIGIN, 'Content-Type': 'application/json' }, body: markerConfig });
  check('cross-origin POST /api/config (no token) rejected', r.status === 403, `HTTP ${r.status}`);

  r = await request({ ...base, method: 'OPTIONS', path: '/api/config',
    headers: { Origin: EVIL_ORIGIN, 'Access-Control-Request-Method': 'POST' } });
  check('cross-origin preflight rejected', r.status === 403, `HTTP ${r.status}`);

  r = await request({ ...base, method: 'POST', path: '/api/config',
    headers: { 'Content-Type': 'application/json' }, body: markerConfig });
  check('token-less POST /api/config rejected', r.status === 401, `HTTP ${r.status}`);

  r = await request({ ...base, method: 'GET', path: '/v1/models' });
  check('token-less GET /v1/models rejected', r.status === 401, `HTTP ${r.status}`);

  r = await request({ ...base, method: 'GET', path: '/health' });
  check('token-less GET /health rejected (auth on EVERY route)', r.status === 401, `HTTP ${r.status}`);

  r = await request({ ...base, method: 'POST', path: '/api/config',
    headers: { Origin: EVIL_ORIGIN, 'Content-Type': 'application/json', 'x-eluvix-desktop-token': token },
    body: markerConfig });
  check('valid token does NOT rescue an untrusted Origin', r.status === 403, `HTTP ${r.status}`);

  r = await request({ ...base, method: 'GET', path: '/api/config',
    headers: { Host: 'evil.example', 'x-eluvix-desktop-token': token } });
  check('rebound Host rejected even with a valid token', r.status === 403, `HTTP ${r.status}`);

  r = await request({ ...base, method: 'GET', path: '/api/config',
    headers: { 'x-eluvix-desktop-token': token } });
  let configIntact = false;
  try {
    const cfg = JSON.parse(r.body);
    configIntact = r.status === 200 && !(cfg.upstreams || []).some((u) => u.id === 'pwned');
  } catch {}
  check('authed GET /api/config works and the drive-by never landed',
    configIntact, `HTTP ${r.status}, pwned upstream present: ${!configIntact && r.status === 200}`);

  r = await request({ ...base, method: 'GET', path: '/api/config',
    headers: { Authorization: `Bearer ${token}` } });
  check('Bearer form accepted (OpenAI-compatible CLI tools)', r.status === 200, `HTTP ${r.status}`);

  r = await request({ ...base, method: 'POST', path: '/api/config',
    headers: { 'Content-Type': 'application/json', 'x-eluvix-desktop-token': token },
    body: 'x'.repeat(10 * 1024 * 1024 + 1) });
  check('oversized body rejected with 413 (L-12 cap)', r.status === 413, `HTTP ${r.status}`);
} finally {
  await server.stop();
  fs.rmSync(xdgRoot, { recursive: true, force: true });
}

const failed = results.filter((r) => !r.ok);
console.log(`\nS-6 HTTP check: ${results.length - failed.length}/${results.length} cases passed (transport: ${isHttps ? 'HTTPS' : 'HTTP — mkcert unavailable in this environment'})`);
process.exit(failed.length ? 1 : 0);
