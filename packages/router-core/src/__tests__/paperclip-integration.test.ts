import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Eluvix, type RouterConfig } from '../index.js';
import { getDb, logRequest } from '../db.js';
import {
  DEFAULT_PAPERCLIP_INTEGRATION_CONFIG,
  PAPERCLIP_VIRTUAL_MODELS,
  parsePaperclipHeaders,
  resolvePaperclipRoutingBias,
  resolveVirtualTierAlias,
} from '../paperclip-context.js';
import {
  classifyPaperclipTask,
  recommendPaperclipAssignees,
} from '../paperclip-assign.js';
import {
  getPaperclipOutcomePriors,
  getPaperclipUsageByCorrelation,
  recordPaperclipAssignmentOutcome,
} from '../paperclip-store.js';
import { ELUVIX_MCP_TOOLS, handleEluvixMcpMessage } from '../mcp-server.js';

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
        apiKey: 'sk-test-123',
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
      },
    },
    ...overrides,
  };
}

describe('Paperclip Integration (@eluvix/router-core)', () => {
  let tmpConfigDir: string;
  let tmpDataDir: string;
  let origXdgConfig: string | undefined;
  let origXdgData: string | undefined;

  beforeEach(() => {
    origXdgConfig = process.env.XDG_CONFIG_HOME;
    origXdgData = process.env.XDG_DATA_HOME;
    tmpConfigDir = fs.mkdtempSync(path.join(os.tmpdir(), 'eluvix-pc-cfg-'));
    tmpDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'eluvix-pc-data-'));
    process.env.XDG_CONFIG_HOME = tmpConfigDir;
    process.env.XDG_DATA_HOME = tmpDataDir;
  });

  afterEach(() => {
    vi.restoreAllMocks();
    if (origXdgConfig === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = origXdgConfig;
    if (origXdgData === undefined) delete process.env.XDG_DATA_HOME;
    else process.env.XDG_DATA_HOME = origXdgData;
    fs.rmSync(tmpConfigDir, { recursive: true, force: true });
    fs.rmSync(tmpDataDir, { recursive: true, force: true });
  });

  describe('paperclip-context', () => {
    it('parses x-paperclip-* headers cleanly when trusted and drops privileged headers when untrusted', () => {
      const trustedCtx = parsePaperclipHeaders(
        {
          'x-paperclip-run-id': 'run-123',
          'x-paperclip-issue-id': 'iss-456',
          'x-paperclip-agent-id': 'agt-789',
          'x-paperclip-company-id': 'cmp-001',
          'x-paperclip-issue-priority': 'critical',
          'x-paperclip-budget-remaining-pct': '8',
          'x-paperclip-sensitivity': 'confidential',
        },
        { trusted: true }
      );
      expect(trustedCtx.runId).toBe('run-123');
      expect(trustedCtx.priority).toBe('critical');
      expect(trustedCtx.budgetRemainingPct).toBe(8);
      expect(trustedCtx.sensitivity).toBe('confidential');
      expect(trustedCtx.trusted).toBe(true);

      const untrustedCtx = parsePaperclipHeaders(
        {
          'x-paperclip-run-id': 'run-123',
          'x-paperclip-issue-priority': 'critical',
          'x-paperclip-sensitivity': 'confidential',
        },
        { trusted: false }
      );
      expect(untrustedCtx.trusted).toBe(false);
      const untrustedBias = resolvePaperclipRoutingBias(untrustedCtx, {
        ...DEFAULT_PAPERCLIP_INTEGRATION_CONFIG,
        enabled: true,
      });
      expect(untrustedBias.active).toBe(false);
      expect(untrustedBias.allowCloud).toBe(true);
    });

    it('resolves priority, budget pressure, and sensitivity biases', () => {
      const cfg = { ...DEFAULT_PAPERCLIP_INTEGRATION_CONFIG, enabled: true };
      const criticalBias = resolvePaperclipRoutingBias(
        {
          trusted: true,
          priority: 'critical',
          budgetRemainingPct: 80,
          droppedHeaders: [],
        },
        cfg
      );
      expect(criticalBias.active).toBe(true);
      expect(criticalBias.minTier).toBe('heavy-reasoning');
      expect(criticalBias.allowCloud).toBe(true);

      const pressureBias = resolvePaperclipRoutingBias(
        {
          trusted: true,
          priority: 'critical',
          budgetRemainingPct: 5,
          droppedHeaders: [],
        },
        cfg
      );
      expect(pressureBias.budgetPressureTriggered).toBe(true);

      const confidentialBias = resolvePaperclipRoutingBias(
        {
          trusted: true,
          sensitivity: 'confidential',
          droppedHeaders: [],
        },
        cfg
      );
      expect(confidentialBias.sensitivityForcedLocal).toBe(true);
      expect(confidentialBias.allowCloud).toBe(false);
    });

    it('maps Paperclip virtual models to tiers', () => {
      expect(PAPERCLIP_VIRTUAL_MODELS.length).toBeGreaterThanOrEqual(5);
      expect(resolveVirtualTierAlias('eluvix/auto')).toBeUndefined();
      expect(resolveVirtualTierAlias('eluvix/fast-local')).toBe('fast-local');
      expect(resolveVirtualTierAlias('eluvix/code-specialist')).toBe('code-specialist');
      expect(resolveVirtualTierAlias('eluvix/heavy-reasoning')).toBe('heavy-reasoning');
      expect(resolveVirtualTierAlias('eluvix/frontier-verified')).toBe('frontier-verified');
      expect(resolveVirtualTierAlias('gpt-4o')).toBeUndefined();
    });
  });

  describe('Router priority & sensitivity routing + correlation logging', () => {
    it('routes eluvix/auto, emits Paperclip response headers, and logs correlation_id', async () => {
      const fetchMock = vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            id: 'chatcmpl-1',
            object: 'chat.completion',
            model: 'llama3.2:latest',
            choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
            usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
          }),
          { status: 200, headers: { 'content-type': 'application/json' } }
        )
      );

      const router = new Eluvix(makeTestConfig(), { fetch: fetchMock as unknown as typeof fetch });
      const res = await router.routeChatCompletion(
        {
          model: 'eluvix/auto',
          messages: [{ role: 'user', content: 'Say hello' }],
        },
        {
          paperclip: {
            trusted: true,
            runId: 'run-abc',
            issueId: 'iss-1',
            agentId: 'agt-1',
            companyId: 'cmp-1',
            priority: 'high',
            sensitivity: 'internal',
            droppedHeaders: [],
          },
        }
      );

      expect(res.status).toBe(200);
      expect(res.headers.get('x-eluvix-correlation-id')).toBe('run-abc');
      expect(res.headers.get('x-eluvix-paperclip-priority')).toBe('high');
      expect(res.headers.get('x-eluvix-paperclip-bias')).toBeTruthy();

      const usage = getPaperclipUsageByCorrelation('run-abc');
      expect(usage.requests).toBe(1);
      expect(usage.inputTokens).toBe(10);
      expect(usage.outputTokens).toBe(5);
    });

    it('restricts cloud upstreams when sensitivity is confidential and records paperclip-context in explainRoute', () => {
      const router = new Eluvix(makeTestConfig());
      const explained = router.explainRoute(
        {
          model: 'eluvix/heavy-reasoning',
          messages: [{ role: 'user', content: 'Analyze confidential data' }],
        },
        {
          paperclip: {
            trusted: true,
            runId: 'run-sec',
            priority: 'medium',
            sensitivity: 'confidential',
            droppedHeaders: [],
          },
        }
      );

      expect(explained.steps.some((t) => t.stage === 'paperclip-context')).toBe(true);
      expect(explained.chosenUpstreamId).toBe('local-ollama');
      expect(explained.rankedUpstreams.every((c) => c.id === 'local-ollama')).toBe(true);
    });

    it('triggers budget pressure cascade when budgetRemainingPct <= thresholdPct', () => {
      const router = new Eluvix(makeTestConfig());
      const explained = router.explainRoute(
        {
          model: 'eluvix/auto',
          messages: [{ role: 'user', content: 'Quick check' }],
        },
        {
          paperclip: {
            trusted: true,
            runId: 'run-bp',
            priority: 'critical',
            budgetRemainingPct: 5,
            droppedHeaders: [],
          },
        }
      );

      expect(
        explained.steps.some((t) => t.stage === 'paperclip-context' && t.detail.toLowerCase().includes('budget'))
      ).toBe(true);
    });
  });

  describe('paperclip-store (SQLite persistence & isolation)', () => {
    it('isolates usage queries by userId and persists outcome priors idempotently', () => {
      getDb(); // initializes schema and runs idempotent migrations
      getDb(); // second call verifies idempotent PRAGMA table_info migrations

      logRequest({
        timestamp: new Date().toISOString(),
        model: 'gpt-4o',
        upstream_id: 'cloud-openai',
        duration_ms: 120,
        status: 200,
        prompt_tokens: 100,
        completion_tokens: 50,
        cost_usd: 0.005,
        user_id: 'user-a',
        correlation_id: 'run-iso',
        pc_issue_id: 'iss-iso',
        pc_agent_id: 'agt-iso',
        pc_company_id: 'cmp-1',
        pc_priority: 'high',
      });

      const userASummary = getPaperclipUsageByCorrelation('run-iso', 'user-a');
      expect(userASummary.requests).toBe(1);
      expect(userASummary.costUsd).toBeCloseTo(0.005, 6);

      const userBSummary = getPaperclipUsageByCorrelation('run-iso', 'user-b');
      expect(userBSummary.requests).toBe(0);

      recordPaperclipAssignmentOutcome({
        issueId: 'iss-iso',
        agentId: 'agt-1',
        taskClass: 'code',
        success: true,
        costUsd: 0.004,
        durationMs: 900,
      });
      recordPaperclipAssignmentOutcome({
        issueId: 'iss-iso-2',
        agentId: 'agt-1',
        taskClass: 'code',
        success: true,
        costUsd: 0.006,
        durationMs: 1100,
      });

      const priors = getPaperclipOutcomePriors('code');
      expect(priors['agt-1']).toBeDefined();
      expect(priors['agt-1'].wins).toBe(2);
      expect(priors['agt-1'].total).toBe(2);
    });
  });

  describe('paperclip-assign (task classification & candidate scoring)', () => {
    it('classifies PII tasks as confidential and filters out cloud-only agents', () => {
      const classification = classifyPaperclipTask({
        title: 'Audit customer SSN records',
        description: 'Review user 123-45-6789 tax record in database',
        priority: 'high',
      });

      expect(classification.piiDetected).toBe(true);
      expect(classification.sensitivity).toBe('confidential');

      const result = recommendPaperclipAssignees(
        {
          title: 'Audit customer SSN records',
          description: 'Review user 123-45-6789 tax record in database',
          priority: 'high',
        },
        [
          {
            id: 'agt-local',
            name: 'Sovereign Auditor',
            role: 'security',
            capabilities: 'audit, security, sql, pii review',
            adapterType: 'eluvix_local',
            egressPolicy: 'local-only',
            status: 'idle',
            budgetMonthlyCents: 10000,
            spentMonthlyCents: 1000,
          },
          {
            id: 'agt-cloud',
            name: 'Cloud Helper',
            role: 'general',
            capabilities: 'audit, sql',
            adapterType: 'claude_local',
            egressPolicy: 'cloud-ok',
            status: 'idle',
            budgetMonthlyCents: 10000,
            spentMonthlyCents: 1000,
          },
        ]
      );

      expect(result.recommendations.map((r) => r.agentId)).toEqual(['agt-local']);
      expect(
        result.excluded.some((e) => e.agentId === 'agt-cloud' && e.reasonCode === 'sensitivity_cloud_blocked')
      ).toBe(true);
    });

    it('excludes agents whose monthly budget is exhausted', () => {
      const result = recommendPaperclipAssignees(
        {
          title: 'Write unit tests',
          description: 'Add Vitest coverage for router',
        },
        [
          {
            id: 'agt-broke',
            name: 'Over Budget',
            capabilities: 'typescript, vitest, tests',
            budgetMonthlyCents: 1000,
            spentMonthlyCents: 1000,
          },
          {
            id: 'agt-ready',
            name: 'Ready Coder',
            capabilities: 'typescript, vitest, tests',
            budgetMonthlyCents: 10000,
            spentMonthlyCents: 500,
          },
        ]
      );

      expect(result.recommendations[0]?.agentId).toBe('agt-ready');
      expect(result.excluded.some((e) => e.agentId === 'agt-broke' && e.reasonCode === 'budget_exhausted')).toBe(true);
    });
  });

  describe('MCP Switchyard tools', () => {
    it('registers and executes switchyard_* MCP tools', async () => {
      const names = ELUVIX_MCP_TOOLS.map((s) => s.name);
      expect(names).toContain('switchyard_capabilities');
      expect(names).toContain('switchyard_classify_task');
      expect(names).toContain('switchyard_explain_route');
      expect(names).toContain('switchyard_recommend_assignee');

      const config = makeTestConfig();
      const router = new Eluvix(config);
      const mcpCtx = { router, config };

      const capRes = await handleEluvixMcpMessage(
        {
          jsonrpc: '2.0',
          id: 1,
          method: 'tools/call',
          params: { name: 'switchyard_capabilities', arguments: {} },
        },
        mcpCtx
      );
      expect(capRes?.error).toBeUndefined();
      expect(capRes?.result?.isError).toBeFalsy();
      expect(capRes?.result?.content[0]?.text).toContain('local-ollama');

      const clsRes = await handleEluvixMcpMessage(
        {
          jsonrpc: '2.0',
          id: 2,
          method: 'tools/call',
          params: {
            name: 'switchyard_classify_task',
            arguments: { title: 'Refactor auth middleware', description: 'Implement JWT rotation' },
          },
        },
        mcpCtx
      );
      expect(clsRes?.result?.isError).toBeFalsy();
      expect(clsRes?.result?.content[0].text).toContain('suggestedTier');

      const expRes = await handleEluvixMcpMessage(
        {
          jsonrpc: '2.0',
          id: 3,
          method: 'tools/call',
          params: {
            name: 'switchyard_explain_route',
            arguments: { model: 'eluvix/auto', priority: 'critical' },
          },
        },
        mcpCtx
      );
      expect(expRes?.error).toBeUndefined();
      expect(expRes?.result?.isError).toBeFalsy();
      expect(expRes?.result?.content[0]?.text).toContain('chosenUpstreamId');

      const recRes = await handleEluvixMcpMessage(
        {
          jsonrpc: '2.0',
          id: 4,
          method: 'tools/call',
          params: {
            name: 'switchyard_recommend_assignee',
            arguments: {
              task: { title: 'Fix SQLite query' },
              candidates: [{ id: 'a1', name: 'DB Agent', capabilities: 'sqlite, sql, typescript' }],
            },
          },
        },
        mcpCtx
      );
      expect(recRes?.result?.isError).toBeFalsy();
      expect(recRes?.result?.content[0].text).toContain('a1');
    });
  });
});
