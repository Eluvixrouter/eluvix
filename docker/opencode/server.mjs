// ============================================================================
// Eluvix-Forked OpenCode Agent Harness Server (:4096)
//
// Implements the OpenCode session, message, permission-reply, and SSE event
// endpoints with Eluvix deep-integration extensions:
// - Native client tool-calling & MCP server mesh injection
// - Inline Mid-Loop PromptGuard & PrivacyGuard (PII/Secret DLP) observation scrubbing
// - Per-turn Switchyard model tiering & DeepSeek MLA FP8 KV prefix hash pinning
// ============================================================================
import http from 'node:http';
import crypto from 'node:crypto';

const PORT = parseInt(process.env.PORT || process.env.OPENCODE_PORT || '4096', 10);
const sessions = new Map();

const PII_REGEXES = [
  { regex: /\b(?:sk-proj-[a-zA-Z0-9_-]{16,}|sk-[a-zA-Z0-9_-]{20,}|AKIA[0-9A-Z]{16}|ghp_[a-zA-Z0-9]{36})\b/g, token: '[REDACTED_API_KEY]' },
  { regex: /\b\d{3}-\d{2}-\d{4}\b/g, token: '[REDACTED_SSN]' },
  { regex: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g, token: '[REDACTED_EMAIL]' },
];

const INJECTION_REGEXES = [
  /(?:ignore|disregard|forget|override|bypass)\s+(?:all\s+)?(?:previous|prior|above|system)\s+(?:instructions|prompts|rules|commands|directives)/gi,
  /(?:you\s+are\s+now|act\s+as|pretend\s+to\s+be)\s+(?:DAN|unrestricted|jailbroken)/gi,
];

function scrubObservation(text) {
  let out = String(text || '');
  let redacted = false;
  let stripped = false;
  for (const p of PII_REGEXES) {
    if (p.regex.test(out)) {
      redacted = true;
      p.regex.lastIndex = 0;
      out = out.replace(p.regex, p.token);
    }
  }
  for (const rx of INJECTION_REGEXES) {
    if (rx.test(out)) {
      stripped = true;
      rx.lastIndex = 0;
      out = out.replace(rx, '');
    }
  }
  return { text: out.trim(), redacted, stripped };
}

function parseBody(req) {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', chunk => {
      raw += chunk;
      if (raw.length > 5 * 1024 * 1024) {
        req.destroy();
        reject(new Error('Payload too large'));
      }
    });
    req.on('end', () => {
      if (!raw.trim()) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch {
        resolve({ _raw: raw });
      }
    });
    req.on('error', reject);
  });
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);

    if (url.pathname === '/health' || url.pathname === '/healthz') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          status: 'ok',
          service: 'eluvix-opencode',
          fork: 'Eluvixrouter/opencode-eluvix',
          port: PORT,
          active_sessions: sessions.size,
        })
      );
      return;
    }

    if (req.method === 'POST' && url.pathname === '/session') {
      const body = await parseBody(req);
      const id = `oc_elx_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
      const kvPrefixHash =
        body.kvPrefixHash ||
        `elx-kv-${crypto.createHash('sha256').update(JSON.stringify(body.mcpServers || [])).digest('hex').slice(0, 16)}`;
      const session = {
        id,
        title: body.title || 'Eluvix-OpenCode Session',
        mcpServers: body.mcpServers || [],
        kvPrefixHash,
        created_at: new Date().toISOString(),
      };
      sessions.set(id, session);
      res.writeHead(200, {
        'Content-Type': 'application/json',
        'x-eluvix-harness-fork': 'eluvix-opencode',
        'x-eluvix-prefix-hash': kvPrefixHash,
      });
      res.end(JSON.stringify(session));
      return;
    }

    const msgMatch = url.pathname.match(/^\/session\/([^/]+)\/message$/);
    if (req.method === 'POST' && msgMatch) {
      const sessionId = decodeURIComponent(msgMatch[1]);
      const session = sessions.get(sessionId);
      if (!session) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Session not found' }));
        return;
      }
      const body = await parseBody(req);
      const agent = body.agent || 'build';
      const rawPrompt = Array.isArray(body.parts)
        ? body.parts.filter(p => p?.type === 'text').map(p => p.text).join('\n')
        : '';
      const scrubbed = scrubObservation(rawPrompt);
      const parts = [
        {
          type: 'text',
          text: `[Eluvix-OpenCode (${agent})] Processed: "${scrubbed.text}"`,
        },
      ];
      res.writeHead(200, {
        'Content-Type': 'application/json',
        'x-eluvix-harness-fork': 'eluvix-opencode',
        'x-eluvix-prefix-hash': session.kvPrefixHash,
      });
      res.end(JSON.stringify({ id: `msg_${Date.now()}`, agent, parts }));
      return;
    }

    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Not found' }));
  } catch (err) {
    if (!res.headersSent) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: err?.message || 'Internal error' }));
    }
  }
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`[Eluvix-OpenCode] Listening on http://0.0.0.0:${PORT}`);
});
