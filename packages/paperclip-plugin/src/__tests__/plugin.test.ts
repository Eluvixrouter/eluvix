import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  computeIssueTreeDepth,
  createEluvixPluginHandlers,
  DEFAULT_AUTO_ASSIGN_CONFIG,
  ELUVIX_PLUGIN_ID,
  handleUnassignedIssueEvent,
  hashAdvisoryContent,
  isRateLimited,
  manifest,
  validateEluvixPluginConfig,
} from '../index.js';

function makeHostCtx(overrides: Record<string, unknown> = {}) {
  const comments: Array<{ issueId: string; body: string }> = [];
  const updates: Array<{ issueId: string; patch: Record<string, unknown> }> = [];
  const stateStore = new Map<string, unknown>();

  const ctx = {
    config: {
      eluvixBaseUrl: 'http://127.0.0.1:3588',
      autoAssign: {
        ...DEFAULT_AUTO_ASSIGN_CONFIG,
        mode: 'advisory' as const,
        minConfidence: 0.72,
        maxAssignmentsPerHour: 20,
        maxTreeDepth: 2,
        excludeRoles: ['ceo'],
        excludeAgentIds: [],
        requireLocalOnlyForConfidential: true,
      },
    },
    agents: {
      list: vi.fn().mockResolvedValue([
        {
          id: 'agt-coder',
          companyId: 'cmp-1',
          name: 'TypeScript Engineer',
          role: 'engineer',
          capabilities: 'typescript, vitest, sql',
          adapterType: 'eluvix_local',
          adapterConfig: { model: 'eluvix/code-specialist' },
          status: 'idle',
          budgetMonthlyCents: 10000,
          spentMonthlyCents: 1000,
        },
        {
          id: 'agt-ceo',
          companyId: 'cmp-1',
          name: 'CEO',
          role: 'ceo',
          capabilities: 'strategy',
          adapterType: 'claude_local',
          status: 'idle',
        },
      ]),
    },
    issues: {
      get: vi.fn().mockResolvedValue({
        id: 'iss-1',
        companyId: 'cmp-1',
        title: 'Fix SQLite migration in TypeScript',
        description: 'Add Vitest coverage',
        status: 'todo',
        priority: 'high',
        assigneeAgentId: null,
        checkoutRunId: null,
        parentId: null,
      }),
      update: vi.fn(async (issueId: string, _companyId: string, patch: Record<string, unknown>) => {
        updates.push({ issueId, patch });
        return { id: issueId, ...patch };
      }),
      addComment: vi.fn(async (issueId: string, _companyId: string, body: string) => {
        comments.push({ issueId, body });
      }),
      listComments: vi.fn(async (issueId: string) =>
        comments.filter((c) => c.issueId === issueId).map((c) => ({ body: c.body }))
      ),
    },
    state: {
      get: vi.fn(async (key: string) => stateStore.get(key) ?? null),
      set: vi.fn(async (key: string, value: unknown) => {
        stateStore.set(key, value);
      }),
    },
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    fetch: vi.fn(async (url: string, init?: RequestInit) => {
      if (url.includes('/api/v1/paperclip/capabilities')) {
        return new Response(JSON.stringify({ strategy: 'lowest-latency', upstreams: [] }), { status: 200 });
      }
      if (url.includes('/api/v1/paperclip/classify')) {
        return new Response(
          JSON.stringify({ taskClass: 'code', suggestedTier: 'code-specialist', sensitivity: 'internal' }),
          { status: 200 }
        );
      }
      if (url.includes('/api/v1/paperclip/recommend-assignee')) {
        return new Response(
          JSON.stringify({
            classification: { taskClass: 'code', suggestedTier: 'code-specialist', sensitivity: 'internal' },
            recommendations: [
              {
                agentId: 'agt-coder',
                name: 'TypeScript Engineer',
                score: 0.91,
                confidence: 0.89,
                estimatedCostUsd: 0.002,
                estimatedLatencyMs: 350,
                rationale: 'Strong TypeScript + SQLite fit',
              },
            ],
            excluded: [],
          }),
          { status: 200 }
        );
      }
      if (url.includes('/api/v1/paperclip/whoami')) {
        return new Response(JSON.stringify({ userId: 'u1', scopes: ['paperclip'] }), { status: 200 });
      }
      if (url.includes('/api/v1/route-explain')) {
        return new Response(JSON.stringify({ chosenUpstreamId: 'local-ollama' }), { status: 200 });
      }
      if (url.includes('/api/v1/paperclip/feedback')) {
        return new Response(JSON.stringify({ ok: true, method: init?.method }), { status: 200 });
      }
      return new Response('{}', { status: 200 });
    }) as unknown as typeof fetch,
    comments,
    updates,
    ...overrides,
  };
  return ctx;
}

