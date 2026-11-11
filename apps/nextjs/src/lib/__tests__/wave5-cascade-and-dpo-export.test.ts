import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Node, Edge } from '@xyflow/react';
import { createNamedApiKey, saveChatMessage } from '@eluvix/router-core';
import { compileGraph } from '@/lib/orchestration/compiler';
import { decompileConfigToGraph } from '@/lib/orchestration/decompiler';
import { autoLayoutGraph } from '@/lib/orchestration/auto-layout';
import { diffRouterConfigs } from '@/lib/config-diff';
import { GET as exportGet } from '@/app/api/v1/export/route';
import { POST as votePost } from '@/app/api/v1/distillation/vote/route';

describe('Wave 2 Next.js Integration: SpeculativeCascadeNode, Bandit & SFT/DPO Export', () => {
  let tmpConfigDir: string;
  let tmpDataDir: string;
  let prevXdgConfig: string | undefined;
  let prevXdgData: string | undefined;

  beforeEach(() => {
    prevXdgConfig = process.env.XDG_CONFIG_HOME;
    prevXdgData = process.env.XDG_DATA_HOME;
    tmpConfigDir = fs.mkdtempSync(path.join(os.tmpdir(), 'eluvix-next-w5-cfg-'));
    tmpDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'eluvix-next-w5-data-'));
    process.env.XDG_CONFIG_HOME = tmpConfigDir;
    process.env.XDG_DATA_HOME = tmpDataDir;
  });

  afterEach(() => {
    if (prevXdgConfig === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = prevXdgConfig;
    if (prevXdgData === undefined) delete process.env.XDG_DATA_HOME;
    else process.env.XDG_DATA_HOME = prevXdgData;
    fs.rmSync(tmpConfigDir, { recursive: true, force: true });
    fs.rmSync(tmpDataDir, { recursive: true, force: true });
  });

  it('compiles, decompiles, auto-layouts, and diffs SpeculativeCascadeNode + thompson-bandit cleanly', () => {
    const nodes: Node[] = [
      { id: 'input-1', type: 'inputNode', position: { x: 0, y: 0 }, data: { label: 'Input' } },
      {
        id: 'sw-1',
        type: 'switchyardNode',
        position: { x: 300, y: 0 },
        data: { strategy: 'thompson-bandit' },
      },
      {
        id: 'cascade-1',
        type: 'speculativeCascadeNode',
        position: { x: 300, y: 300 },
        data: {
          confidenceThreshold: 0.84,
          maxDraftLatencyMs: 1800,
          validateJsonSchema: true,
          validateCodeFences: true,
          shadowSampleRate: 0.1,
        },
      },
      {
        id: 'lemonade-draft',
        type: 'lemonadeNode',
        position: { x: 700, y: 0 },
        data: { label: 'Lemonade Fast Draft', endpoint: 'http://localhost:13305' },
      },
      {
        id: 'agy-verifier',
        type: 'antigravityNode',
        position: { x: 700, y: 240 },
        data: { label: 'Gemini 4 Carbon Verifier', model: 'gemini-4-carbon' },
      },
      {
        id: 'ollama-student',
        type: 'ollamaNode',
        position: { x: 700, y: 480 },
        data: { label: 'Ollama Student', endpoint: 'http://localhost:11434' },
      },
    ];

    const edges: Edge[] = [
      { id: 'e1', source: 'input-1', target: 'sw-1' },
      { id: 'e2', source: 'input-1', target: 'cascade-1' },
      { id: 'e3', source: 'cascade-1', sourceHandle: 'draft', target: 'lemonade-draft' },
      { id: 'e4', source: 'cascade-1', sourceHandle: 'verifier', target: 'agy-verifier' },
      { id: 'e5', source: 'cascade-1', sourceHandle: 'shadow-student', target: 'ollama-student' },
    ];

    const laidOut = autoLayoutGraph(nodes, edges);
    const casNode = laidOut.find((n) => n.id === 'cascade-1')!;
    const draftNode = laidOut.find((n) => n.id === 'lemonade-draft')!;
    const verifierNode = laidOut.find((n) => n.id === 'agy-verifier')!;
    const studentNode = laidOut.find((n) => n.id === 'ollama-student')!;

    // Cascade sits in Rank 3 ahead of Rank 4 engines, and handle order places #draft above #verifier above #shadow-student
    expect(casNode.position.x).toBeLessThan(draftNode.position.x);
    expect(draftNode.position.y).toBeLessThan(verifierNode.position.y);
    expect(verifierNode.position.y).toBeLessThan(studentNode.position.y);

    const compiled = compileGraph(nodes, edges);
    const cfg = compiled.rawRouterConfig;
    expect(cfg.strategy).toBe('thompson-bandit');
    expect(cfg.switchyard.strategy).toBe('thompson-bandit');
    expect(cfg.cascade).toEqual({
      id: 'cascade-1',
      enabled: true,
      draftUpstreamId: 'lemonade-draft',
      verifierUpstreamId: 'agy-verifier',
      shadowStudentUpstreamId: 'ollama-student',
      confidenceThreshold: 0.84,
      maxDraftLatencyMs: 1800,
      validateJsonSchema: true,
      validateCodeFences: true,
      shadowSampleRate: 0.1,
    });

    // Config diff detects cascade modification
    const withoutCascade = { ...cfg, cascade: undefined };
    const diff = diffRouterConfigs(withoutCascade, cfg);
    expect(diff.cascadeChanged).toBe(true);
    expect(diff.isEmpty).toBe(false);

    // Reverse decompile reconstructs SpeculativeCascadeNode and its 3 handle edges
    const decompiled = decompileConfigToGraph(cfg);
    const reconstructedCascade = decompiled.nodes.find(
      (n) => n.type === 'speculativeCascadeNode'
    );
    expect(reconstructedCascade).toBeDefined();
    expect(
      decompiled.edges.some(
        (e) => e.source === 'cascade-1' && e.sourceHandle === 'draft' && e.target === 'lemonade-draft'
      )
    ).toBe(true);
    expect(
      decompiled.edges.some(
        (e) => e.source === 'cascade-1' && e.sourceHandle === 'verifier' && e.target === 'agy-verifier'
      )
    ).toBe(true);
    expect(
      decompiled.edges.some(
        (e) =>
          e.source === 'cascade-1' &&
          e.sourceHandle === 'shadow-student' &&
          e.target === 'ollama-student'
      )
    ).toBe(true);
  });

  it('records Arena votes scoped to userId with PII scrubbing and exports chat, SFT, and DPO JSONL', async () => {
    const aliceKey = createNamedApiKey({ label: 'Alice Key', userId: 'alice', role: 'operator' });
    const bobKey = createNamedApiKey({ label: 'Bob Key', userId: 'bob', role: 'operator' });

    // Record an Arena preference vote as Alice (with PII in prompt)
    const voteReq = new Request('http://localhost:3588/api/v1/distillation/vote', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': aliceKey.key,
      },
      body: JSON.stringify({
        prompt: 'Refactor auth handler for user@corp.internal',
        winnerUpstreamId: 'antigravity-1',
        loserUpstreamId: 'ollama-1',
        winnerModel: 'gemini-4-carbon',
        loserModel: 'qwen2.5:1.5b',
        chosenText: 'export function verifyToken(token: string): boolean { return token.length > 10; }',
        rejectedText: 'function verify(t) { return true; }',
      }),
    });
    const voteRes = await votePost(voteReq);
    expect(voteRes.status).toBe(200);
    const voteJson = await voteRes.json();
    expect(voteJson.success).toBe(true);
    expect(voteJson.pairId).toBeTruthy();

    // Alice exports DPO JSONL
    const dpoRes = await exportGet(
      new Request('http://localhost:3588/api/v1/export?format=dpo&minScore=0.8', {
        headers: { Authorization: `Bearer ${aliceKey.key}` },
      })
    );
    expect(dpoRes.status).toBe(200);
    expect(dpoRes.headers.get('x-eluvix-export-format')).toBe('dpo');
    const dpoText = (await dpoRes.text()).trim();
    const dpoLine = JSON.parse(dpoText);
    expect(JSON.stringify(dpoLine.prompt)).toContain('[REDACTED_EMAIL]');
    expect(dpoLine.chosen[0].content).toContain('verifyToken');
    expect(dpoLine.rejected[0].content).toContain('return true');

    // Alice exports SFT JSONL
    const sftRes = await exportGet(
      new Request('http://localhost:3588/api/v1/export?format=sft', {
        headers: { 'x-api-key': aliceKey.key },
      })
    );
    expect(sftRes.status).toBe(200);
    const sftLine = JSON.parse((await sftRes.text()).trim());
    expect(sftLine.messages).toHaveLength(2);

    // Bob sees ZERO of Alice's distillation pairs (strict user isolation)
    const bobDpoRes = await exportGet(
      new Request('http://localhost:3588/api/v1/export?format=dpo', {
        headers: { Authorization: `Bearer ${bobKey.key}` },
      })
    );
    expect(await bobDpoRes.text()).toBe('');

    // Default `?format=chat` (or omitted format) preserves legacy chat_history export
    saveChatMessage('sess-1', 'user', 'Hi', 'alice');
    saveChatMessage('sess-1', 'assistant', 'Hello!', 'alice');
    const chatRes = await exportGet(
      new Request('http://localhost:3588/api/v1/export', {
        headers: { Authorization: `Bearer ${aliceKey.key}` },
      })
    );
    expect(chatRes.status).toBe(200);
    const chatLine = JSON.parse((await chatRes.text()).trim());
    expect(chatLine.messages).toHaveLength(2);
  });
});
