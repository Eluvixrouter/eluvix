import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Eluvix, type RouterConfig } from '../index.js';
import {
  clearApiKeysCache,
  createNamedApiKey,
  resolveBearerToken,
} from '../auth.js';
import { getDb, logRequest } from '../db.js';
import {
  DEFAULT_PAPERCLIP_INTEGRATION_CONFIG,
  resolvePaperclipRoutingBias,
} from '../paperclip-context.js';
import {
  parseVerifiedPaperclipRequest,
  signPaperclipContextHeaders,
  verifyPaperclipContextSignature,
} from '../paperclip-auth.js';
import {
  cosineSimilarity,
  recommendPaperclipAssignees,
} from '../paperclip-assign.js';
import {
  evaluatePaperclipCandidateAssignments,
  getPaperclipAgentBurnRates,
  getPaperclipObservabilitySummary,
  getPaperclipOutcomePriors,
  getPaperclipUsageByCorrelation,
  recordPaperclipAssignmentOutcome,
  recordPaperclipIssueClassification,
  resolveAndRecordPaperclipFeedback,
} from '../paperclip-store.js';

function makeTestConfig(overrides: Partial<RouterConfig> = {}): RouterConfig {
  return {
    strategy: 'lowest-latency',
    upstreams: [
      {
        id: 'local-ollama',
        name: 'Local Ollama',
        type: 'ollama',
        endpoint: 'http://127.0.0.1:11434/v1',
        models: ['llama3.2:latest', 'qwen2.5-coder:7b'],
        costPer1kTokens: 0,
        tier: 'fast',
        priority: 1,
      },
      {
        id: 'cloud-openai',
        name: 'Cloud OpenAI',
        type: 'openai-compatible',
        endpoint: 'https://api.openai.com/v1',
        apiKey: 'sk-test-cloud',
        models: ['gpt-4o', 'o3-mini'],
        costPer1kTokens: 0.01,
        tier: 'reasoning',
        priority: 2,
      },
    ],
    integrations: {
      paperclip: {
        ...DEFAULT_PAPERCLIP_INTEGRATION_CONFIG,
        enabled: true,
        hmacSecret: 'test-paperclip-secret-32chars-xyz',
      },
    },
    ...overrides,
  };
}