describe('@eluvix/paperclip-plugin', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('validates plugin config and exposes manifest with 5 Switchyard tools', () => {
    expect(manifest.id).toBe(ELUVIX_PLUGIN_ID);
    expect(manifest.tools.length).toBe(5);
    expect(validateEluvixPluginConfig({ eluvixBaseUrl: 'ftp://bad' }).ok).toBe(false);
    const valid = validateEluvixPluginConfig({ autoAssign: { mode: 'auto', minConfidence: 0.8 } });
    expect(valid.ok).toBe(true);
    if (valid.ok) {
      expect(valid.config.autoAssign.mode).toBe('auto');
    }
  });

  it('executes Switchyard plugin tools cleanly', async () => {
    const ctx = makeHostCtx();
    const handlers = createEluvixPluginHandlers(ctx as any);

    const cap = await handlers.tools['eluvix:capabilities']();
    expect((cap as any).strategy).toBe('lowest-latency');

    const cls = await handlers.tools['eluvix:classify_task']({ title: 'Test', description: 'Fix bug' });
    expect((cls as any).taskClass).toBe('code');

    const rec = await handlers.tools['eluvix:recommend_assignee'](
      { title: 'Fix SQLite migration', description: 'TypeScript + Vitest' },
      { companyId: 'cmp-1' }
    );
    expect((rec as any).recommendations[0].agentId).toBe('agt-coder');

    const exp = await handlers.tools['eluvix:explain_route']({ model: 'eluvix/auto', prompt: 'Hello' });
    expect((exp as any).chosenUpstreamId).toBe('local-ollama');

    const bdg = await handlers.tools['eluvix:budget']();
    expect((bdg as any).userId).toBe('u1');
  });

  it('handles off, advisory (with dedupe), shadow, and auto modes safely', async () => {
    const issue = {
      id: 'iss-1',
      companyId: 'cmp-1',
      title: 'Fix SQLite migration in TypeScript',
      description: 'Add Vitest coverage',
      status: 'todo',
      priority: 'high' as const,
      assigneeAgentId: null,
      checkoutRunId: null,
      parentId: null,
    };

    // 1. off
    const offCtx = makeHostCtx({
      config: {
        eluvixBaseUrl: 'http://127.0.0.1:3588',
        autoAssign: { ...DEFAULT_AUTO_ASSIGN_CONFIG, mode: 'off' },
      },
    });
    const offRes = await handleUnassignedIssueEvent(issue, offCtx as any, 'elx_test');
    expect(offRes.action).toBe('skipped');

    // 2. advisory + dedupe
    const advCtx = makeHostCtx();
    const adv1 = await handleUnassignedIssueEvent(issue, advCtx as any, 'elx_test');
    expect(adv1.action).toBe('advisory');
    expect(advCtx.comments.length).toBe(1);
    const adv2 = await handleUnassignedIssueEvent(issue, advCtx as any, 'elx_test');
    expect(adv2.action).toBe('advisory');
    expect(advCtx.comments.length).toBe(1);

    // 3. shadow (no comment, no update)
    const shdCtx = makeHostCtx({
      config: {
        eluvixBaseUrl: 'http://127.0.0.1:3588',
        autoAssign: { ...DEFAULT_AUTO_ASSIGN_CONFIG, mode: 'shadow' },
      },
    });
    const shdRes = await handleUnassignedIssueEvent(issue, shdCtx as any, 'elx_test');
    expect(shdRes.action).toBe('shadow');
    expect(shdCtx.comments.length).toBe(0);
    expect(shdCtx.updates.length).toBe(0);

    // 4. auto (assigns when unlocked & above minConfidence)
    const autoCtx = makeHostCtx({
      config: {
        eluvixBaseUrl: 'http://127.0.0.1:3588',
        autoAssign: {
          ...DEFAULT_AUTO_ASSIGN_CONFIG,
          mode: 'auto',
          companies: ['cmp-1'],
          minConfidence: 0.72,
          maxPerHour: 20,
          maxTreeDepth: 2,
        },
      },
    });
    const autoRes = await handleUnassignedIssueEvent(issue, autoCtx as any, 'elx_test');
    expect(autoRes.action).toBe('auto_assigned');
    expect(autoRes.topAgentId).toBe('agt-coder');
    expect(autoCtx.updates.length).toBe(1);
    expect(autoCtx.updates[0].patch.assigneeAgentId).toBe('agt-coder');
  });

  it('refuses auto-assign if issue is already checked out or already assigned', async () => {
    const autoCtx = makeHostCtx({
      config: {
        eluvixBaseUrl: 'http://127.0.0.1:3588',
        autoAssign: { ...DEFAULT_AUTO_ASSIGN_CONFIG, mode: 'auto', minConfidence: 0.72 },
      },
    });
    const lockedRes = await handleUnassignedIssueEvent(
      {
        id: 'iss-locked',
        companyId: 'cmp-1',
        title: 'Locked task',
        status: 'todo',
        checkoutRunId: 'run-active',
        assigneeAgentId: null,
      },
      autoCtx as any,
      'elx_test'
    );
    expect(lockedRes.action).toBe('skipped');
    expect(autoCtx.updates.length).toBe(0);
  });

  it('enforces rate limiting and maxTreeDepth guards', async () => {
    expect(isRateLimited([Date.now(), Date.now()], 2)).toBe(true);
    expect(isRateLimited([Date.now()], 2)).toBe(false);
    expect(hashAdvisoryContent('i1', 'a1', 'why')).toHaveLength(16);

    const ctx = makeHostCtx();
    (ctx.issues.get as any)
      .mockResolvedValueOnce({ id: 'p1', companyId: 'cmp-1', parentId: 'p2' })
      .mockResolvedValueOnce({ id: 'p2', companyId: 'cmp-1', parentId: null });
    const depth = await computeIssueTreeDepth(
      { id: 'leaf', companyId: 'cmp-1', title: 'Leaf', status: 'todo', parentId: 'p1' },
      ctx as any
    );
    expect(depth).toBe(2);
  });
});
