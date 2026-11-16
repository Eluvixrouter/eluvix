import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  addMemoryItem,
  BuiltinContextProvider,
  classifyAgentTrajectoryStep,
  computeSemanticCandidateFit,
  DEFAULT_PAPERCLIP_INTEGRATION_CONFIG,
  Eluvix,
  evaluatePaperclipCandidateAssignments,
  getAppPaths,
  getDb,
  getTelemetryDailyRollups,
  logRequest,
  parseVerifiedPaperclipRequestAsync,
  pruneExpiredTelemetry,
  recordAuditEvent,
  recordPaperclipAssignmentOutcome,
  registerAlertWebhook,
  resolveEffectivePaperclipHmacSecret,
  resolveEffectivePaperclipHmacSecretAsync,
  runEvalSuite,
  sanitizePaperclipIntegrationForDisplay,
  sanitizePaperclipKeyPolicyForDisplay,
  signPaperclipContextHeaders,
  STARTER_GOLDEN_EVAL_SUITES,
  verifyAuditChain,
  type RouterConfig,
} from '../index.js';

function makeHybridConfig(overrides: Partial<RouterConfig> = {}): RouterConfig {
  return {
    strategy: 'cost-complexity',
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
        id: 'backup-ollama',
        name: 'Backup Local Ollama',
        type: 'ollama',
        endpoint: 'http://127.0.0.1:11435/v1',
        models: ['qwen2.5-coder:32b'],
        costPer1kTokens: 0,
        tier: 'code',
        priority: 2,
      },
      {
        id: 'cloud-openai',
        name: 'Cloud OpenAI',
        type: 'openai-compatible',
        endpoint: 'https://api.openai.com/v1',
        apiKey: 'sk-test-cloud',
        models: ['gpt-4o', 'o3-mini'],
        costPer1kTokens: 0.015,
        tier: 'reasoning',
        priority: 3,
      },
    ],
    integrations: {
      paperclip: {
        ...DEFAULT_PAPERCLIP_INTEGRATION_CONFIG,
        enabled: true,
      },
    },
    ...overrides,
  };
}

