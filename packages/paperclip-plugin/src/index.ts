import { manifest, ELUVIX_PLUGIN_ID } from './manifest.js';
import {
  DEFAULT_AUTO_ASSIGN_CONFIG,
  handleUnassignedIssueEvent,
  type PluginConfig,
  type PluginHostContext,
} from './auto-assign.js';

export { manifest, ELUVIX_PLUGIN_ID };
export * from './auto-assign.js';

export function validateEluvixPluginConfig(raw: unknown): { ok: true; config: PluginConfig } | { ok: false; error: string } {
  const obj = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const baseUrl = String(obj.eluvixBaseUrl || 'http://127.0.0.1:3588').trim();
  try {
    const parsed = new URL(baseUrl);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return { ok: false, error: 'eluvixBaseUrl must use http or https' };
    }
  } catch {
    return { ok: false, error: 'eluvixBaseUrl must be a valid URL' };
  }
  const autoRaw = (obj.autoAssign && typeof obj.autoAssign === 'object'
    ? obj.autoAssign
    : {}) as Record<string, unknown>;
  const mode =
    autoRaw.mode === 'off' ||
    autoRaw.mode === 'advisory' ||
    autoRaw.mode === 'shadow' ||
    autoRaw.mode === 'auto'
      ? autoRaw.mode
      : 'advisory';

  return {
    ok: true,
    config: {
      eluvixBaseUrl: baseUrl.replace(/\/$/, ''),
      eluvixApiKeyRef: typeof obj.eluvixApiKeyRef === 'string' ? obj.eluvixApiKeyRef : undefined,
      autoAssign: {
        ...DEFAULT_AUTO_ASSIGN_CONFIG,
        ...autoRaw,
        mode,
      },
      weights:
        obj.weights && typeof obj.weights === 'object'
          ? (obj.weights as Record<string, number>)
          : undefined,
    },
  };
}

export function createEluvixPluginHandlers(hostCtx: PluginHostContext) {
  const fetchFn = hostCtx.fetch || globalThis.fetch;

  async function resolveKey(): Promise<string> {
    if (hostCtx.config.eluvixApiKeyRef && hostCtx.secrets) {
      const resolved = await hostCtx.secrets.resolve(hostCtx.config.eluvixApiKeyRef);
      if (resolved) return resolved;
    }
    return process.env.ELUVIX_API_KEY || '';
  }

  async function callEluvix(path: string, init?: RequestInit): Promise<any> {
    const key = await resolveKey();
    const base = hostCtx.config.eluvixBaseUrl.replace(/\/$/, '');
    const res = await fetchFn(`${base}${path}`, {
      ...init,
      headers: {
        'Content-Type': 'application/json',
        ...(key ? { Authorization: `Bearer ${key}` } : {}),
        ...(init?.headers || {}),
      },
    });
    if (!res.ok) {
      throw new Error(`Eluvix API ${path} returned HTTP ${res.status}`);
    }
    return await res.json();
  }

  const tools = {
    'eluvix:capabilities': async () => callEluvix('/api/v1/paperclip/capabilities'),
    'eluvix:classify_task': async (params: Record<string, unknown>) =>
      callEluvix('/api/v1/paperclip/classify', {
        method: 'POST',
        body: JSON.stringify(params),
      }),
    'eluvix:recommend_assignee': async (
      params: Record<string, unknown>,
      runCtx: { companyId: string }
    ) => {
      let title = String(params.title || '');
      let description = typeof params.description === 'string' ? params.description : undefined;
      let priority = params.priority;
      let labels = Array.isArray(params.labels) ? params.labels : undefined;

      if (typeof params.issueId === 'string' && params.issueId) {
        const issue = await hostCtx.issues.get(params.issueId, runCtx.companyId);
        if (issue) {
          title = issue.title;
          description = issue.description || undefined;
          priority = issue.priority;
          labels = Array.isArray(issue.labels)
            ? issue.labels.map((l) => (typeof l === 'string' ? l : String(l?.name || '')))
            : undefined;
        }
      }

      const allAgents = await hostCtx.agents.list({ companyId: runCtx.companyId });
      const filterIds = Array.isArray(params.candidateAgentIds)
        ? new Set(params.candidateAgentIds.map(String))
        : null;
      const candidates = allAgents
        .filter((a) => !filterIds || filterIds.has(a.id))
        .map((a) => ({
          id: a.id,
          name: a.name,
          role: a.role,
          title: a.title,
          capabilities: a.capabilities,
          adapterType: a.adapterType,
          model: typeof a.adapterConfig?.model === 'string' ? a.adapterConfig.model : undefined,
          status: a.status,
          budgetMonthlyCents: a.budgetMonthlyCents,
          spentMonthlyCents: a.spentMonthlyCents,
          isEluvixAuto: a.adapterConfig?.model === 'eluvix/auto',
        }));

      return callEluvix('/api/v1/paperclip/recommend-assignee', {
        method: 'POST',
        body: JSON.stringify({
          task: {
            issueId: params.issueId,
            title,
            description,
            priority,
            labels,
          },
          candidates,
          weights: hostCtx.config.weights,
          topN: typeof params.topN === 'number' ? params.topN : 5,
        }),
      });
    },
    'eluvix:explain_route': async (params: Record<string, unknown>) =>
      callEluvix('/api/v1/route-explain', {
        method: 'POST',
        body: JSON.stringify({
          model: params.model || 'eluvix/auto',
          messages: [{ role: 'user', content: String(params.prompt || '') }],
          paperclip: {
            priority: params.priority,
            sensitivity: params.sensitivity,
          },
        }),
      }),
    'eluvix:budget': async () => callEluvix('/api/v1/paperclip/whoami'),
  };

  return {
    tools,
    onHealth: async () => {
      try {
        const who = await callEluvix('/api/v1/paperclip/whoami');
        return { ok: true, details: who };
      } catch (err: any) {
        return { ok: false, error: err?.message || 'Eluvix unreachable' };
      }
    },
    onEvent: async (event: { type: string; payload: any }) => {
      const key = await resolveKey();
      if (event.type === 'issue.created' || event.type === 'issue.updated') {
        const issue = event.payload?.issue || event.payload;
        if (issue && issue.id && issue.companyId) {
          return await handleUnassignedIssueEvent(issue, hostCtx, key);
        }
      }
      if (event.type === 'agent.run.finished') {
        const p = event.payload || {};
        if (p.issueId && p.agentId) {
          await callEluvix('/api/v1/paperclip/feedback', {
            method: 'POST',
            body: JSON.stringify({
              issueId: p.issueId,
              agentId: p.agentId,
              taskClass: p.taskClass || 'text:moderate',
              success: p.status === 'succeeded' || p.exitCode === 0,
              costUsd: Number(p.costUsd || 0),
              durationMs: Number(p.durationMs || 0),
            }),
          }).catch(() => {});
        }
      }
      return null;
    },
  };
}
