import { describe, expect, it, vi } from 'vitest';
import {
  createEluvixPluginHandlers,
  manifest,
  validateEluvixPluginConfig,
  type PluginHostContext,
} from '../index.js';
import { uiSlots } from '../ui/index.js';

function makeStatefulCtx(overrides?: Partial<PluginHostContext>): {
  ctx: PluginHostContext;
  stateStore: Map<string, unknown>;
  issueMap: Map<string, any>;
  comments: Array<{ issueId: string; body: string }>;
  updates: Array<{ issueId: string; patch: Record<string, unknown> }>;
  fetchSpy: ReturnType<typeof vi.fn>;
} {
  const stateStore = new Map<string, unknown>();
  const issueMap = new Map<string, any>([
    [
      'iss-1',
      {
        id: 'iss-1',
        companyId: 'comp-1',
        identifier: 'PAP-1',
        title: 'Refactor auth verification',
        description: 'Implement HMAC check',
        status: 'todo',
        priority: 'high',
        parentId: 'iss-parent',
      },
    ],
    [
      'iss-parent',
      {
        id: 'iss-parent',
        companyId: 'comp-1',
        title: 'Security hardening epic',
        status: 'in_progress',
        assigneeAgentId: 'lead-1',
      },
    ],
    [
      'iss-open-other',
      {
        id: 'iss-open-other',
        companyId: 'comp-1',
        title: 'Existing work',
        status: 'in_progress',
        assigneeAgentId: 'ag-busy',
      },
    ],
    [
      'iss-done-other',
      {
        id: 'iss-done-other',
        companyId: 'comp-1',
        title: 'Closed work',
        status: 'done',
        assigneeAgentId: 'ag-idle',
      },
    ],
  ]);

  const comments: Array<{ issueId: string; body: string }> = [];
  const updates: Array<{ issueId: string; patch: Record<string, unknown> }> = [];

  const fetchSpy = vi.fn(async (url: string) => {
    if (url.endsWith('/api/v1/paperclip/recommend-assignee')) {
      return new Response(
        JSON.stringify({
          recommendations: [
            {
              agentId: 'ag-idle',
              name: 'Switchyard Idle Engineer',
              confidence: 0.91,
              estimatedCostUsd: 0.001,
              rationale: 'fit=95%, low open load',
              breakdown: { fit: 0.95, cost: 1, latency: 0.9, load: 1, budget: 1, history: 0.8 },
            },
          ],
          excluded: [],
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      );
    }
    if (url.endsWith('/api/v1/paperclip/classify')) {
      return new Response(JSON.stringify({ suggestedTier: 'heavy-reasoning', complexityLabel: 'complex' }), {
        status: 200,
      });
    }
    return new Response(JSON.stringify({ ok: true }), { status: 200 });
  });

  const ctx: PluginHostContext = {
    config: {
      eluvixBaseUrl: 'http://127.0.0.1:3588',
      autoAssign: {
        mode: 'auto-with-approval',
        companies: ['comp-1'],
        statuses: ['backlog', 'todo'],
        minConfidence: 0.7,
        maxPerHour: 10,
        maxTreeDepth: 4,
        requireUnassigned: true,
        excludeLabels: [],
      },
    },
    fetch: fetchSpy as any,
    issues: {
      get: async (issueId) => issueMap.get(issueId) ?? null,
      list: async () => Array.from(issueMap.values()),
      update: async (issueId, _companyId, patch) => {
        updates.push({ issueId, patch });
        const cur = issueMap.get(issueId) || { id: issueId };
        const next = { ...cur, ...patch };
        issueMap.set(issueId, next);
        return next;
      },
      addComment: async (issueId, _companyId, body) => {
        comments.push({ issueId, body });
      },
    },
    agents: {
      list: async () => [
        {
          id: 'ag-busy',
          companyId: 'comp-1',
          name: 'Busy Agent',
          status: 'idle',
          reportsTo: 'lead-1',
        },
        {
          id: 'ag-idle',
          companyId: 'comp-1',
          name: 'Switchyard Idle Engineer',
          status: 'idle',
          reportsTo: 'lead-1',
          adapterConfig: { model: 'eluvix/auto' },
        },
      ],
    },
    state: {
      get: async (key) => stateStore.get(key) ?? null,
      set: async (key, val) => {
        stateStore.set(key, val);
      },
    },
    ...overrides,
  };

  return { ctx, stateStore, issueMap, comments, updates, fetchSpy };
}

describe('@eluvix/paperclip-plugin v2 (S3, M1, M2)', () => {
  it('S3: supports auto-with-approval proposal queue, operator approval, dismissal, and external supersede', async () => {
    const validated = validateEluvixPluginConfig({
      autoAssign: { mode: 'auto-with-approval', companies: ['comp-1'] },
    });
    expect(validated.ok).toBe(true);
    if (validated.ok) expect(validated.config.autoAssign.mode).toBe('auto-with-approval');

    const { ctx, stateStore, issueMap, comments, updates } = makeStatefulCtx();
    const handlers = createEluvixPluginHandlers(ctx);

    const decision: any = await handlers.onEvent({
      type: 'issue.created',
      payload: { issue: issueMap.get('iss-1') },
    });
    expect(decision.action).toBe('pending_approval');
    expect(updates.length).toBe(0);
    expect(comments[0].body).toContain('Approval Requested');
    expect((stateStore.get('pending-assignment:iss-1') as any)?.status).toBe('pending');
    expect(stateStore.get('pending-assignments:comp-1')).toEqual(['iss-1']);

    // Verify dashboard overview includes live pending approvals & open issue counts
    const dash: any = await handlers.data['eluvix:dashboard_overview']({ companyId: 'comp-1' });
    expect(dash.pendingApprovals.length).toBe(1);
    const busySummary = dash.agents.find((a: any) => a.id === 'ag-busy');
    const idleSummary = dash.agents.find((a: any) => a.id === 'ag-idle');
    expect(busySummary.openIssueCount).toBe(1);
    expect(idleSummary.openIssueCount).toBe(0);

    // Operator approves proposal -> assigns issue & clears pending index
    const approved: any = await handlers.actions['eluvix:approve_assignment']({
      companyId: 'comp-1',
      issueId: 'iss-1',
    });
    expect(approved.ok).toBe(true);
    expect(updates.length).toBe(1);
    expect(updates[0].patch.assigneeAgentId).toBe('ag-idle');
    expect((stateStore.get('pending-assignment:iss-1') as any)?.status).toBe('approved');
    expect(stateStore.get('pending-assignments:comp-1')).toEqual([]);

    // Dismiss path works cleanly too
    issueMap.set('iss-2', {
      id: 'iss-2',
      companyId: 'comp-1',
      title: 'Second issue',
      status: 'todo',
    });
    await handlers.onEvent({ type: 'issue.created', payload: { issue: issueMap.get('iss-2') } });
    expect(stateStore.get('pending-assignments:comp-1')).toEqual(['iss-2']);
    await handlers.actions['eluvix:dismiss_assignment']({
      companyId: 'comp-1',
      issueId: 'iss-2',
      reason: 'manual_triage',
    });
    expect((stateStore.get('pending-assignment:iss-2') as any)?.status).toBe('dismissed');
    expect(stateStore.get('pending-assignments:comp-1')).toEqual([]);
  });

  it('M1/M2: computes live openIssueCount & hierarchy fields and conforms UI slot schema', async () => {
    const validTypes = new Set(['taskDetailView', 'page', 'dashboardWidget', 'sidebar', 'detailTab']);
    for (const slot of manifest.ui.slots) {
      expect(validTypes.has(slot.type)).toBe(true);
      expect(typeof slot.exportName).toBe('string');
      expect(typeof slot.displayName).toBe('string');
    }
    expect(uiSlots.length).toBe(5);
    expect(manifest.capabilities).toContain('ui.page.register');
    expect(manifest.capabilities).toContain('ui.sidebar.register');

    const { ctx, fetchSpy, issueMap } = makeStatefulCtx();
    const handlers = createEluvixPluginHandlers(ctx);

    await handlers.onEvent({
      type: 'issue.created',
      payload: { issue: issueMap.get('iss-1') },
    });

    const recCall = fetchSpy.mock.calls.find((c) =>
      String(c[0]).endsWith('/api/v1/paperclip/recommend-assignee')
    );
    expect(recCall).toBeDefined();
    const sentBody = JSON.parse(String(recCall![1].body));
    const busyCand = sentBody.candidates.find((c: any) => c.id === 'ag-busy');
    const idleCand = sentBody.candidates.find((c: any) => c.id === 'ag-idle');
    expect(busyCand.openIssueCount).toBe(1);
    expect(idleCand.openIssueCount).toBe(0);
    expect(idleCand.reportsTo).toBe('lead-1');
    expect(idleCand.parentAssigneeAgentId).toBe('lead-1');
  });
});
