import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { clearApiKeysCache, createNamedApiKey, logRequest } from '@eluvix/router-core';
import { saveConfig } from '../router';
import { compileGraph } from '../orchestration/compiler';
import { decompileConfigToGraph } from '../orchestration/decompiler';
import { analyzeGraphDiagnostics } from '../orchestration/diagnostics';
import { GET as getModels } from '../../app/api/v1/models/route';
import { GET as getWhoami } from '../../app/api/v1/paperclip/whoami/route';
import { GET as getCapabilities } from '../../app/api/v1/paperclip/capabilities/route';
import { POST as postClassify } from '../../app/api/v1/paperclip/classify/route';
import { POST as postRecommend } from '../../app/api/v1/paperclip/recommend-assignee/route';
import { POST as postFeedback } from '../../app/api/v1/paperclip/feedback/route';
import { GET as getUsage } from '../../app/api/v1/paperclip/usage/[runId]/route';

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
    const usageRes = await getUsage(usageReq, { params: { runId: 'run-next-1' } });
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
  });
});
