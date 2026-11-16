import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import {
  clearApiKeysCache,
  createNamedApiKey,
  logRequest,
  signPaperclipContextHeaders,
} from '@eluvix/router-core';
import { diffRouterConfigs } from '../config-diff';
import { saveConfig } from '../router';
import { compileGraph } from '../orchestration/compiler';
import { decompileConfigToGraph } from '../orchestration/decompiler';
import { analyzeGraphDiagnostics } from '../orchestration/diagnostics';
import {
  DELETE as deleteObservability,
  GET as getObservability,
} from '../../app/api/v1/observability/route';
import {
  DELETE as deleteKeys,
  GET as getKeys,
  POST as postKeys,
} from '../../app/api/v1/keys/route';
import { POST as postMessages } from '../../app/api/v1/messages/route';
import { POST as postResponses } from '../../app/api/v1/responses/route';
import { GET as getModels } from '../../app/api/v1/models/route';
import { GET as getWhoami } from '../../app/api/v1/paperclip/whoami/route';
import { GET as getCapabilities } from '../../app/api/v1/paperclip/capabilities/route';
import {
  GET as getPaperclipHealth,
  POST as postPaperclipHealth,
} from '../../app/api/v1/paperclip/health/route';
import { POST as postClassify } from '../../app/api/v1/paperclip/classify/route';
import { POST as postRecommend } from '../../app/api/v1/paperclip/recommend-assignee/route';
import { POST as postFeedback } from '../../app/api/v1/paperclip/feedback/route';
import { GET as getUsage } from '../../app/api/v1/paperclip/usage/[runId]/route';
import { POST as postRouteExplain } from '../../app/api/v1/route-explain/route';