describe('Paperclip v2 Security, Allocation & Learning (@eluvix/router-core)', () => {
  let tmpConfigDir: string;
  let tmpDataDir: string;
  let origXdgConfig: string | undefined;
  let origXdgData: string | undefined;

  beforeEach(() => {
    origXdgConfig = process.env.XDG_CONFIG_HOME;
    origXdgData = process.env.XDG_DATA_HOME;
    tmpConfigDir = fs.mkdtempSync(path.join(os.tmpdir(), 'eluvix-pcv2-cfg-'));
    tmpDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'eluvix-pcv2-data-'));
    process.env.XDG_CONFIG_HOME = tmpConfigDir;
    process.env.XDG_DATA_HOME = tmpDataDir;
    clearApiKeysCache();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    clearApiKeysCache();
    if (origXdgConfig === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = origXdgConfig;
    if (origXdgData === undefined) delete process.env.XDG_DATA_HOME;
    else process.env.XDG_DATA_HOME = origXdgData;
    fs.rmSync(tmpConfigDir, { recursive: true, force: true });
    fs.rmSync(tmpDataDir, { recursive: true, force: true });
  });

  it('S1: signs and verifies HMAC-SHA256 Paperclip context headers and drops tampered/expired headers', () => {
    const secret = 'super-secret-hmac-key';
    const nowMs = 1_760_000_000_000;
    const rawHeaders: Record<string, string> = {
      'x-paperclip-company-id': 'comp-1',
      'x-paperclip-agent-id': 'agent-1',
      'x-paperclip-run-id': 'run-1',
      'x-paperclip-issue-id': 'iss-1',
      'x-paperclip-issue-priority': 'critical',
      'x-paperclip-sensitivity': 'confidential',
    };
    const signed = signPaperclipContextHeaders(rawHeaders, secret, String(nowMs));

    expect(
      verifyPaperclipContextSignature(signed, { secret, nowMs }).status
    ).toBe('valid');

    // Tampering with priority invalidates signature
    const tampered = { ...signed, 'x-paperclip-issue-priority': 'low' };
    expect(
      verifyPaperclipContextSignature(tampered, { secret, nowMs }).status
    ).toBe('invalid');

    const pcCfg = {
      ...DEFAULT_PAPERCLIP_INTEGRATION_CONFIG,
      enabled: true,
      hmacSecret: secret,
      requireSignedContext: true,
    };
    const droppedParsed = parseVerifiedPaperclipRequest(tampered, {
      config: pcCfg,
      hasPaperclipScope: true,
      nowMs,
    });
    expect(droppedParsed.signatureStatus).toBe('invalid');
    expect(droppedParsed.trusted).toBe(false);
    expect(droppedParsed.droppedHeaders).toContain('x-paperclip-context-sig');
    expect(resolvePaperclipRoutingBias(droppedParsed, pcCfg).active).toBe(false);

    // Expired signature (>300s skew)
    const expiredParsed = parseVerifiedPaperclipRequest(signed, {
      config: pcCfg,
      hasPaperclipScope: true,
      nowMs: nowMs + 310_000,
    });
    expect(expiredParsed.signatureStatus).toBe('expired');
    expect(expiredParsed.trusted).toBe(false);
    expect(resolvePaperclipRoutingBias(expiredParsed, pcCfg).active).toBe(false);

    // Unsigned when requireSignedContext=true drops privileged bias trust
    const unsignedParsed = parseVerifiedPaperclipRequest(rawHeaders, {
      config: pcCfg,
      hasPaperclipScope: true,
      nowMs,
    });
    expect(unsignedParsed.signatureStatus).toBe('unsigned');
    expect(unsignedParsed.trusted).toBe(false);
    expect(resolvePaperclipRoutingBias(unsignedParsed, pcCfg).active).toBe(false);
  });

  it('S2: enforces per-key Paperclip maxTier/maxCost ceilings and SQLite company scoping', async () => {
    const created = await createNamedApiKey({
      name: 'comp-a-worker',
      userId: 'user-pc',
      scopes: ['chat', 'paperclip'],
      paperclip: {
        companyIds: ['comp-a'],
        maxTier: 'code-specialist',
        maxCostPer1kUsd: 0.002,
      },
    });
    expect(created.key).toMatch(/^elx_/);

    const resolved = await resolveBearerToken(created.key!);
    expect(resolved?.paperclip?.companyIds).toEqual(['comp-a']);
    expect(resolved?.paperclip?.maxTier).toBe('code-specialist');
    expect(resolved?.paperclip?.maxCostPer1kUsd).toBe(0.002);

    // Ceiling clamps critical request down to code-specialist & $0.002/1k
    const bias = resolvePaperclipRoutingBias(
      {
        trusted: true,
        priority: 'critical',
        companyId: 'comp-a',
        keyPolicy: resolved?.paperclip,
        droppedHeaders: [],
      },
      {
        ...DEFAULT_PAPERCLIP_INTEGRATION_CONFIG,
        enabled: true,
      }
    );
    expect(bias.maxTier).toBe('code-specialist');
    expect(bias.minTier).toBe('code-specialist');
    expect(bias.maxCostPer1kUsd).toBe(0.002);
    expect(bias.biasTags).toContain('key-tier-ceiling');
    expect(bias.biasTags).toContain('key-cost-ceiling');

    // Router selects local-ollama ($0) rather than cloud-openai ($0.01) under key cost ceiling
    const router = new Eluvix(makeTestConfig());
    const explained = router.explainRoute(
      { model: 'eluvix/frontier-verified', messages: [{ role: 'user', content: 'Prove theorem X' }] },
      {
        paperclip: {
          trusted: true,
          priority: 'critical',
          keyPolicy: resolved?.paperclip,
          droppedHeaders: [],
        },
      }
    );
    expect(explained.chosenUpstreamId).toBe('local-ollama');

    // Company scoping in SQLite prevents cross-company leaks even within same userId
    logRequest({
      timestamp: new Date().toISOString(),
      model: 'gpt-4o',
      upstream_id: 'cloud-openai',
      status: 200,
      duration_ms: 120,
      prompt_tokens: 10,
      completion_tokens: 20,
      cost_usd: 0.004,
      user_id: 'user-pc',
      correlation_id: 'run-comp-b',
      pc_company_id: 'comp-b',
    });
    const deniedUsage = getPaperclipUsageByCorrelation('run-comp-b', 'user-pc', ['comp-a']);
    expect(deniedUsage.requests).toBe(0);
    const allowedUsage = getPaperclipUsageByCorrelation('run-comp-b', 'user-pc', ['comp-b']);
    expect(allowedUsage.requests).toBe(1);

    recordPaperclipIssueClassification({
      issueId: 'iss-comp-b',
      userId: 'user-pc',
      companyId: 'comp-b',
      taskClass: 'code:moderate',
    });
    resolveAndRecordPaperclipFeedback({
      issueId: 'iss-comp-b',
      agentId: 'ag-1',
      userId: 'user-pc',
      companyId: 'comp-b',
      allowedCompanyIds: ['comp-b'],
      success: true,
    });
    const wrongCompanyPriors = getPaperclipOutcomePriors('code:moderate', 'user-pc', ['comp-a']);
    expect(wrongCompanyPriors['ag-1']).toBeUndefined();
    const rightCompanyPriors = getPaperclipOutcomePriors('code:moderate', 'user-pc', ['comp-b']);
    expect(rightCompanyPriors['ag-1']?.wins).toBe(1);
  });

  it('E1/E2/E3/E5: combines embeddings semantic fit, decayed cost-weighted Beta priors, budget forecast, and hierarchy affinity', async () => {
    expect(cosineSimilarity([1, 0], [1, 0])).toBeCloseTo(1, 5);
    expect(cosineSimilarity([1, 0], [0, 1])).toBeCloseTo(0, 5);

    const nowMs = Date.UTC(2026, 10, 14, 12, 0, 0);
    const oldTs = new Date(nowMs - 60 * 86_400_000).toISOString();
    const recentTs = new Date(nowMs - 1 * 86_400_000).toISOString();

    const db = getDb();
    recordPaperclipAssignmentOutcome({
      issueId: 'iss-old',
      agentId: 'ag-1',
      companyId: 'comp-1',
      taskClass: 'code:moderate',
      success: true,
      costUsd: 0.001,
    });
    recordPaperclipAssignmentOutcome({
      issueId: 'iss-new',
      agentId: 'ag-2',
      companyId: 'comp-1',
      taskClass: 'code:moderate',
      success: true,
      costUsd: 0.001,
    });
    db.prepare(`UPDATE paperclip_assignment_outcomes SET timestamp = ? WHERE issue_id = 'iss-old'`).run(oldTs);
    db.prepare(`UPDATE paperclip_assignment_outcomes SET timestamp = ? WHERE issue_id = 'iss-new'`).run(recentTs);

    const priors = getPaperclipOutcomePriors('code:moderate', 'default', ['comp-1'], {
      decayHalfLifeDays: 30,
      nowMs,
    });
    // ag-2's win yesterday decays far less than ag-1's win 60 days ago
    expect(priors['ag-2'].alpha!).toBeGreaterThan(priors['ag-1'].alpha!);

    // Log 7d burn rate for ag-burn so its budget exhaustion forecast triggers
    logRequest({
      timestamp: new Date().toISOString(),
      model: 'gpt-4o',
      upstream_id: 'cloud-openai',
      status: 200,
      duration_ms: 300,
      prompt_tokens: 100,
      completion_tokens: 200,
      cost_usd: 7.0, // $1.00/day = 100 cents/day
      user_id: 'default',
      pc_company_id: 'comp-1',
      pc_agent_id: 'ag-burn',
    });
    const burnRates = getPaperclipAgentBurnRates(['ag-burn', 'ag-2'], 7, ['comp-1']);
    expect(burnRates['ag-burn']).toBeCloseTo(100, 1);

    // Hierarchy affinity + budget forecast + Thompson deterministic seed
    const recRes = recommendPaperclipAssignees(
      {
        title: 'Build payments API integration',
        priority: 'high',
        parentAssigneeAgentId: 'lead-1',
      },
      [
        {
          id: 'ag-burn',
          name: 'High Burn Engineer',
          role: 'engineer',
          capabilities: 'payments api integration',
          budgetMonthlyCents: 1000,
          spentMonthlyCents: 900, // only $1 left @ $1/day => ~1d runway
        },
        {
          id: 'ag-2',
          name: 'Direct Report Engineer',
          role: 'engineer',
          capabilities: 'payments api integration',
          reportsTo: 'lead-1',
          budgetMonthlyCents: 5000,
          spentMonthlyCents: 200,
        },
      ],
      [],
      undefined,
      priors,
      {
        burnRatesCentsPerDay: burnRates,
        thompsonSample: true,
        thompsonSeed: 42,
        nowMs,
      }
    );

    expect(recRes.recommendations[0].agentId).toBe('ag-2');
    expect(recRes.recommendations[1].budgetForecast?.projectedDaysRemaining).toBe(1);
    expect(recRes.recommendations[1].breakdown.budget).toBeLessThan(0.1);

    // E1: evaluatePaperclipCandidateAssignments uses routeEmbeddings when embedding upstream configured & falls back gracefully
    const mockRouter = {
      getUpstreams: () => [
        {
          id: 'embed-up',
          healthy: true,
          modalities: ['embedding'],
          models: ['nomic-embed-text'],
        },
      ],
      routeEmbeddings: async () =>
        new Response(
          JSON.stringify({
            data: [
              { embedding: [1, 0, 0] },
              { embedding: [0.05, 0.99, 0] },
              { embedding: [0.98, 0.1, 0] },
            ],
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        ),
    };
    const evalSemantic = await evaluatePaperclipCandidateAssignments({
      router: mockRouter,
      task: { title: 'Unrelated generic title' },
      candidates: [
        { id: 'c1', name: 'C1' },
        { id: 'c2', name: 'C2' },
      ],
      fleet: [],
    });
    expect(evalSemantic.semanticFitUsed).toBe(true);
    expect(evalSemantic.recommendations[0].agentId).toBe('c2');

    const evalFallback = await evaluatePaperclipCandidateAssignments({
      router: {
        getUpstreams: () => [{ id: 'embed-up', healthy: true, modalities: ['embedding'] }],
        routeEmbeddings: async () => new Response('fail', { status: 503 }),
      },
      task: { title: 'Write SQL migration' },
      candidates: [
        { id: 'sql-dev', name: 'SQL Dev', capabilities: 'sql migration postgres' },
        { id: 'art-dev', name: 'Designer', capabilities: 'figma css' },
      ],
      fleet: [],
    });
    expect(evalFallback.semanticFitUsed).toBe(false);
    expect(evalFallback.recommendations[0].agentId).toBe('sql-dev');
  });

  it('E6: emits paperclip.* OTLP span attributes and summarizes Paperclip observability telemetry', async () => {
    const capturedBodies: any[] = [];
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (url: any, init: any) => {
      const urlStr = String(url);
      if (urlStr.includes(':4318/v1/traces')) {
        capturedBodies.push(JSON.parse(String(init.body)));
        return new Response('{}', { status: 200 });
      }
      if (urlStr.includes('/chat/completions')) {
        return new Response(
          JSON.stringify({
            id: 'chat-pc-otel',
            model: 'llama3.2:latest',
            choices: [{ message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
            usage: { prompt_tokens: 15, completion_tokens: 5 },
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        );
      }
      return new Response('not found', { status: 404 });
    });

    const router = new Eluvix(
      makeTestConfig({
        observability: {
          exporter: 'otlp',
          otlpEndpoint: 'http://127.0.0.1:4318/v1/traces',
          sampleRate: 1,
        } as any,
      })
    );

    const res = await router.routeChatCompletion(
      { model: 'eluvix/fast-local', messages: [{ role: 'user', content: 'ping' }] },
      {
        paperclip: {
          trusted: true,
          runId: 'run-otel-1',
          issueId: 'iss-otel-1',
          agentId: 'agent-otel-1',
          companyId: 'comp-otel-1',
          priority: 'high',
          droppedHeaders: [],
        },
      }
    );
    expect(res.status).toBe(200);
    await new Promise((r) => setTimeout(r, 20));
    expect(capturedBodies.length).toBeGreaterThan(0);

    const attrs =
      capturedBodies[0].resourceSpans?.[0]?.scopeSpans?.[0]?.spans?.[0]?.attributes || [];
    const attrMap = Object.fromEntries(attrs.map((a: any) => [a.key, a.value?.stringValue]));
    expect(attrMap['paperclip.run_id']).toBe('run-otel-1');
    expect(attrMap['paperclip.issue_id']).toBe('iss-otel-1');
    expect(attrMap['paperclip.agent_id']).toBe('agent-otel-1');
    expect(attrMap['paperclip.company_id']).toBe('comp-otel-1');
    expect(attrMap['paperclip.priority']).toBe('high');

    const summary = getPaperclipObservabilitySummary();
    expect(summary.totalRequests).toBeGreaterThanOrEqual(1);
    expect(summary.recentRuns.some((r) => r.runId === 'run-otel-1' && r.issueId === 'iss-otel-1')).toBe(true);
  });
});
