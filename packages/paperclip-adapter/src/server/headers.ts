import crypto from 'node:crypto';
import fs from 'node:fs';

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1', 'eluvix.local']);

export function validateLoopbackEluvixUrl(rawUrl: string): { ok: true; url: string } | { ok: false; reason: string } {
  try {
    const parsed = new URL(rawUrl.trim());
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return { ok: false, reason: `Unsupported protocol "${parsed.protocol}"` };
    }
    if (parsed.username || parsed.password) {
      return { ok: false, reason: 'URL must not contain embedded credentials' };
    }
    const host = parsed.hostname.replace(/^\[|\]$/g, '').toLowerCase();
    if (!LOOPBACK_HOSTS.has(host)) {
      return {
        ok: false,
        reason: `Same-machine policy restricts eluvixBaseUrl to loopback hosts (got "${host}")`,
      };
    }
    return { ok: true, url: parsed.toString().replace(/\/$/, '') };
  } catch (err: any) {
    return { ok: false, reason: err?.message || 'Invalid URL' };
  }
}

export function resolveEluvixApiKey(config: Record<string, unknown>, env?: Record<string, string | undefined>): string {
  const fromConfig = typeof config.eluvixApiKey === 'string' ? config.eluvixApiKey.trim() : '';
  if (fromConfig.startsWith('env:')) {
    const varName = fromConfig.slice(4).trim();
    return (env?.[varName] || process.env[varName] || '').trim();
  }
  if (fromConfig) return fromConfig;
  const fromEnv = (env?.ELUVIX_API_KEY || process.env.ELUVIX_API_KEY || '').trim();
  return fromEnv;
}

/**
 * Resolves the optional Paperclip HMAC signing secret from adapter config or env,
 * supporting `env:VAR` and `file:/path` references. Returns `undefined` if an
 * explicit reference cannot be resolved (never returns a raw `env:`/`file:` string).
 */
export function resolveEluvixHmacSecret(
  config: Record<string, unknown>,
  env?: Record<string, string | undefined>
): string | undefined {
  const candidates = [
    typeof config.eluvixHmacSecret === 'string' ? config.eluvixHmacSecret : undefined,
    env?.PAPERCLIP_ELUVIX_HMAC_SECRET,
    env?.ELUVIX_PAPERCLIP_HMAC_SECRET,
    process.env.PAPERCLIP_ELUVIX_HMAC_SECRET,
    process.env.ELUVIX_PAPERCLIP_HMAC_SECRET,
  ];
  for (const raw of candidates) {
    if (typeof raw !== 'string') continue;
    const trimmed = raw.trim();
    if (!trimmed) continue;
    if (/^env:/i.test(trimmed)) {
      const varName = trimmed.slice(4).trim();
      const val = (env?.[varName] || process.env[varName] || '').trim();
      if (val) return val;
      continue;
    }
    if (/^file:/i.test(trimmed)) {
      let filePath = trimmed.slice(5).trim();
      if (filePath.startsWith('//')) {
        filePath = filePath.replace(/^\/\/(localhost)?/, '');
      }
      if (filePath) {
        try {
          const val = fs.readFileSync(filePath, 'utf8').trim();
          if (val) return val;
        } catch {
          // Ignore unreadable secret file
        }
      }
      continue;
    }
    return trimmed;
  }
  return undefined;
}

/**
 * Signs outbound `x-paperclip-*` context headers with HMAC-SHA256 matching
 * `@eluvix/router-core`'s `canonicalPaperclipSignaturePayload` (`v1.<ts_ms>.<mac>`).
 */
export function signOutboundPaperclipHeaders(
  headers: Record<string, string>,
  hmacSecret: string,
  opts?: { nowMs?: number }
): Record<string, string> {
  const normalized: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) {
    if (typeof v === 'string') {
      normalized[k.toLowerCase()] = v;
    }
  }
  const ts = String(opts?.nowMs ?? Date.now());
  const payload = [
    'v1',
    ts,
    normalized['x-paperclip-run-id'] ?? '',
    normalized['x-paperclip-issue-id'] ?? '',
    normalized['x-paperclip-agent-id'] ?? '',
    normalized['x-paperclip-company-id'] ?? '',
    normalized['x-paperclip-issue-priority'] ?? '',
    normalized['x-paperclip-budget-remaining-pct'] ?? '',
    normalized['x-paperclip-sensitivity'] ?? '',
    normalized['x-paperclip-hop'] ?? '0',
  ].join('|');
  const mac = crypto.createHmac('sha256', hmacSecret).update(payload).digest('hex');
  return {
    ...headers,
    'x-paperclip-context-ts': ts,
    'x-paperclip-context-sig': `v1.${ts}.${mac}`,
  };
}