describe('Paperclip Next.js Routes & Editor Bridge', () => {
  let tmpConfigDir: string;
  let tmpDataDir: string;
  let origXdgConfig: string | undefined;
  let origXdgData: string | undefined;
  let paperclipToken: string;

  beforeEach(() => {
    origXdgConfig = process.env.XDG_CONFIG_HOME;
    origXdgData = process.env.XDG_DATA_HOME;
    tmpConfigDir = fs.mkdtempSync(path.join(os.tmpdir(), 'eluvix-next-pc-cfg-'));
    tmpDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'eluvix-next-pc-data-'));
    process.env.XDG_CONFIG_HOME = tmpConfigDir;
    process.env.XDG_DATA_HOME = tmpDataDir;

    saveConfig({
      strategy: 'lowest-latency',
      upstreams: [
        {
          id: 'local-ollama',
          name: 'Local Ollama',
          type: 'ollama',
          endpoint: 'http://127.0.0.1:11434/v1',
          models: ['llama3.2:latest'],
          costPer1kTokens: 0,
          priority: 1,
        },
      ],
      integrations: {
        paperclip: {
          enabled: true,
          paperclipBaseUrl: 'http://127.0.0.1:3100',
        },
      },
    });

    clearApiKeysCache();
    const created = createNamedApiKey({
      name: 'Paperclip Test Key',
      userId: 'pc-user',
      scopes: ['paperclip'],
    });
    paperclipToken = created.key!;
  });

  afterEach(() => {
    clearApiKeysCache();
    vi.restoreAllMocks();
    if (origXdgConfig === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = origXdgConfig;
    if (origXdgData === undefined) delete process.env.XDG_DATA_HOME;
    else process.env.XDG_DATA_HOME = origXdgData;
    fs.rmSync(tmpConfigDir, { recursive: true, force: true });
    fs.rmSync(tmpDataDir, { recursive: true, force: true });
  });

  it('includes Paperclip virtual models in /api/v1/models', async () => {
    const req = new NextRequest('http://127.0.0.1:3588/api/v1/models', {
      headers: { Authorization: `Bearer ${paperclipToken}` },
    });
    const res = await getModels(req);
    expect(res.status).toBe(200);
    const json = await res.json();
    const ids = json.data.map((m: any) => m.id);
    expect(ids).toContain('eluvix/auto');
    expect(ids).toContain('eluvix/code-specialist');
  });

  it('rejects missing/wrong-scope tokens and serves /api/v1/paperclip/whoami + capabilities', async () => {
    const unauthReq = new NextRequest('http://127.0.0.1:3588/api/v1/paperclip/whoami');
    expect((await getWhoami(unauthReq)).status).toBe(401);

    const authReq = new NextRequest('http://127.0.0.1:3588/api/v1/paperclip/whoami', {
      headers: { Authorization: `Bearer ${paperclipToken}` },
    });
    const whoamiRes = await getWhoami(authReq);
    expect(whoamiRes.status).toBe(200);
    const whoami = await whoamiRes.json();
    expect(whoami.ok).toBe(true);
    expect(whoami.userId).toBe('pc-user');
    expect(whoami.paperclipIntegrationEnabled).toBe(true);

    const capReq = new NextRequest('http://127.0.0.1:3588/api/v1/paperclip/capabilities', {
      headers: { Authorization: `Bearer ${paperclipToken}` },
    });
    const capRes = await getCapabilities(capReq);
    expect(capRes.status).toBe(200);
    const cap = await capRes.json();
    expect(cap.upstreams.some((u: any) => u.id === 'local-ollama')).toBe(true);
  });

  it('serves classify, recommend-assignee, feedback, and scoped usage/[runId]', async () => {
    const clsReq = new NextRequest('http://127.0.0.1:3588/api/v1/paperclip/classify', {
      method: 'POST',
      headers: { Authorization: `Bearer ${paperclipToken}`, 'content-type': 'application/json' },
      body: JSON.stringify({ title: 'Audit SSN table', description: 'Check 123-45-6789' }),
    });
    const clsRes = await postClassify(clsReq);
    expect(clsRes.status).toBe(200);
    const cls = await clsRes.json();
    expect(cls.piiDetected).toBe(true);

    const recReq = new NextRequest('http://127.0.0.1:3588/api/v1/paperclip/recommend-assignee', {
      method: 'POST',
      headers: { Authorization: `Bearer ${paperclipToken}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        task: { title: 'Write TypeScript tests' },
        candidates: [{ id: 'a1', name: 'TS Agent', capabilities: 'typescript, tests' }],
      }),
    });
    const recRes = await postRecommend(recReq);
    expect(recRes.status).toBe(200);
    const rec = await recRes.json();
    expect(rec.recommendations[0].agentId).toBe('a1');

    const fbReq = new NextRequest('http://127.0.0.1:3588/api/v1/paperclip/feedback', {
      method: 'POST',
      headers: { Authorization: `Bearer ${paperclipToken}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        issueId: 'iss-1',
        agentId: 'a1',
        taskClass: 'code',
        success: true,
        costUsd: 0.002,
      }),
    });
    const fbRes = await postFeedback(fbReq);
    expect(fbRes.status).toBe(200);

    logRequest({
      timestamp: new Date().toISOString(),
      model: 'llama3.2:latest',
      upstream_id: 'local-ollama',
      status: 200,
      duration_ms: 85,
      prompt_tokens: 12,
      completion_tokens: 8,
      cost_usd: 0,
      user_id: 'pc-user',
      correlation_id: 'run-next-1',
    });

    const usageReq = new NextRequest('http://127.0.0.1:3588/api/v1/paperclip/usage/run-next-1', {
      headers: { Authorization: `Bearer ${paperclipToken}` },
    });
    const usageRes = await getUsage(usageReq, { params: Promise.resolve({ runId: 'run-next-1' }) });
    expect(usageRes.status).toBe(200);
    const usage = await usageRes.json();
    expect(usage.requests).toBe(1);
    expect(usage.inputTokens).toBe(12);
  });

  it('round-trips PaperclipBridgeNode through compiler, decompiler, and diagnostics', () => {
    const graph = decompileConfigToGraph({
      strategy: 'lowest-latency',
      upstreams: [
        {
          id: 'local-ollama',
          name: 'Local Ollama',
          type: 'ollama',
          endpoint: 'http://127.0.0.1:11434/v1',
          models: ['llama3.2:latest'],
          costPer1kTokens: 0,
          priority: 1,
        },
      ],
      integrations: {
        paperclip: {
          enabled: true,
          paperclipBaseUrl: 'http://127.0.0.1:3100',
          budgetPressure: { thresholdPct: 15, action: 'cascade-cheaper' },
          sensitivityFloor: { confidential: 'local-only', internal: 'local-preferred' },
          trustHeadersFrom: 'scoped-key',
        },
      },
    });

    const bridgeNode = graph.nodes.find((n) => n.type === 'paperclipBridgeNode');
    expect(bridgeNode).toBeDefined();

    const compiled = compileGraph(graph.nodes, graph.edges);
    const parsedCfg = JSON.parse(compiled.eluvixJson);
    expect(parsedCfg.integrations?.paperclip?.enabled).toBe(true);
    expect(parsedCfg.integrations?.paperclip?.paperclipBaseUrl).toBe('http://127.0.0.1:3100');

    const diags = analyzeGraphDiagnostics(graph.nodes, graph.edges);
    const errors = diags.diagnostics.filter((d) => d.severity === 'error');
    expect(errors.length).toBe(0);

    // Config diff tracks integrations.paperclip & compiler preserves HMAC settings conditionally
    const baseCompiled = JSON.parse(compiled.eluvixJson);
    const identicalDiff = diffRouterConfigs(baseCompiled, baseCompiled);
    expect(identicalDiff.paperclipChanged).toBeUndefined();
    expect(identicalDiff.isEmpty).toBe(true);

    const updatedNodes = graph.nodes.map((n) =>
      n.type === 'paperclipBridgeNode'
        ? {
            ...n,
            data: {
              ...(n.data as Record<string, any>),
              hmacSecret: 'rot-secret-123',
              requireSignedContext: true,
            },
          }
        : n
    );
    const recompiled = JSON.parse(compileGraph(updatedNodes, graph.edges).eluvixJson);
    expect(recompiled.integrations?.paperclip?.hmacSecret).toBe('rot-secret-123');
    expect(recompiled.integrations?.paperclip?.requireSignedContext).toBe(true);
    const modifiedDiff = diffRouterConfigs(baseCompiled, recompiled);
    expect(modifiedDiff.paperclipChanged).toBe(true);
    expect(modifiedDiff.isEmpty).toBe(false);
  });

  it('S1/S2/M5/E6: enforces Paperclip company scoping, HMAC route-explain verification, SSRF health guard, and observability summary', async () => {
    const scoped = await createNamedApiKey({
      name: 'comp-a-only',
      userId: 'pc-user',
      scopes: ['paperclip', 'chat'],
      paperclip: {
        companyIds: ['comp-a'],
        maxTier: 'code-specialist',
        maxCostPer1kUsd: 0.002,
      },
    });
    const scopedToken = scoped.key!;

    // 1. S2 company_scope_forbidden 403 across recommend-assignee & feedback
    const forbiddenRec = await postRecommend(
      new NextRequest('http://127.0.0.1:3588/api/v1/paperclip/recommend-assignee', {
        method: 'POST',
        headers: { Authorization: `Bearer ${scopedToken}`, 'content-type': 'application/json' },
        body: JSON.stringify({
          companyId: 'comp-b',
          task: { title: 'Cross company task' },
          candidates: [{ id: 'a1', name: 'Agent 1' }],
        }),
      })
    );
    expect(forbiddenRec.status).toBe(403);
    const forbiddenJson = await forbiddenRec.json();
    expect(forbiddenJson.error.code).toBe('company_scope_forbidden');

    const forbiddenFb = await postFeedback(
      new NextRequest('http://127.0.0.1:3588/api/v1/paperclip/feedback', {
        method: 'POST',
        headers: { Authorization: `Bearer ${scopedToken}`, 'content-type': 'application/json' },
        body: JSON.stringify({ companyId: 'comp-b', issueId: 'iss-1', agentId: 'a1' }),
      })
    );
    expect(forbiddenFb.status).toBe(403);

    // 2. S1 + S2 route-explain honors HMAC signature + enforces key ceiling
    saveConfig({
      strategy: 'lowest-latency',
      upstreams: [
        {
          id: 'local-ollama',
          name: 'Local Ollama',
          type: 'ollama',
          endpoint: 'http://127.0.0.1:11434/v1',
          models: ['llama3.2:latest'],
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
          models: ['gpt-4o'],
          costPer1kTokens: 0.01,
          tier: 'reasoning',
          priority: 2,
        },
      ],
      integrations: {
        paperclip: {
          enabled: true,
          paperclipBaseUrl: 'http://127.0.0.1:3100',
          trustHeadersFrom: 'scoped-key',
          hmacSecret: 'route-explain-secret',
          requireSignedContext: true,
        },
      },
    });
    const signedHdrs = signPaperclipContextHeaders(
      {
        'x-paperclip-company-id': 'comp-a',
        'x-paperclip-issue-priority': 'critical',
      },
      'route-explain-secret'
    );
    const explainRes = await postRouteExplain(
      new NextRequest('http://127.0.0.1:3588/api/v1/route-explain', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${scopedToken}`,
          'content-type': 'application/json',
          ...signedHdrs,
        },
        body: JSON.stringify({
          model: 'eluvix/frontier-verified',
          messages: [{ role: 'user', content: 'Analyze outage' }],
        }),
      })
    );
    expect(explainRes.status).toBe(200);
    const explainJson = await explainRes.json();
    expect(explainJson.chosenUpstreamId).toBe('local-ollama');

    // 3. M5 Paperclip health probe: unauth 401, SSRF cloud IMDS 403, valid loopback 200
    const healthUnauth = await getPaperclipHealth(
      new NextRequest('http://127.0.0.1:3588/api/v1/paperclip/health')
    );
    expect(healthUnauth.status).toBe(401);

    const healthSsrf = await postPaperclipHealth(
      new NextRequest('http://127.0.0.1:3588/api/v1/paperclip/health', {
        method: 'POST',
        headers: { Authorization: `Bearer ${scopedToken}`, 'content-type': 'application/json' },
        body: JSON.stringify({ paperclipBaseUrl: 'http://169.254.169.254/latest/meta-data' }),
      })
    );
    expect(healthSsrf.status).toBe(403);

    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(JSON.stringify({ status: 'ok', version: '0.3.1' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    );
    const healthOk = await postPaperclipHealth(
      new NextRequest('http://127.0.0.1:3588/api/v1/paperclip/health', {
        method: 'POST',
        headers: { Authorization: `Bearer ${scopedToken}`, 'content-type': 'application/json' },
        body: JSON.stringify({ paperclipBaseUrl: 'http://127.0.0.1:3100' }),
      })
    );
    expect(healthOk.status).toBe(200);
    const healthJson = await healthOk.json();
    expect(healthJson.ok).toBe(true);

    // 4. E6 Observability summary includes Paperclip runs
    logRequest({
      timestamp: new Date().toISOString(),
      model: 'llama3.2:latest',
      upstream_id: 'local-ollama',
      status: 200,
      duration_ms: 45,
      prompt_tokens: 10,
      completion_tokens: 10,
      cost_usd: 0,
      user_id: 'pc-user',
      correlation_id: 'run-obs-1',
      pc_issue_id: 'iss-obs-1',
      pc_agent_id: 'ag-obs-1',
      pc_company_id: 'comp-a',
      pc_priority: 'high',
    });
    const obsRes = await getObservability(
      new NextRequest('http://127.0.0.1:3588/api/v1/observability', {
        headers: { Authorization: `Bearer ${scopedToken}` },
      })
    );
    expect(obsRes.status).toBe(200);
    const obsJson = await obsRes.json();
    expect(obsJson.data.paperclip.totalRequests).toBeGreaterThanOrEqual(1);
    expect(obsJson.data.paperclip.recentRuns.some((r: any) => r.runId === 'run-obs-1')).toBe(true);
    expect(Array.isArray(obsJson.data.dailyRollups)).toBe(true);
    expect(obsJson.data.dailyRollups.length).toBeGreaterThanOrEqual(1);

    const nonAdminPruneRes = await deleteObservability(
      new NextRequest('http://127.0.0.1:3588/api/v1/observability?olderThanDays=30', {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${scopedToken}` },
      })
    );
    expect(nonAdminPruneRes.status).toBe(403);

    const obsAdminKey = createNamedApiKey({
      name: 'Obs Admin',
      userId: 'pc-user',
      role: 'admin',
      scopes: ['*'],
    }).key;
    const pruneRes = await deleteObservability(
      new NextRequest('http://127.0.0.1:3588/api/v1/observability?olderThanDays=30', {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${obsAdminKey}` },
      })
    );
    expect(pruneRes.status).toBe(200);
    const pruneJson = await pruneRes.json();
    expect(pruneJson.success).toBe(true);
    expect(pruneJson.olderThanDays).toBe(30);
  });

  it('manages scoped API keys via /api/v1/keys with admin RBAC & masks hmacSecret across /keys and /capabilities', async () => {
    saveConfig({
      strategy: 'lowest-latency',
      upstreams: [
        {
          id: 'local-ollama',
          name: 'Local Ollama',
          type: 'ollama',
          endpoint: 'http://127.0.0.1:11434/v1',
          models: ['llama3.2:latest'],
          costPer1kTokens: 0,
          priority: 1,
        },
      ],
      integrations: {
        paperclip: {
          enabled: true,
          paperclipBaseUrl: 'http://127.0.0.1:3100',
          hmacSecret: 'raw-top-secret-hmac-value',
          requireSignedContext: true,
        },
      },
    });

    // Capabilities must mask literal hmacSecret while advertising hmacSigningConfigured
    const capRes = await getCapabilities(
      new NextRequest('http://127.0.0.1:3588/api/v1/paperclip/capabilities', {
        headers: { Authorization: `Bearer ${paperclipToken}` },
      })
    );
    expect(capRes.status).toBe(200);
    const capJson = await capRes.json();
    expect(capJson.paperclipPolicy?.hmacSecret).toBe('raw-to...alue');
    expect(capJson.paperclipPolicy?.hmacSigningConfigured).toBe(true);

    // Non-admin bearer cannot mint/list keys (403)
    const nonAdminGet = await getKeys(
      new NextRequest('http://127.0.0.1:3588/api/v1/keys', {
        headers: { Authorization: `Bearer ${paperclipToken}` },
      })
    );
    expect(nonAdminGet.status).toBe(403);

    const adminKey = createNamedApiKey({
      name: 'Admin Manager Key',
      userId: 'admin-user',
      role: 'admin',
      scopes: ['*'],
    }).key;

    // Mint a key with literal hmacSecret & companyIds
    const postRes = await postKeys(
      new NextRequest('http://127.0.0.1:3588/api/v1/keys', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${adminKey}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          label: 'Company B Worker',
          scopes: ['chat', 'paperclip'],
          paperclip: {
            companyIds: ['comp-b'],
            maxTier: 'code-specialist',
            hmacSecret: 'literal-key-hmac-secret',
          },
        }),
      })
    );
    expect(postRes.status).toBe(201);
    const postJson = await postRes.json();
    expect(postJson.key).toMatch(/^elx_/);
    expect(postJson.paperclip?.hmacSecret).toBe('litera...cret');

    const listRes = await getKeys(
      new NextRequest('http://127.0.0.1:3588/api/v1/keys', {
        headers: { Authorization: `Bearer ${adminKey}` },
      })
    );
    expect(listRes.status).toBe(200);
    const listJson = await listRes.json();
    const listedWorker = listJson.data.find((k: any) => k.label === 'Company B Worker');
    expect(listedWorker).toBeDefined();
    expect(listedWorker.key).toMatch(/^elx_[A-Za-z]+\.\.\.$/);
    expect(listedWorker.paperclip?.hmacSecret).toBe('litera...cret');

    // Mint a SecretRef key and confirm env: pointer stays visible
    const refRes = await postKeys(
      new NextRequest('http://127.0.0.1:3588/api/v1/keys', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${adminKey}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          label: 'Company A Ref Key',
          scopes: ['chat', 'paperclip'],
          paperclip: {
            companyIds: ['comp-a'],
            hmacSecret: 'env:COMP_A_HMAC_SECRET',
          },
        }),
      })
    );
    expect(refRes.status).toBe(201);
    const refJson = await refRes.json();
    expect(refJson.paperclip?.hmacSecret).toBe('env:COMP_A_HMAC_SECRET');

    // Delete newly minted key
    const delRes = await deleteKeys(
      new NextRequest(`http://127.0.0.1:3588/api/v1/keys?id=${encodeURIComponent(listedWorker.id)}`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${adminKey}` },
      })
    );
    expect(delRes.status).toBe(200);
  });

  it('enforces Paperclip companyIds and attaches response headers on /api/v1/messages & /api/v1/responses', async () => {
    saveConfig({
      strategy: 'lowest-latency',
      upstreams: [
        {
          id: 'local-ollama',
          name: 'Local Ollama',
          type: 'ollama',
          endpoint: 'http://127.0.0.1:11434/v1',
          models: ['llama3.2:latest'],
          costPer1kTokens: 0,
          priority: 1,
        },
      ],
      integrations: {
        paperclip: {
          enabled: true,
          hmacSecret: 'multi-proto-hmac-secret',
          requireSignedContext: true,
        },
      },
    });

    const scopedKey = createNamedApiKey({
      name: 'CompA MultiProto Key',
      userId: 'pc-user',
      scopes: ['chat', 'paperclip'],
      paperclip: { companyIds: ['comp-a'] },
    }).key;

    // Cross-company rejection (403) on /api/v1/messages
    const badHdrs = signPaperclipContextHeaders(
      { 'x-paperclip-company-id': 'comp-b', 'x-paperclip-run-id': 'run-msg-bad' },
      'multi-proto-hmac-secret'
    );
    const msgForbidden = await postMessages(
      new NextRequest('http://127.0.0.1:3588/api/v1/messages', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${scopedKey}`,
          'content-type': 'application/json',
          ...badHdrs,
        },
        body: JSON.stringify({
          model: 'eluvix/auto',
          max_tokens: 64,
          messages: [{ role: 'user', content: 'hi' }],
        }),
      })
    );
    expect(msgForbidden.status).toBe(403);

    // Cross-company rejection (403) on /api/v1/responses
    const respForbidden = await postResponses(
      new NextRequest('http://127.0.0.1:3588/api/v1/responses', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${scopedKey}`,
          'content-type': 'application/json',
          ...badHdrs,
        },
        body: JSON.stringify({
          model: 'eluvix/auto',
          input: 'hi',
        }),
      })
    );
    expect(respForbidden.status).toBe(403);

    // Authorized company-a request on /api/v1/messages & /api/v1/responses preserves correlation headers
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () =>
      new Response(
        JSON.stringify({
          id: 'cmpl-proto',
          model: 'llama3.2:latest',
          choices: [{ message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 10, completion_tokens: 5 },
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      )
    );
    const okHdrs = signPaperclipContextHeaders(
      {
        'x-paperclip-company-id': 'comp-a',
        'x-paperclip-run-id': 'run-msg-ok',
        'x-paperclip-issue-priority': 'high',
      },
      'multi-proto-hmac-secret'
    );

    const msgOk = await postMessages(
      new NextRequest('http://127.0.0.1:3588/api/v1/messages', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${scopedKey}`,
          'content-type': 'application/json',
          ...okHdrs,
        },
        body: JSON.stringify({
          model: 'eluvix/auto',
          max_tokens: 64,
          messages: [{ role: 'user', content: 'hi' }],
        }),
      })
    );
    expect(msgOk.status).toBe(200);
    expect(msgOk.headers.get('x-eluvix-correlation-id')).toBe('run-msg-ok');

    const respOk = await postResponses(
      new NextRequest('http://127.0.0.1:3588/api/v1/responses', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${scopedKey}`,
          'content-type': 'application/json',
          ...okHdrs,
        },
        body: JSON.stringify({
          model: 'eluvix/auto',
          input: 'hi',
        }),
      })
    );
    expect(respOk.status).toBe(200);
    expect(respOk.headers.get('x-eluvix-correlation-id')).toBe('run-msg-ok');
  });
});
