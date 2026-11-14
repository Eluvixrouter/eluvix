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

export function redactSecrets(text: string): string {
  return text
    .replace(/\belx_[A-Za-z]{20,80}\b/g, '[REDACTED_ELX_KEY]')
    .replace(/\bBearer\s+[A-Za-z0-9._-]{16,}/gi, 'Bearer [REDACTED_TOKEN]');
}

export async function derivePaperclipContextHeaders(opts: {
  runId: string;
  agentId: string;
  companyId: string;
  taskId?: string;
  paperclipApiUrl?: string;
  paperclipAuthToken?: string;
  fetchImpl?: typeof globalThis.fetch;
}): Promise<Record<string, string>> {
  const headers: Record<string, string> = {
    'x-paperclip-run-id': opts.runId,
    'x-paperclip-agent-id': opts.agentId,
    'x-paperclip-company-id': opts.companyId,
  };
  if (opts.taskId) {
    headers['x-paperclip-issue-id'] = opts.taskId;
  }

  const fetchFn = opts.fetchImpl || globalThis.fetch;
  if (!opts.paperclipApiUrl || !opts.paperclipAuthToken || !fetchFn) {
    return headers;
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

  return headers;
}
