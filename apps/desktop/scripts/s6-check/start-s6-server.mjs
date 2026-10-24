#!/usr/bin/env node
/**
 * S-6 companion: start the REAL DesktopRouterServer (built dist) under
 * plain node with an isolated XDG config dir, publish {port, token,
 * tokenFile, isHttps} as JSON to $S6_INFO_FILE (default
 * /tmp/eluvix-s6-server.json), and stay alive until SIGTERM/SIGINT.
 * Used by run-s6-electron.cjs, which cannot load the server itself:
 * Electron 31's Node 20 rejects require() of router-core's ESM dist
 * (ERR_REQUIRE_ESM) — a pre-existing packaging incompatibility, unrelated
 * to the lockdown. The server code exercised is byte-identical either way.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const xdgRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'eluvix-s6-server-xdg-'));
process.env.XDG_CONFIG_HOME = path.join(xdgRoot, 'config');
process.env.XDG_DATA_HOME = path.join(xdgRoot, 'data');

const require = createRequire(import.meta.url);
const { DesktopRouterServer } = require('../../dist/main/server.js');

const server = new DesktopRouterServer(39117);
await server.start();

const info = {
  port: server.getPort(),
  isHttps: server.getIsHttps(),
  token: server.getDesktopToken(),
  tokenFile: server.getDesktopTokenFile(),
  xdgRoot
};
fs.writeFileSync(process.env.S6_INFO_FILE || '/tmp/eluvix-s6-server.json', JSON.stringify(info));
console.log(`S6-SERVER-READY ${JSON.stringify(info)}`);

const shutdown = async () => {
  try { await server.stop(); } catch {}
  fs.rmSync(xdgRoot, { recursive: true, force: true });
  process.exit(0);
};
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
