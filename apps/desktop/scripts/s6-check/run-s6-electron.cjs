/**
 * S-6 settling check — real-browser half (security audit C-1).
 *
 * Run the server first (start-s6-server.mjs, plain node), then:
 *   xvfb-run -a <electron> --no-sandbox run-s6-electron.cjs
 *
 * This script serves attacker.html from http://127.0.0.2:39118 — a
 * genuinely different origin whose host is NOT on the server's local
 * allowlist (only 127.0.0.1 exactly is). A DNS name would be the more
 * faithful stand-in for a public website, but this sandbox's resolver is
 * a fake-IP wildcard, so a second loopback address is the reliable
 * untrusted origin here. The script lets
 * the page perform its drive-by fetches against the running server in a
 * real Chromium, then reads the server config back WITH the token and
 * asserts the drive-by never landed.
 *
 * Exit code 0 = page attempts all failed and config unchanged.
 */
const fs = require('node:fs');
const http = require('node:http');
const https = require('node:https');
const path = require('node:path');

const { app, BrowserWindow } = require('electron');
app.disableHardwareAcceleration();

// Hard watchdog: never hang the harness.
setTimeout(() => {
  console.error('S-6 electron check: watchdog timeout');
  app.exit(2);
}, 60000);

const info = JSON.parse(
  fs.readFileSync(process.env.S6_INFO_FILE || '/tmp/eluvix-s6-server.json', 'utf8')
);
const ATTACKER_PORT = 39118;

function authedGetConfig() {
  const mod = info.isHttps ? https : http;
  return new Promise((resolve, reject) => {
    const req = mod.request(
      { host: '127.0.0.1', port: info.port, method: 'GET', path: '/api/config',
        headers: { 'x-eluvix-desktop-token': info.token }, rejectUnauthorized: false },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString('utf8') }));
      }
    );
    req.on('error', reject);
    req.end();
  });
}

app.whenReady().then(async () => {
  let exitCode = 1;
  const attackerServer = http.createServer((req, res) => {
    try {
      console.log(`attacker server: ${req.method} ${req.url} (host ${req.headers.host})`);
      const html = fs.readFileSync(path.join(__dirname, 'attacker.html'));
      res.writeHead(200, { 'Content-Type': 'text/html', 'Content-Length': html.length });
      res.end(html);
    } catch (err) {
      console.error('attacker server handler error:', err);
      try { res.writeHead(500); res.end('handler error'); } catch {}
    }
  });
  attackerServer.on('error', (err) => console.error('attacker server error:', err));

  try {
    await new Promise((r) => attackerServer.listen(ATTACKER_PORT, '127.0.0.2', r));

    const win = new BrowserWindow({ show: false, webPreferences: { offscreen: true } });
    await win.loadURL(`http://127.0.0.2:${ATTACKER_PORT}/attacker.html`);

    const deadline = Date.now() + 30000;
    let pageResults = '';
    while (Date.now() < deadline) {
      if (win.webContents.getTitle() === 'S6-DONE') {
        pageResults = await win.webContents.executeJavaScript(
          "document.getElementById('results').textContent"
        );
        break;
      }
      await new Promise((r) => setTimeout(r, 250));
    }
    console.log('--- attacker page results (real Chromium, origin http://127.0.0.2:39118) ---');
    console.log(pageResults || '(page did not finish in time)');
    console.log('----------------------------------------------------------------------------');

    const attemptsBlocked =
      !!pageResults &&
      !/HTTP 200/.test(pageResults) &&
      (pageResults.match(/FETCH-REJECTED|HTTP 40[13]/g) || []).length >= 3;

    const readback = await authedGetConfig();
    let configIntact = false;
    try {
      const cfg = JSON.parse(readback.body);
      configIntact = readback.status === 200 && !(cfg.upstreams || []).some((u) => u.id === 'pwned');
    } catch {}

    console.log(`page attempts all blocked: ${attemptsBlocked ? 'PASS' : 'FAIL'}`);
    console.log(`config unchanged after drive-by: ${configIntact ? 'PASS' : 'FAIL'} (read-back HTTP ${readback.status})`);
    exitCode = attemptsBlocked && configIntact ? 0 : 1;
  } catch (err) {
    console.error('S-6 electron check error:', err);
  } finally {
    attackerServer.close();
    app.exit(exitCode);
  }
});
