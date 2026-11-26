#!/usr/bin/env node
/**
 * Eluvix x Paperclip End-to-End Integration Harness (`scripts/paperclip-e2e.mjs`)
 *
 * Runs completely offline using ephemeral loopback HTTP servers and isolated
 * temporary XDG_CONFIG_HOME / XDG_DATA_HOME directories to verify the full stack:
 *   1. Scoped API key creation with Paperclip company & tier/cost ceilings (S2)
 *   2. HMAC-SHA256 signed Paperclip context verification & routing ceiling enforcement (S1/S2)
 *   3. Task classification + semantic/burn-rate/hierarchy-aware assignee ranking (E1/E3/E5)
 *   4. `@eluvix/paperclip-plugin` `auto-with-approval` -> approve -> feedback -> re-rank (S3/E2)
 *   5. `@eluvix/paperclip-adapter` mid-run virtual tier escalation & usage correlation (E4)
 *   6. Paperclip HTTP routes (`recommend-assignee`, `classify`, `feedback`,
 *      `usage`) exercised over loopback fetch — not just defined.
 *
 * An overall watchdog (ELUVIX_E2E_TIMEOUT_MS, default 120s) fails the run
 * instead of hanging CI: the script is offline and mock-based, so a hang
 * is always a bug, never a slow network.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

const origXdgConfig = process.env.XDG_CONFIG_HOME;
const origXdgData = process.env.XDG_DATA_HOME;
const tmpConfigDir = fs.mkdtempSync(path.join(os.tmpdir(), 'eluvix-e2e-cfg-'));
const tmpDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'eluvix-e2e-data-'));
process.env.XDG_CONFIG_HOME = tmpConfigDir;
process.env.XDG_DATA_HOME = tmpDataDir;

// Overall watchdog: fail loudly instead of hanging CI if any step stalls.
const E2E_TIMEOUT_MS = Number(process.env.ELUVIX_E2E_TIMEOUT_MS || 120_000);
const e2eWatchdog = setTimeout(() => {
  console.error(`❌ Eluvix x Paperclip E2E timed out after ${E2E_TIMEOUT_MS}ms`);
  process.exit(1);
}, E2E_TIMEOUT_MS);

const {
  Eluvix,
  createNamedApiKey,
  resolveBearerToken,
  parseVerifiedPaperclipRequestAsync,
  signPaperclipContextHeaders,
  classifyPaperclipTask,
  evaluatePaperclipCandidateAssignments,
  resolveAndRecordPaperclipFeedback,
  getPaperclipUsageByCorrelation,
  getPaperclipOutcomePriors,
  DEFAULT_PAPERCLIP_INTEGRATION_CONFIG,
  isLocalUpstream,
  globalCircuitBreaker,
  getEffectiveCostPer1kTokens,
  logRequest,
} = await import('../packages/router-core/dist/index.js');

const { createEluvixPluginHandlers } = await import(
  '../packages/paperclip-plugin/dist/index.js'
);
const {
  executeEluvixLocal,
  signOutboundPaperclipHeaders,
} = await import('../packages/paperclip-adapter/dist/server/index.js');

function listenServer(server) {
  return new Promise((resolve, reject) => {
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      resolve(`http://127.0.0.1:${addr.port}`);
    });
  });
}

function closeServer(server) {
  return new Promise((resolve) => server.close(() => resolve()));
}

let upstreamServer;
let gatewayServer;

try {
  // 1. Mock local upstream LLM engine (serves chat completions)
  upstreamServer = http.createServer(async (req, res) => {
    if (req.url === '/v1/chat/completions' && req.method === 'POST') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          id: 'cmpl-e2e-1',
          model: 'qwen2.5-coder:7b',
          choices: [{ message: { role: 'assistant', content: 'E2E routed ok' }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 24, completion_tokens: 12 },
        })
      );
      return;
    }
    res.writeHead(404);
    res.end();
  });
  const upstreamUrl = await listenServer(upstreamServer);

  // 2. Initialize isolated Switchyard config + env: SecretRef HMAC + scoped Paperclip key
  const hmacSecret = 'e2e-paperclip-hmac-secret-32chars';
  process.env.ELUVIX_E2E_PAPERCLIP_HMAC = hmacSecret;
  const paperclipCfg = {
    ...DEFAULT_PAPERCLIP_INTEGRATION_CONFIG,
    enabled: true,
    hmacSecret: 'env:ELUVIX_E2E_PAPERCLIP_HMAC',
    requireSignedContext: true,
  };
  const router = new Eluvix({
    strategy: 'lowest-latency',
    upstreams: [
      {
        id: 'e2e-local',
        name: 'E2E Local',
        type: 'ollama',
        endpoint: `${upstreamUrl}/v1`,
        models: ['qwen2.5-coder:7b'],
        costPer1kTokens: 0,
        tier: 'code',
        priority: 1,
      },
      {
        id: 'e2e-cloud',
        name: 'E2E Cloud',
        type: 'openai-compatible',
        endpoint: 'https://api.openai.com/v1',
        apiKey: 'sk-e2e-cloud',
        models: ['gpt-4o'],
        costPer1kTokens: 0.02,
        tier: 'reasoning',
        priority: 2,
      },
    ],
    integrations: { paperclip: paperclipCfg },
  });

  const createdKey = await createNamedApiKey({
    name: 'e2e-comp-a',
    userId: 'e2e-user',
    scopes: ['chat', 'paperclip'],
    paperclip: {
      companyIds: ['comp-a'],
      maxTier: 'code-specialist',
      maxCostPer1kUsd: 0.005,
    },
  });
  const apiKey = createdKey.key;
  const resolvedCaller = await resolveBearerToken(apiKey);
  assert.ok(resolvedCaller?.paperclip?.companyIds?.includes('comp-a'));

  // 3. Spin up loopback Gateway exposing `/api/health`, `/v1/chat/completions`, and `/api/v1/paperclip/*`
  gatewayServer = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const bodyText = Buffer.concat(chunks).toString('utf8');
    const urlPath = (req.url || '/').split('?')[0];

    if (urlPath === '/api/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'ok' }));
      return;
    }

    if (urlPath === '/api/v1/paperclip/recommend-assignee' && req.method === 'POST') {
      const body = JSON.parse(bodyText || '{}');
      const fleet = router.getUpstreams().map((u) => ({
        id: u.id,
        name: u.name,
        type: u.type,
        isLocal: isLocalUpstream(u),
        healthy: globalCircuitBreaker.getState(u.id) !== 'open',
        models: u.models || [],
        costPer1kTokens: getEffectiveCostPer1kTokens(u),
        estimatedLatencyMs: 120,
      }));
      const result = await evaluatePaperclipCandidateAssignments({
        router,
        task: body.task,
        candidates: body.candidates,
        fleet,
        userId: resolvedCaller.userId,
        companyIds: resolvedCaller.paperclip.companyIds,
        topN: body.topN || 5,
      });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(result));
      return;
    }

    if (urlPath === '/api/v1/paperclip/classify' && req.method === 'POST') {
      const body = JSON.parse(bodyText || '{}');
      // Real classification via router-core, not a hardcoded stub: the
      // response must reflect the task that was actually posted.
      const classification = classifyPaperclipTask({
        title: typeof body.title === 'string' ? body.title : '',
        description: typeof body.description === 'string' ? body.description : undefined,
        priority: body.priority,
        labels: Array.isArray(body.labels) ? body.labels.map(String) : undefined,
        sensitivity: body.sensitivity,
      });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(classification));
      return;
    }

    if (urlPath === '/api/v1/paperclip/feedback' && req.method === 'POST') {
      const body = JSON.parse(bodyText || '{}');
      const fb = resolveAndRecordPaperclipFeedback({
        ...body,
        userId: resolvedCaller.userId,
        allowedCompanyIds: resolvedCaller.paperclip.companyIds,
      });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(fb));
      return;
    }

    if (urlPath.startsWith('/api/v1/paperclip/usage/') && req.method === 'GET') {
      const runId = decodeURIComponent(urlPath.split('/').pop() || '');
      const summary = getPaperclipUsageByCorrelation(
        runId,
        resolvedCaller.userId,
        resolvedCaller.paperclip.companyIds
      );
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(summary));
      return;
    }

    if (urlPath === '/v1/chat/completions' && req.method === 'POST') {
      const parsedBody = JSON.parse(bodyText || '{}');
      const pcCtx = await parseVerifiedPaperclipRequestAsync(req.headers, {
        config: paperclipCfg,
        keyPolicy: resolvedCaller.paperclip,
        hasPaperclipScope: true,
      });
      assert.equal(pcCtx.signatureStatus, 'valid');
      const routeRes = await router.routeChatCompletion(parsedBody, {
        scope: { userId: resolvedCaller.userId },
        paperclip: pcCtx,
      });
      const txt = await routeRes.text();
      res.writeHead(routeRes.status, {
        'Content-Type': routeRes.headers.get('content-type') || 'application/json',
        'x-eluvix-upstream': routeRes.headers.get('x-eluvix-upstream') || '',
      });
      res.end(txt);
      return;
    }

    res.writeHead(404);
    res.end();
  });
  const gatewayUrl = await listenServer(gatewayServer);

  // 4. Verify adapter outbound HMAC signing + env: SecretRef verification stays inside scoped key ceiling
  const signedHeaders = signOutboundPaperclipHeaders(
    {
      'x-paperclip-company-id': 'comp-a',
      'x-paperclip-agent-id': 'ag-eng',
      'x-paperclip-run-id': 'run-e2e-chat',
      'x-paperclip-issue-id': 'iss-e2e-1',
      'x-paperclip-issue-priority': 'critical',
    },
    hmacSecret
  );
  assert.ok(signPaperclipContextHeaders);
  const chatRes = await fetch(`${gatewayUrl}/v1/chat/completions`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
      ...signedHeaders,
    },
    body: JSON.stringify({
      model: 'eluvix/frontier-verified',
      messages: [{ role: 'user', content: 'Refactor switchyard test' }],
    }),
  });
  assert.equal(chatRes.status, 200);
  assert.equal(chatRes.headers.get('x-eluvix-upstream'), 'e2e-local');

  // Candidate agents shared by the route checks below and the plugin
  // flow in step 5.
  const agents = [
    {
      id: 'ag-eng',
      companyId: 'comp-a',
      name: 'TypeScript Engineer',
      role: 'engineer',
      capabilities: 'typescript vitest switchyard tests',
      status: 'idle',
      adapterConfig: { model: 'eluvix/auto' },
    },
    {
      id: 'ag-writer',
      companyId: 'comp-a',
      name: 'Docs Writer',
      role: 'writer',
      capabilities: 'markdown documentation release notes',
      status: 'idle',
    },
  ];

  // 4b. Exercise the paperclip HTTP routes the mock gateway defines.
  // Previously only /v1/chat/completions was ever fetched, so the
  // recommend-assignee / classify / feedback / usage handlers were dead
  // code and the classify handler returned a hardcoded stub.
  const e2eTask = {
    title: 'Write TypeScript unit tests for Switchyard',
    description: 'Ensure full Vitest coverage',
    priority: 'high',
  };

  // recommend-assignee: semantic/burn-rate/hierarchy-aware ranking (E1/E3/E5)
  const recRes = await fetch(`${gatewayUrl}/api/v1/paperclip/recommend-assignee`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ task: e2eTask, candidates: agents, topN: 5 }),
  });
  assert.equal(recRes.status, 200);
  const recBody = await recRes.json();
  assert.equal(recBody.classification.suggestedTier, 'code-specialist');
  assert.equal(recBody.classification.complexityLabel, 'moderate');
  assert.ok(Array.isArray(recBody.recommendations) && recBody.recommendations.length === 2);
  assert.equal(recBody.recommendations[0].agentId, 'ag-eng');

  // classify: real classifyPaperclipTask call — the response must reflect
  // the posted task, not a canned tier/label pair.
  const clsRes = await fetch(`${gatewayUrl}/api/v1/paperclip/classify`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(e2eTask),
  });
  assert.equal(clsRes.status, 200);
  const clsBody = await clsRes.json();
  assert.equal(clsBody.suggestedTier, 'code-specialist');
  assert.equal(clsBody.complexityLabel, 'moderate');
  assert.ok(Array.isArray(clsBody.modalities) && clsBody.modalities.includes('code'));

  // feedback: record an outcome via the route. Uses a separate issue
  // (iss-e2e-route) so the plugin flow in step 5 (iss-e2e-1) stays
  // independent — feedback dedupes per (userId, issueId, agentId).
  const fbRes = await fetch(`${gatewayUrl}/api/v1/paperclip/feedback`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      issueId: 'iss-e2e-route',
      agentId: 'ag-eng',
      companyId: 'comp-a',
      task: e2eTask,
      success: true,
    }),
  });
  assert.equal(fbRes.status, 200);
  const fbBody = await fbRes.json();
  assert.equal(fbBody.ok, true);
  assert.ok(typeof fbBody.taskClass === 'string' && fbBody.taskClass.includes('moderate'));

  // 5. Verify Plugin auto-with-approval -> approve -> feedback -> re-rank
  const stateMap = new Map();
  const issues = new Map([
    [
      'iss-e2e-1',
      {
        id: 'iss-e2e-1',
        companyId: 'comp-a',
        identifier: 'E2E-1',
        title: 'Write TypeScript unit tests for Switchyard',
        description: 'Ensure full Vitest coverage',
        status: 'todo',
        priority: 'high',
      },
    ],
  ]);
  const pluginHandlers = createEluvixPluginHandlers({
    config: {
      eluvixBaseUrl: gatewayUrl,
      autoAssign: {
        mode: 'auto-with-approval',
        companies: ['comp-a'],
        statuses: ['backlog', 'todo'],
        minConfidence: 0.5,
        maxPerHour: 10,
        maxTreeDepth: 4,
        requireUnassigned: true,
        excludeLabels: [],
      },
    },
    issues: {
      get: async (id) => issues.get(id) ?? null,
      list: async () => Array.from(issues.values()),
      update: async (id, _c, patch) => {
        const next = { ...issues.get(id), ...patch };
        issues.set(id, next);
        return next;
      },
      addComment: async () => undefined,
    },
    agents: { list: async () => agents },
    state: {
      get: async (k) => stateMap.get(k) ?? null,
      set: async (k, v) => void stateMap.set(k, v),
    },
    secrets: { resolve: async () => apiKey },
  });

  const createdDecision = await pluginHandlers.onEvent({
    type: 'issue.created',
    payload: { issue: issues.get('iss-e2e-1') },
  });
  assert.equal(createdDecision.action, 'pending_approval');
  assert.equal(issues.get('iss-e2e-1').assigneeAgentId, undefined);

  const approved = await pluginHandlers.actions['eluvix:approve_assignment']({
    companyId: 'comp-a',
    issueId: 'iss-e2e-1',
  });
  assert.equal(approved.ok, true);
  assert.equal(issues.get('iss-e2e-1').assigneeAgentId, 'ag-eng');

  // Record completion feedback & verify posterior updates cleanly
  await pluginHandlers.onEvent({
    type: 'issue.updated',
    payload: { issue: { ...issues.get('iss-e2e-1'), status: 'done' } },
  });
  await new Promise((r) => setTimeout(r, 25));
  const priors = getPaperclipOutcomePriors(undefined, resolvedCaller.userId, ['comp-a']);
  assert.ok((priors['ag-eng']?.wins ?? 0) >= 1);

  // 6. Verify Adapter mid-run escalation + usage correlation
  logRequest({
    timestamp: new Date().toISOString(),
    model: 'qwen2.5-coder:7b',
    upstream_id: 'e2e-local',
    status: 200,
    duration_ms: 95,
    prompt_tokens: 24,
    completion_tokens: 12,
    cost_usd: 0,
    user_id: resolvedCaller.userId,
    correlation_id: 'run-e2e-adapter',
    pc_company_id: 'comp-a',
    pc_agent_id: 'ag-eng',
  });
  let adapterAttempt = 0;
  const mockOpenCodeFetch = async (url, init) => {
    if (String(url).startsWith('http://127.0.0.1:49995/session')) {
      if (String(url).endsWith('/message')) {
        adapterAttempt += 1;
        if (adapterAttempt === 1) return new Response('Busy', { status: 503 });
        return new Response(
          JSON.stringify({ parts: [{ type: 'text', text: 'E2E OpenCode completed.' }] }),
          { status: 200 }
        );
      }
      return new Response(JSON.stringify({ id: `ses-e2e-${adapterAttempt}` }), { status: 200 });
    }
    return fetch(url, init);
  };
  const execRes = await executeEluvixLocal(
    {
      runId: 'run-e2e-adapter',
      agent: { id: 'ag-eng', companyId: 'comp-a', name: 'TypeScript Engineer', adapterType: 'eluvix_local' },
      config: { eluvixBaseUrl: gatewayUrl, eluvixApiKey: apiKey, model: 'eluvix/fast-local' },
      context: { prompt: 'Run E2E check' },
      onLog: async () => undefined,
    },
    {
      fetch: mockOpenCodeFetch,
      spawnServer: async () => ({
        baseUrl: 'http://127.0.0.1:49995',
        port: 49995,
        stop: async () => undefined,
      }),
    }
  );
  assert.equal(execRes.exitCode, 0);
  assert.equal(adapterAttempt, 2);
  assert.equal(execRes.costStatus, 'reported');
  assert.equal(execRes.usage?.inputTokens, 24);

  // usage: the adapter run above logged exactly one request under
  // correlation run-e2e-adapter — the route must attribute that request.
  const usageRes = await fetch(`${gatewayUrl}/api/v1/paperclip/usage/run-e2e-adapter`);
  assert.equal(usageRes.status, 200);
  const usageBody = await usageRes.json();
  assert.equal(usageBody.runId, 'run-e2e-adapter');
  assert.equal(usageBody.requests, 1);
  assert.equal(usageBody.inputTokens, 24);
  assert.equal(usageBody.outputTokens, 12);

  clearTimeout(e2eWatchdog);
  console.log('✅ Eluvix x Paperclip E2E passed (S1/S2/S3 + M1/M2 + E1–E6 verified, paperclip routes recommend-assignee/classify/feedback/usage exercised).');
} finally {
  delete process.env.ELUVIX_E2E_PAPERCLIP_HMAC;
  if (gatewayServer) await closeServer(gatewayServer);
  if (upstreamServer) await closeServer(upstreamServer);
  if (origXdgConfig === undefined) delete process.env.XDG_CONFIG_HOME;
  else process.env.XDG_CONFIG_HOME = origXdgConfig;
  if (origXdgData === undefined) delete process.env.XDG_DATA_HOME;
  else process.env.XDG_DATA_HOME = origXdgData;
  fs.rmSync(tmpConfigDir, { recursive: true, force: true });
  fs.rmSync(tmpDataDir, { recursive: true, force: true });
}