export function redactSecrets(text: string): string {
  return text
    .replace(/\belx_[A-Za-z]{20,80}\b/g, '[REDACTED_ELX_KEY]')
    .replace(/\bBearer\s+[A-Za-z0-9._-]{16,}/gi, 'Bearer [REDACTED_TOKEN]')
    .replace(/\bv1\.(\d{10,16})\.[0-9a-fA-F]{32,}\b/g, 'v1.$1.[REDACTED_SIG]')
    .replace(
      /\b((?:PAPERCLIP_)?ELUVIX_HMAC_SECRET)\s*=\s*\S+/g,
      '$1=[REDACTED_SECRET]'
    );
}

export async function derivePaperclipContextHeaders(opts: {
  runId: string;
  agentId: string;
  companyId: string;
  taskId?: string;
  paperclipApiUrl?: string;
  paperclipAuthToken?: string;
  fetchImpl?: typeof globalThis.fetch;
  hmacSecret?: string;
  nowMs?: number;
}): Promise<Record<string, string>> {
  const headers: Record<string, string> = {
    'x-paperclip-run-id': opts.runId,
    'x-paperclip-agent-id': opts.agentId,
    'x-paperclip-company-id': opts.companyId,
  };
  if (opts.taskId) {
    headers['x-paperclip-issue-id'] = opts.taskId;
  }

  const finalize = (h: Record<string, string>): Record<string, string> =>
    opts.hmacSecret ? signOutboundPaperclipHeaders(h, opts.hmacSecret, { nowMs: opts.nowMs }) : h;

  const fetchFn = opts.fetchImpl || globalThis.fetch;
  if (!opts.paperclipApiUrl || !opts.paperclipAuthToken || !fetchFn) {
    return finalize(headers);
  }

  const base = opts.paperclipApiUrl.replace(/\/$/, '');
  const authHeaders = {
    Authorization: `Bearer ${opts.paperclipAuthToken}`,
    'X-Paperclip-Run-Id': opts.runId,
  };

  if (opts.taskId) {
    try {
      const issueRes = await fetchFn(`${base}/api/issues/${encodeURIComponent(opts.taskId)}`, {
        headers: authHeaders,
      });
      if (issueRes.ok) {
        const issue: any = await issueRes.json();
        if (typeof issue?.priority === 'string') {
          headers['x-paperclip-issue-priority'] = issue.priority.toLowerCase();
        }
        const labels: string[] = Array.isArray(issue?.labels)
          ? issue.labels.map((l: any) => (typeof l === 'string' ? l : String(l?.name || '')))
          : [];
        if (labels.some((l) => l.toLowerCase() === 'sensitivity:confidential')) {
          headers['x-paperclip-sensitivity'] = 'confidential';
        } else if (labels.some((l) => l.toLowerCase() === 'sensitivity:internal')) {
          headers['x-paperclip-sensitivity'] = 'internal';
        }
      }
    } catch {
      // Best-effort metadata lookup
    }
  }

  try {
    const meRes = await fetchFn(`${base}/api/agents/me`, { headers: authHeaders });
    if (meRes.ok) {
      const me: any = await meRes.json();
      const budget = Number(me?.budgetMonthlyCents || 0);
      const spent = Number(me?.spentMonthlyCents || 0);
      if (budget > 0) {
        const remainingPct = Math.max(0, Math.min(100, ((budget - spent) / budget) * 100));
        headers['x-paperclip-budget-remaining-pct'] = String(Math.round(remainingPct));
      }
    }
  } catch {
    // Best-effort metadata lookup
  }

  return finalize(headers);
}
