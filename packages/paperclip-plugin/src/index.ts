import { manifest, ELUVIX_PLUGIN_ID } from './manifest.js';
import {
  approvePendingAssignment,
  buildCandidateListWithLoad,
  DEFAULT_AUTO_ASSIGN_CONFIG,
  DEFAULT_SAFETY_FUSE_CONFIG,
  dismissPendingAssignment,
  getSafetyFuseState,
  handleUnassignedIssueEvent,
  listPendingAssignments,
  recordSafetyFuseOutcome,
  resetSafetyFuse,
  supersedePendingAssignment,
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
    autoRaw.mode === 'auto-with-approval' ||
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
        safetyFuse: {
          ...DEFAULT_SAFETY_FUSE_CONFIG,
          ...(autoRaw.safetyFuse && typeof autoRaw.safetyFuse === 'object'
            ? (autoRaw.safetyFuse as Record<string, unknown>)
            : {}),
        },
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

  async function recommendForTask(params: {
    companyId: string;
    issueId?: string;
    title?: string;
    description?: string;
    priority?: unknown;
    labels?: unknown[];
    candidateAgentIds?: unknown[];
    topN?: number;
  }) {
    let title = String(params.title || '');
    let description = typeof params.description === 'string' ? params.description : undefined;
    let priority = params.priority;
    let labels = Array.isArray(params.labels) ? params.labels : undefined;
    let issue: Awaited<ReturnType<typeof hostCtx.issues.get>> = null;

    if (params.issueId) {
      issue = await hostCtx.issues.get(params.issueId, params.companyId);
      if (issue) {
        title = issue.title;
        description = issue.description || undefined;
        priority = issue.priority;
        labels = Array.isArray(issue.labels)
          ? issue.labels.map((l) => (typeof l === 'string' ? l : String(l?.name || '')))
          : undefined;
      }
    }

    const allAgents = await hostCtx.agents.list({ companyId: params.companyId });
    const filterIds = Array.isArray(params.candidateAgentIds)
      ? new Set(params.candidateAgentIds.map(String))
      : null;
    const candidates = await buildCandidateListWithLoad(params.companyId, allAgents, hostCtx, {
      filterIds,
      parentIssueId: issue?.parentId,
    });

    const recommendation = await callEluvix('/api/v1/paperclip/recommend-assignee', {
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

    return { issue, candidates, recommendation };
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
      const { recommendation } = await recommendForTask({
        companyId: runCtx.companyId,
        issueId: typeof params.issueId === 'string' ? params.issueId : undefined,
        title: typeof params.title === 'string' ? params.title : undefined,
        description: typeof params.description === 'string' ? params.description : undefined,
        priority: params.priority,
        labels: Array.isArray(params.labels) ? params.labels : undefined,
        candidateAgentIds: Array.isArray(params.candidateAgentIds)
          ? params.candidateAgentIds
          : undefined,
        topN: typeof params.topN === 'number' ? params.topN : 5,
      });
      return recommendation;
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

  const data = {
    'eluvix:issue_overview': async (params: Record<string, unknown>) => {
      const companyId = String(params.companyId || '');
      const issueId = String(params.issueId || '');
      if (!companyId || !issueId) {
        return { error: 'companyId and issueId are required' };
      }
      const { issue, recommendation } = await recommendForTask({
        companyId,
        issueId,
        topN: 5,
      });
      const [classification, pendingApproval, shadowDecision, safetyFuse] = await Promise.all([
        issue
          ? callEluvix('/api/v1/paperclip/classify', {
              method: 'POST',
              body: JSON.stringify({
                issueId: issue.id,
                title: issue.title,
                description: issue.description,
                priority: issue.priority,
                labels: Array.isArray(issue.labels)
                  ? issue.labels.map((l) => (typeof l === 'string' ? l : String(l?.name || '')))
                  : undefined,
              }),
            }).catch(() => recommendation?.classification || null)
          : Promise.resolve(null),
        hostCtx.state.get(`pending-assignment:${issueId}`).catch(() => null),
        hostCtx.state.get(`shadow:${issueId}`).catch(() => null),
        getSafetyFuseState(hostCtx, companyId).catch(() => null),
      ]);
      return {
        issue,
        classification: classification || recommendation?.classification || null,
        recommendations: recommendation?.recommendations || [],
        excluded: recommendation?.excluded || [],
        pendingApproval,
        shadowDecision,
        safetyFuse,
        autoAssignMode: hostCtx.config.autoAssign?.mode || 'advisory',
      };
    },
    'eluvix:dashboard_overview': async (params: Record<string, unknown>) => {
      const companyId = String(params.companyId || '');
      const [capabilitiesRes, whoamiRes, agentsRes, pendingRes, safetyFuseRes] = await Promise.allSettled([
        callEluvix('/api/v1/paperclip/capabilities'),
        callEluvix('/api/v1/paperclip/whoami'),
        companyId ? hostCtx.agents.list({ companyId }) : Promise.resolve([]),
        companyId ? listPendingAssignments(hostCtx, companyId) : Promise.resolve([]),
        companyId ? getSafetyFuseState(hostCtx, companyId) : Promise.resolve(null),
      ]);
      const agentsList = agentsRes.status === 'fulfilled' ? agentsRes.value : [];
      const agentCandidates =
        companyId && agentsList.length > 0
          ? await buildCandidateListWithLoad(companyId, agentsList, hostCtx)
          : [];
      return {
        capabilities: capabilitiesRes.status === 'fulfilled' ? capabilitiesRes.value : null,
        whoami: whoamiRes.status === 'fulfilled' ? whoamiRes.value : null,
        agents: agentCandidates,
        pendingApprovals: pendingRes.status === 'fulfilled' ? pendingRes.value : [],
        safetyFuse: safetyFuseRes.status === 'fulfilled' ? safetyFuseRes.value : null,
        autoAssignMode: hostCtx.config.autoAssign?.mode || 'advisory',
      };
    },
    'eluvix:agent_performance': async (params: Record<string, unknown>) => {
      const companyId = String(params.companyId || '');
      const agentId = String(params.agentId || '');
      if (!companyId || !agentId) {
        return { error: 'companyId and agentId are required' };
      }
      const allAgents = await hostCtx.agents.list({ companyId });
      const candidates = await buildCandidateListWithLoad(companyId, allAgents, hostCtx, {
        filterIds: new Set([agentId]),
      });
      const candidate = candidates[0] || null;
      const [recRes, capRes] = await Promise.allSettled([
        candidate
          ? callEluvix('/api/v1/paperclip/recommend-assignee', {
              method: 'POST',
              body: JSON.stringify({
                task: {
                  title: 'General engineering & routing readiness check',
                  description: candidate.capabilities || candidate.title || '',
                  priority: 'medium',
                },
                candidates: [candidate],
                weights: hostCtx.config.weights,
                topN: 1,
              }),
            })
          : Promise.resolve(null),
        callEluvix('/api/v1/paperclip/capabilities'),
      ]);
      const rec = recRes.status === 'fulfilled' ? recRes.value : null;
      return {
        agent: candidate,
        recommendation: rec?.recommendations?.[0] || null,
        excluded: rec?.excluded?.[0] || null,
        capabilities: capRes.status === 'fulfilled' ? capRes.value : null,
      };
    },
  };

  const actions = {
    'eluvix:approve_assignment': async (params: Record<string, unknown>) =>
      approvePendingAssignment(
        {
          companyId: String(params.companyId || ''),
          issueId: String(params.issueId || ''),
          agentId: typeof params.agentId === 'string' ? params.agentId : undefined,
          agentName: typeof params.agentName === 'string' ? params.agentName : undefined,
        },
        hostCtx
      ),
    'eluvix:dismiss_assignment': async (params: Record<string, unknown>) =>
      dismissPendingAssignment(
        {
          companyId: String(params.companyId || ''),
          issueId: String(params.issueId || ''),
          reason: typeof params.reason === 'string' ? params.reason : undefined,
        },
        hostCtx
      ),
    'eluvix:assign_candidate': async (params: Record<string, unknown>) => {
      const companyId = String(params.companyId || '');
      const issueId = String(params.issueId || '');
      const agentId = String(params.agentId || '');
      const agentName = typeof params.agentName === 'string' ? params.agentName : undefined;
      if (!companyId || !issueId || !agentId) {
        return { ok: false, reason: 'missing_required_fields' };
      }
      const issue = await hostCtx.issues.get(issueId, companyId);
      if (!issue) return { ok: false, reason: 'issue_not_found' };
      if (issue.checkoutRunId) return { ok: false, reason: 'issue_checked_out' };
      const updated = await hostCtx.issues.update(issueId, companyId, {
        assigneeAgentId: agentId,
      });
      await supersedePendingAssignment(issueId, companyId, hostCtx);
      await hostCtx.issues
        .addComment(
          issueId,
          companyId,
          `[Eluvix Switchyard] Assigned to **${agentName || agentId}** from Eluvix Switchyard UI.`
        )
        .catch(() => {});
      return { ok: true, reason: 'assigned', issue: updated, agentId };
    },
    'eluvix:explain_route': async (params: Record<string, unknown>) =>
      tools['eluvix:explain_route'](params),
    'eluvix:reset_safety_fuse': async (params: Record<string, unknown>) =>
      resetSafetyFuse(hostCtx, String(params.companyId || '')),
  };

  return {
    tools,
    data,
    actions,
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
      const REOPEN_WINDOW_MS = 48 * 3600 * 1000;

      const postFeedback = async (payload: Record<string, unknown>) => {
        if (payload.companyId) {
          await recordSafetyFuseOutcome(hostCtx, String(payload.companyId), {
            success: Boolean(payload.success),
            issueId: typeof payload.issueId === 'string' ? payload.issueId : undefined,
          }).catch(() => {});
        }
        await callEluvix('/api/v1/paperclip/feedback', {
          method: 'POST',
          body: JSON.stringify(payload),
        }).catch(() => {});
      };

      if (event.type === 'issue.created' || event.type === 'issue.updated') {
        const issue = event.payload?.issue || event.payload;
        if (issue && issue.id && issue.companyId) {
          const trackKey = `issue-outcome:${issue.id}`;
          const prev = (await hostCtx.state.get(trackKey).catch(() => null)) as
            | {
                agentId?: string | null;
                status?: string;
                completedAt?: number;
                companyId?: string;
                title?: string;
                description?: string;
                priority?: string;
                labels?: string[];
                lastRunId?: string;
                lastRunCostUsd?: number;
                lastRunDurationMs?: number;
              }
            | null;

          const labels = Array.isArray(issue.labels)
            ? issue.labels
                .map((l: any) => (typeof l === 'string' ? l : String(l?.name || '')))
                .filter(Boolean)
            : prev?.labels;
          const title = String(issue.title || prev?.title || '');
          const description =
            typeof issue.description === 'string'
              ? issue.description.slice(0, 2000)
              : prev?.description;
          const priority = issue.priority || prev?.priority;

          if (
            prev?.agentId &&
            issue.assigneeAgentId &&
            prev.agentId !== issue.assigneeAgentId
          ) {
            await postFeedback({
              issueId: issue.id,
              agentId: prev.agentId,
              companyId: issue.companyId,
              title,
              description,
              priority,
              labels,
              runId: prev.lastRunId,
              costUsd: prev.lastRunCostUsd ?? 0,
              durationMs: prev.lastRunDurationMs ?? 0,
              success: false,
              outcomeStatus: 'reassigned',
            });
          } else if (
            issue.status === 'done' &&
            prev?.status !== 'done' &&
            (issue.assigneeAgentId || prev?.agentId)
          ) {
            await postFeedback({
              issueId: issue.id,
              agentId: issue.assigneeAgentId || prev?.agentId,
              companyId: issue.companyId,
              title,
              description,
              priority,
              labels,
              runId: prev?.lastRunId,
              costUsd: prev?.lastRunCostUsd ?? 0,
              durationMs: prev?.lastRunDurationMs ?? 0,
              success: true,
              outcomeStatus: 'done',
            });
          } else if (
            prev?.status === 'done' &&
            issue.status !== 'done' &&
            issue.status !== 'cancelled' &&
            prev.agentId &&
            (!prev.completedAt || Date.now() - Number(prev.completedAt) <= REOPEN_WINDOW_MS)
          ) {
            await postFeedback({
              issueId: issue.id,
              agentId: prev.agentId,
              companyId: issue.companyId,
              title,
              description,
              priority,
              labels,
              runId: prev.lastRunId,
              costUsd: prev.lastRunCostUsd ?? 0,
              durationMs: prev.lastRunDurationMs ?? 0,
              success: false,
              reopened: true,
              outcomeStatus: 'reopened',
            });
          } else if (
            issue.status === 'cancelled' &&
            prev?.status !== 'cancelled' &&
            (issue.assigneeAgentId || prev?.agentId)
          ) {
            await postFeedback({
              issueId: issue.id,
              agentId: issue.assigneeAgentId || prev?.agentId,
              companyId: issue.companyId,
              title,
              description,
              priority,
              labels,
              runId: prev?.lastRunId,
              costUsd: prev?.lastRunCostUsd ?? 0,
              durationMs: prev?.lastRunDurationMs ?? 0,
              success: false,
              outcomeStatus: 'cancelled',
            });
          }

          if (
            !prev ||
            prev.status !== issue.status ||
            prev.agentId !== (issue.assigneeAgentId ?? null)
          ) {
            await hostCtx.state
              .set(trackKey, {
                agentId: issue.assigneeAgentId ?? prev?.agentId ?? null,
                status: issue.status,
                completedAt:
                  issue.status === 'done'
                    ? prev?.status === 'done'
                      ? prev.completedAt
                      : Date.now()
                    : undefined,
                companyId: issue.companyId,
                title,
                description,
                priority,
                labels,
                lastRunId: prev?.lastRunId,
                lastRunCostUsd: prev?.lastRunCostUsd,
                lastRunDurationMs: prev?.lastRunDurationMs,
              })
              .catch(() => {});
          }

          if (issue.assigneeAgentId) {
            await supersedePendingAssignment(issue.id, issue.companyId, hostCtx);
          }

          return await handleUnassignedIssueEvent(issue, hostCtx, key);
        }
      }

      if (event.type === 'approval.updated' || event.type === 'approval.decided') {
        const p = event.payload || {};
        const companyId = typeof p.companyId === 'string' ? p.companyId : '';
        const issueId =
          typeof p.issueId === 'string'
            ? p.issueId
            : p.entityType === 'issue' && typeof p.entityId === 'string'
              ? p.entityId
              : '';
        if (companyId && issueId) {
          const decision = String(p.decision || p.status || '').toLowerCase();
          if (decision === 'approved') {
            return await approvePendingAssignment(
              {
                companyId,
                issueId,
                agentId: typeof p.agentId === 'string' ? p.agentId : undefined,
              },
              hostCtx
            );
          }
          if (decision === 'rejected' || decision === 'dismissed') {
            return await dismissPendingAssignment(
              {
                companyId,
                issueId,
                reason: typeof p.reason === 'string' ? p.reason : decision,
              },
              hostCtx
            );
          }
        }
      }

      if (event.type === 'agent.run.finished') {
        const p = event.payload || {};
        if (p.issueId) {
          const trackKey = `issue-outcome:${p.issueId}`;
          const prev = (await hostCtx.state.get(trackKey).catch(() => null)) as
            | Record<string, any>
            | null;
          const runCost = typeof p.costUsd === 'number' && Number.isFinite(p.costUsd) ? p.costUsd : 0;
          const runDur =
            typeof p.durationMs === 'number' && Number.isFinite(p.durationMs) ? p.durationMs : 0;
          const updatedTrack = {
            ...(prev || {}),
            agentId: prev?.agentId || p.agentId || null,
            companyId: prev?.companyId || p.companyId,
            lastRunId: typeof p.runId === 'string' ? p.runId : prev?.lastRunId,
            lastRunCostUsd: Number(prev?.lastRunCostUsd || 0) + runCost,
            lastRunDurationMs: Number(prev?.lastRunDurationMs || 0) + runDur,
          };
          await hostCtx.state.set(trackKey, updatedTrack).catch(() => {});

          const isRunFailed =
            p.status === 'failed' ||
            (typeof p.exitCode === 'number' && p.exitCode !== 0);
          if (isRunFailed && p.agentId) {
            await postFeedback({
              issueId: p.issueId,
              agentId: p.agentId,
              companyId: p.companyId || prev?.companyId,
              runId: typeof p.runId === 'string' ? p.runId : undefined,
              task: p.task && typeof p.task === 'object' ? p.task : undefined,
              title: typeof p.issueTitle === 'string' ? p.issueTitle : prev?.title,
              description:
                typeof p.issueDescription === 'string' ? p.issueDescription : prev?.description,
              priority: p.priority || prev?.priority,
              labels: Array.isArray(p.labels) ? p.labels : prev?.labels,
              taskClass: typeof p.taskClass === 'string' ? p.taskClass : undefined,
              success: false,
              outcomeStatus: 'run_failed',
              costUsd: runCost,
              durationMs: runDur,
            });
          }
        }
      }
      return null;
    },
  };
}

/**
 * Bind Eluvix handlers into a live Paperclip `@paperclipai/plugin-sdk` worker context.
 */
export async function registerWithPaperclipSdk(sdkCtx: any) {
  const rawConfig =
    typeof sdkCtx.config?.get === 'function' ? await sdkCtx.config.get() : sdkCtx.config;
  const validated = validateEluvixPluginConfig(rawConfig);
  const config: PluginConfig = validated.ok
    ? validated.config
    : { eluvixBaseUrl: 'http://127.0.0.1:3588', autoAssign: DEFAULT_AUTO_ASSIGN_CONFIG };

  const adaptedCtx: PluginHostContext = {
    config,
    issues: {
      get: (issueId, companyId) => sdkCtx.issues.get(issueId, companyId),
      list: (input) => sdkCtx.issues.list(input),
      update: (issueId, companyId, patch) => sdkCtx.issues.update(issueId, companyId, patch),
      addComment: (issueId, companyId, body) => sdkCtx.issues.addComment(issueId, companyId, body),
    },
    agents: {
      list: (input) => sdkCtx.agents.list(input),
    },
    state: {
      get: async (stateKey: string) =>
        typeof sdkCtx.state?.get === 'function'
          ? sdkCtx.state.get({ scopeKind: 'instance', stateKey })
          : null,
      set: async (stateKey: string, value: unknown) => {
        if (typeof sdkCtx.state?.set === 'function') {
          await sdkCtx.state.set({ scopeKind: 'instance', stateKey }, value);
        }
      },
    },
    activity: sdkCtx.activity,
    secrets: sdkCtx.secrets,
  };

  const handlers = createEluvixPluginHandlers(adaptedCtx);

  if (typeof sdkCtx.data?.register === 'function') {
    for (const [key, fn] of Object.entries(handlers.data)) {
      sdkCtx.data.register(key, fn);
    }
  }
  if (typeof sdkCtx.actions?.register === 'function') {
    for (const [key, fn] of Object.entries(handlers.actions)) {
      sdkCtx.actions.register(key, fn);
    }
  }
  if (typeof sdkCtx.tools?.register === 'function') {
    for (const tool of manifest.tools) {
      const fn = (handlers.tools as Record<string, any>)[tool.name];
      if (!fn) continue;
      const shortName = tool.name.includes(':') ? tool.name.split(':').slice(1).join(':') : tool.name;
      sdkCtx.tools.register(
        shortName,
        {
          displayName: tool.displayName,
          description: tool.description,
          parametersSchema: tool.parametersSchema,
        },
        (params: Record<string, unknown>, runCtx: { companyId: string }) => fn(params, runCtx)
      );
    }
  }
  if (typeof sdkCtx.events?.on === 'function') {
    for (const eventType of [
      'issue.created',
      'issue.updated',
      'agent.run.finished',
      'approval.updated',
      'approval.decided',
    ]) {
      sdkCtx.events.on(eventType, (payload: any) =>
        handlers.onEvent({ type: eventType, payload })
      );
    }
  }

  return handlers;
}