describe('Paperclip v2.1 Enhancements (#1, #4, #5, #6, #7, #8, #9)', () => {
  let tmpConfigDir: string;
  let tmpDataDir: string;
  let origXdgConfig: string | undefined;
  let origXdgData: string | undefined;

  beforeEach(() => {
    origXdgConfig = process.env.XDG_CONFIG_HOME;
    origXdgData = process.env.XDG_DATA_HOME;
    tmpConfigDir = fs.mkdtempSync(path.join(os.tmpdir(), 'eluvix-pc-enh-cfg-'));
    tmpDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'eluvix-pc-enh-data-'));
    process.env.XDG_CONFIG_HOME = tmpConfigDir;
    process.env.XDG_DATA_HOME = tmpDataDir;
  });

  afterEach(() => {
    delete process.env.ELUVIX_PC_TEST_HMAC_SECRET;
    vi.restoreAllMocks();
    if (origXdgConfig === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = origXdgConfig;
    if (origXdgData === undefined) delete process.env.XDG_DATA_HOME;
    else process.env.XDG_DATA_HOME = origXdgData;
    fs.rmSync(tmpConfigDir, { recursive: true, force: true });
    fs.rmSync(tmpDataDir, { recursive: true, force: true });
  });

  it('#1 resolves env: and file: SecretRefs for HMAC verification, never falls back to literal ref text, and masks literals in display serializers', async () => {
    process.env.ELUVIX_PC_TEST_HMAC_SECRET = 'resolved-env-hmac-secret-32chars';
    const appConfigDir = getAppPaths('eluvix').configDir;
    fs.mkdirSync(appConfigDir, { recursive: true });
    const secretFile = path.join(appConfigDir, 'pc-hmac.key');
    fs.writeFileSync(secretFile, 'resolved-file-hmac-secret-32chars\n', { mode: 0o600 });

    const envCfg = {
      ...DEFAULT_PAPERCLIP_INTEGRATION_CONFIG,
      enabled: true,
      hmacSecret: 'env:ELUVIX_PC_TEST_HMAC_SECRET',
      requireSignedContext: true,
    };
    expect(resolveEffectivePaperclipHmacSecret(envCfg)).toBe('resolved-env-hmac-secret-32chars');
    expect(await resolveEffectivePaperclipHmacSecretAsync(envCfg)).toBe('resolved-env-hmac-secret-32chars');

    const fileCfg = {
      ...DEFAULT_PAPERCLIP_INTEGRATION_CONFIG,
      enabled: true,
      hmacSecret: `file:${secretFile}`,
      requireSignedContext: true,
    };
    expect(resolveEffectivePaperclipHmacSecret(fileCfg)).toBe('resolved-file-hmac-secret-32chars');

    // Missing SecretRef must NOT accept its literal "env:MISSING_..." string as a signing key
    const missingRefCfg = {
      ...DEFAULT_PAPERCLIP_INTEGRATION_CONFIG,
      enabled: true,
      hmacSecret: 'env:MISSING_UNSET_HMAC_VAR',
      requireSignedContext: true,
    };
    expect(resolveEffectivePaperclipHmacSecret(missingRefCfg)).toBeUndefined();
    const bogusSigned = signPaperclipContextHeaders(
      { 'x-paperclip-company-id': 'comp-a', 'x-paperclip-run-id': 'run-bogus' },
      'env:MISSING_UNSET_HMAC_VAR'
    );
    const verifiedMissing = await parseVerifiedPaperclipRequestAsync(bogusSigned, {
      config: missingRefCfg,
      hasPaperclipScope: true,
    });
    expect(verifiedMissing.trusted).toBe(false);
    expect(verifiedMissing.signatureStatus).not.toBe('valid');

    // Valid env: SecretRef signature succeeds
    const validSigned = signPaperclipContextHeaders(
      { 'x-paperclip-company-id': 'comp-a', 'x-paperclip-run-id': 'run-valid' },
      'resolved-env-hmac-secret-32chars'
    );
    const verifiedOk = await parseVerifiedPaperclipRequestAsync(validSigned, {
      config: envCfg,
      hasPaperclipScope: true,
    });
    expect(verifiedOk.trusted).toBe(true);
    expect(verifiedOk.signatureStatus).toBe('valid');

    // Display sanitizers keep SecretRefs readable while masking literal secrets
    const maskedIntegration = sanitizePaperclipIntegrationForDisplay({
      ...DEFAULT_PAPERCLIP_INTEGRATION_CONFIG,
      enabled: true,
      hmacSecret: 'literal-raw-secret-never-leak',
    });
    expect(maskedIntegration?.hmacSecret).toBe('litera...leak');
    expect(maskedIntegration?.hmacSigningConfigured).toBe(true);

    const visibleRefIntegration = sanitizePaperclipIntegrationForDisplay(envCfg);
    expect(visibleRefIntegration?.hmacSecret).toBe('env:ELUVIX_PC_TEST_HMAC_SECRET');
    expect(visibleRefIntegration?.hmacSigningConfigured).toBe(true);

    const maskedPolicy = sanitizePaperclipKeyPolicyForDisplay({
      companyIds: ['comp-a'],
      hmacSecret: 'literal-key-secret',
    });
    expect(maskedPolicy?.hmacSecret).toBe('litera...cret');
  });

  it('#4/#7 classifies intra-heartbeat trajectory steps, attaches X-Eluvix-Step-Tier, and dispatches paperclip.tier_escalated on failover', async () => {
    // Initial single user turn -> inactive
    const singleTurn = classifyAgentTrajectoryStep([{ role: 'user', content: 'Hello' }]);
    expect(singleTurn.isAgentLoop).toBe(false);
    expect(singleTurn.stepTier).toBeUndefined();

    // Short tool output with no errors -> fast-local
    expect(
      classifyAgentTrajectoryStep([
        { role: 'user', content: 'Check status' },
        { role: 'assistant', content: null, tool_calls: [{ id: '1', function: { name: 'status' } }] },
        { role: 'tool', tool_call_id: '1', content: '{"ok":true,"files":2}' },
      ])?.stepTier
    ).toBe('fast-local');

    // Code edit/diff tool output -> code-specialist
    expect(
      classifyAgentTrajectoryStep([
        { role: 'user', content: 'Patch router.ts' },
        {
          role: 'assistant',
          content: 'Applying patch',
          tool_calls: [{ id: '2', function: { name: 'apply_patch' } }],
        },
        {
          role: 'tool',
          tool_call_id: '2',
          content: 'diff --git a/src/router.ts b/src/router.ts\n@@ -10,2 +10,3 @@\nexport function route() {}',
        },
      ])?.stepTier
    ).toBe('code-specialist');

    // Stack trace + repeated failures -> heavy-reasoning
    const failureStep = classifyAgentTrajectoryStep([
      { role: 'user', content: 'Run tests' },
      { role: 'assistant', content: 'Running vitest' },
      { role: 'tool', content: 'TypeError: Cannot read properties of undefined\nFAIL src/a.test.ts' },
      { role: 'tool', content: 'AssertionError: expected 200 to be 500\nexit code 1' },
    ]);
    expect(failureStep?.stepTier).toBe('heavy-reasoning');

    const config = makeHybridConfig({
      switchyard: { strategy: 'cost-complexity', agentStepTiering: true },
    });
    const router = new Eluvix(config);

    const trace = router.explainRoute({
      model: 'eluvix/auto',
      messages: [
        { role: 'user', content: 'Debug failing build' },
        { role: 'assistant', content: 'Checking test output' },
        { role: 'tool', content: 'TypeError: AssertionError FAIL exit code 1 Traceback line 42' },
        { role: 'tool', content: 'UnhandledRejection: test failed again' },
      ],
    });
    expect(trace.agentStepTier).toBe('heavy-reasoning');
    expect(trace.steps.some((s) => s.stage === 'agent-step-tier')).toBe(true);

    // Webhook on multi-attempt failover
    registerAlertWebhook({
      name: 'Tier Escalation Hook',
      url: 'http://127.0.0.1:49998/tier-hook',
      events: ['paperclip.tier_escalated'],
      userId: 'tier-user',
    });

    const webhookCalls: Array<{ url: string; event: string | null; body: any }> = [];
    let upstreamAttempts = 0;
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (url: any, init?: RequestInit) => {
      const urlStr = String(url);
      if (urlStr.includes('/tier-hook')) {
        webhookCalls.push({
          url: urlStr,
          event: (init?.headers as any)?.['X-Eluvix-Event'] || null,
          body: JSON.parse(String(init?.body || '{}')),
        });
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      }
      upstreamAttempts += 1;
      if (upstreamAttempts === 1) {
        return new Response('Primary busy', { status: 503 });
      }
      return new Response(
        JSON.stringify({
          id: 'cmpl-tier-esc',
          model: 'qwen2.5-coder:32b',
          choices: [{ message: { role: 'assistant', content: 'Recovered cleanly' }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 20, completion_tokens: 10 },
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      );
    });

    const res = await router.routeChatCompletion(
      {
        model: 'eluvix/auto',
        messages: [
          { role: 'user', content: 'Debug failing build' },
          { role: 'assistant', content: 'Checking test output' },
          { role: 'tool', content: 'TypeError: AssertionError FAIL exit code 1' },
          { role: 'tool', content: 'Test suite failed' },
        ],
      },
      {
        scope: { userId: 'tier-user', origin: 'harness' },
        paperclip: {
          trusted: true,
          droppedHeaders: [],
          companyId: 'comp-a',
          runId: 'run-tier-1',
          issueId: 'iss-tier-1',
          agentId: 'ag-eng',
        },
      }
    );
    expect(res.status).toBe(200);
    expect(res.headers.get('x-eluvix-step-tier')).toBe('heavy-reasoning');
    await new Promise((r) => setTimeout(r, 30));
    expect(webhookCalls.length).toBe(1);
    expect(webhookCalls[0].event).toBe('paperclip.tier_escalated');
    expect(webhookCalls[0].body.data.attemptsMade).toBe(2);
  });

  it('#5 isolates Paperclip episodic memory per company (${userId}::pc:${companyId}) and boosts matching issueId', async () => {
    const provider = new BuiltinContextProvider();
    addMemoryItem({
      userId: 'pc-user::pc:comp-a',
      uri: 'viking://user/pc-user/pc/comp-a/iss-1',
      level: 'L1',
      content: 'Database migration strategy uses PostgreSQL advisory locks for Company Alpha.',
      metadata: { companyId: 'comp-a', issueId: 'iss-other' },
    });
    addMemoryItem({
      userId: 'pc-user::pc:comp-a',
      uri: 'viking://user/pc-user/pc/comp-a/iss-target',
      level: 'L1',
      content: 'Database migration strategy for issue target uses transactional DDL.',
      metadata: { companyId: 'comp-a', issueId: 'iss-target' },
    });
    addMemoryItem({
      userId: 'pc-user::pc:comp-b',
      uri: 'viking://user/pc-user/pc/comp-b/iss-9',
      level: 'L1',
      content: 'Company Beta secret roadmap codename Obsidian.',
      metadata: { companyId: 'comp-b', issueId: 'iss-9' },
    });

    const recallCompA = await provider.recall(
      'Database migration strategy',
      { userId: 'pc-user::pc:comp-a', origin: 'harness', companyId: 'comp-a', issueId: 'iss-target' },
      800
    );
    expect(recallCompA.blocks.length).toBe(2);
    expect(recallCompA.blocks[0].uri).toBe('viking://user/pc-user/pc/comp-a/iss-target');
    expect(recallCompA.blocks.some((b) => b.text.includes('Obsidian'))).toBe(false);

    const recallCompB = await provider.recall(
      'Obsidian PostgreSQL advisory locks',
      { userId: 'pc-user::pc:comp-b', origin: 'harness', companyId: 'comp-b' },
      800
    );
    expect(recallCompB.blocks.length).toBe(1);
    expect(recallCompB.blocks[0].text).toContain('Obsidian');
  });

  it('#6/#7 caches candidate embeddings in SQLite paperclip_embedding_cache and emits paperclip.budget_forecast webhook once per day', async () => {
    const embedCalls: Array<string | string[]> = [];
    const mockRouter = {
      getUpstreams: () => [
        {
          id: 'local-embed',
          healthy: true,
          modalities: ['embedding'],
          models: ['nomic-embed-text'],
        },
      ],
      routeEmbeddings: async (req: { model?: string; input: string | string[] }) => {
        embedCalls.push(req.input);
        const inputs = Array.isArray(req.input) ? req.input : [req.input];
        return new Response(
          JSON.stringify({
            data: inputs.map((text, idx) => ({
              index: idx,
              embedding: text.toLowerCase().includes('rust') ? [1, 0, 0] : [0, 1, 0],
            })),
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        );
      },
    };

    const candidates = [
      { id: 'ag-rust', name: 'Rust Systems Engineer', role: 'engineer', capabilities: 'rust systems', status: 'idle', budgetMonthlyCents: 1000, spentMonthlyCents: 990 },
      { id: 'ag-ui', name: 'Frontend Designer', role: 'designer', capabilities: 'css figma', status: 'idle', budgetMonthlyCents: 10000, spentMonthlyCents: 100 },
    ];

    // 1st call: embeds [taskText, cand1, cand2] (3 texts)
    const fit1 = await computeSemanticCandidateFit(
      mockRouter,
      { title: 'Optimize Rust scheduler', priority: 'high' },
      candidates,
      true
    );
    expect(fit1?.['ag-rust']).toBeGreaterThan(fit1?.['ag-ui'] ?? 0);
    expect(Array.isArray(embedCalls[0]) ? embedCalls[0].length : 0).toBe(3);

    // 2nd call with different task: candidates hit cache, only [taskText] (1 text) is embedded
    const fit2 = await computeSemanticCandidateFit(
      mockRouter,
      { title: 'Rewrite Rust memory allocator', priority: 'high' },
      candidates,
      true
    );
    expect(fit2?.['ag-rust']).toBeGreaterThan(fit2?.['ag-ui'] ?? 0);
    expect(Array.isArray(embedCalls[1]) ? embedCalls[1].length : 0).toBe(1);

    // Record high daily burn for ag-rust to trigger <3d runway forecast webhook
    recordPaperclipAssignmentOutcome({
      userId: 'forecast-user',
      companyId: 'comp-a',
      issueId: 'iss-burn-1',
      agentId: 'ag-rust',
      taskClass: 'code',
      success: true,
      costUsd: 5.0,
    });
    registerAlertWebhook({
      name: 'Budget Forecast Hook',
      url: 'http://127.0.0.1:49997/forecast-hook',
      events: ['paperclip.budget_forecast'],
      userId: 'forecast-user',
    });

    const hookEvents: string[] = [];
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (url: any, init?: RequestInit) => {
      if (String(url).includes('/forecast-hook')) {
        hookEvents.push(String((init?.headers as any)?.['X-Eluvix-Event'] || ''));
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      }
      return new Response('{}', { status: 404 });
    });

    await evaluatePaperclipCandidateAssignments({
      router: mockRouter,
      task: { title: 'Fix Rust borrow checker error', priority: 'high' },
      candidates,
      fleet: [],
      userId: 'forecast-user',
      companyIds: ['comp-a'],
      useEmbeddings: true,
    });
    await new Promise((r) => setTimeout(r, 30));
    expect(hookEvents).toEqual(['paperclip.budget_forecast']);

    // Second invocation same UTC day is deduplicated
    await evaluatePaperclipCandidateAssignments({
      router: mockRouter,
      task: { title: 'Another Rust task', priority: 'medium' },
      candidates,
      fleet: [],
      userId: 'forecast-user',
      companyIds: ['comp-a'],
      useEmbeddings: true,
    });
    await new Promise((r) => setTimeout(r, 20));
    expect(hookEvents.length).toBe(1);
  });

  it('#8 passes the paperclip-org-governance starter golden eval suite in dry-run mode', async () => {
    const suite = STARTER_GOLDEN_EVAL_SUITES.find((s) => s.id === 'paperclip-org-governance');
    expect(suite).toBeDefined();
    const report = await runEvalSuite(suite!, makeHybridConfig(), { mode: 'dry-run' });
    expect(report.totalCases).toBe(4);
    expect(report.passed).toBe(true);
    expect(report.failedCases).toBe(0);
  });

  it('#9 maintains telemetry_daily_rollups across pruneExpiredTelemetry while preserving audit_events hash chain', () => {
    const recentIso = new Date().toISOString();
    const oldSqlDate = '2020-01-15 12:00:00';

    logRequest({
      timestamp: recentIso,
      model: 'llama3.2:latest',
      upstream_id: 'local-ollama',
      status: 200,
      duration_ms: 40,
      prompt_tokens: 100,
      completion_tokens: 50,
      cost_usd: 0.01,
      user_id: 'ret-user',
      pc_company_id: 'comp-a',
    });
    logRequest({
      timestamp: oldSqlDate,
      model: 'gpt-4o',
      upstream_id: 'cloud-openai',
      status: 500,
      duration_ms: 120,
      prompt_tokens: 200,
      completion_tokens: 0,
      cost_usd: 0.04,
      user_id: 'ret-user',
      pc_company_id: 'comp-a',
    });
    // Backdate the raw log and rollup row to 2020-01-15 so pruneExpiredTelemetry(30) targets only the expired raw row
    getDb()
      .prepare('UPDATE request_logs SET timestamp = ? WHERE user_id = ? AND model = ?')
      .run(oldSqlDate, 'ret-user', 'gpt-4o');
    getDb()
      .prepare('UPDATE telemetry_daily_rollups SET day_utc = ? WHERE user_id = ? AND model = ?')
      .run('2020-01-15', 'ret-user', 'gpt-4o');
    recordAuditEvent({
      actorId: 'admin',
      actorRole: 'admin',
      action: 'keys.created',
      resourceType: 'api_key',
      resourceId: 'key-1',
    });

    const rollupsBefore = getTelemetryDailyRollups(3650, 'ret-user', 'comp-a');
    expect(rollupsBefore.length).toBe(2);

    const pruned = pruneExpiredTelemetry(30, 'ret-user');
    expect(pruned.deletedRequestLogs).toBe(1);

    // Daily rollups remain intact even though the raw 2020 request_logs row was pruned
    const rollupsAfter = getTelemetryDailyRollups(3650, 'ret-user', 'comp-a');
    expect(rollupsAfter.length).toBe(2);

    const remainingRaw = getDb()
      .prepare('SELECT COUNT(*) as c FROM request_logs WHERE user_id = ?')
      .get('ret-user') as { c: number };
    expect(remainingRaw.c).toBe(1);

    const auditVerification = verifyAuditChain();
    expect(auditVerification.valid).toBe(true);
    expect(auditVerification.checkedCount).toBeGreaterThanOrEqual(1);
  });
});
