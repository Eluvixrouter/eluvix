import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import type { Node, Edge } from '@xyflow/react';
import { getChatHistory } from '@eluvix/router-core';
import { saveConfig } from '@/lib/router';
import { autoLayoutGraph } from '@/lib/orchestration/auto-layout';
import { decompileConfigToGraph } from '@/lib/orchestration/decompiler';
import {
  analyzeGraphDiagnostics,
  applyDiagnosticFix,
  applyAllDiagnosticFixes,
} from '@/lib/orchestration/diagnostics';
import { applySimulationOverlayToEdges } from '@/components/routing-editor/RouteSimulatorDrawer';
import { computeHistoryFingerprint } from '@/components/routing-editor/useGraphHistory';
import { POST as postRouteExplain } from '@/app/api/v1/route-explain/route';
import { POST as postChat } from '@/app/api/v1/chat/route';

describe('Wave 2 — Visual Node Routing Editor Pro-Studio UX & Playground 2.0 SSE', () => {
  let testDir: string;
  const originalXdg = process.env.XDG_CONFIG_HOME;
  const originalAdminPwd = process.env.ADMIN_PASSWORD;
  const ADMIN_TOKEN = 'test-wave2-admin-password';

  beforeEach(() => {
    testDir = path.join(
      os.tmpdir(),
      `eluvix-wave2-vitest-${Date.now()}-${Math.random().toString(36).slice(2)}`
    );
    process.env.XDG_CONFIG_HOME = path.join(testDir, 'config');
    process.env.ADMIN_PASSWORD = ADMIN_TOKEN;
  });

  afterEach(() => {
    vi.restoreAllMocks();
    if (originalXdg !== undefined) {
      process.env.XDG_CONFIG_HOME = originalXdg;
    } else {
      delete process.env.XDG_CONFIG_HOME;
    }
    if (originalAdminPwd !== undefined) {
      process.env.ADMIN_PASSWORD = originalAdminPwd;
    } else {
      delete process.env.ADMIN_PASSWORD;
    }
    try {
      if (testDir) fs.rmSync(testDir, { recursive: true, force: true });
    } catch {}
  });

  it('lays out scrambled DAG nodes into monotonic semantic ranks with Switchyard tier ordering and zero vertical overlap', () => {
    const scrambledNodes: Node[] = [
      { id: 'obs-1', type: 'observabilityNode', position: { x: 0, y: 0 }, data: {} },
      { id: 'comfy-1', type: 'comfyuiNode', position: { x: 0, y: 0 }, data: {} },
      { id: 'rama-1', type: 'ramalamaNode', position: { x: 0, y: 0 }, data: {} },
      { id: 'ollama-1', type: 'ollamaNode', position: { x: 0, y: 0 }, data: {} },
      { id: 'sw-1', type: 'switchyardNode', position: { x: 0, y: 0 }, data: {} },
      { id: 'guard-1', type: 'privacyGuardNode', position: { x: 0, y: 0 }, data: {} },
      { id: 'in-1', type: 'inputNode', position: { x: 0, y: 0 }, data: {} },
    ];

    const edges: Edge[] = [
      { id: 'e1', source: 'in-1', target: 'guard-1' },
      { id: 'e2', source: 'guard-1', target: 'sw-1' },
      { id: 'e3', source: 'sw-1', sourceHandle: 'tier-1', target: 'ollama-1' },
      { id: 'e4', source: 'sw-1', sourceHandle: 'tier-2', target: 'rama-1' },
      // ollama-1 acts as prompt enhancer into comfy-1, pushing comfy-1 to downstream rank
      { id: 'e5', source: 'ollama-1', target: 'comfy-1' },
      { id: 'e6', source: 'comfy-1', target: 'obs-1' },
      { id: 'e7', source: 'rama-1', target: 'obs-1' },
    ];

    const laidOut = autoLayoutGraph(scrambledNodes, edges);
    const byId = new Map(laidOut.map((n) => [n.id, n]));

    expect(byId.get('in-1')!.position.x).toBeLessThan(byId.get('guard-1')!.position.x);
    expect(byId.get('guard-1')!.position.x).toBeLessThan(byId.get('sw-1')!.position.x);
    expect(byId.get('sw-1')!.position.x).toBeLessThan(byId.get('ollama-1')!.position.x);
    expect(byId.get('ollama-1')!.position.x).toBe(byId.get('rama-1')!.position.x);
    expect(byId.get('ollama-1')!.position.x).toBeLessThan(byId.get('comfy-1')!.position.x);
    expect(byId.get('comfy-1')!.position.x).toBeLessThan(byId.get('obs-1')!.position.x);

    // Switchyard tier-1 (ollama-1) should sit strictly above tier-2 (rama-1) with >= 220px clearance
    expect(byId.get('ollama-1')!.position.y + 220).toBeLessThan(byId.get('rama-1')!.position.y);

    // Also verify decompileConfigToGraph integrates autoLayoutGraph cleanly
    const decompiled = decompileConfigToGraph({
      strategy: 'cost-complexity',
      privacyGuard: { enabled: true },
      upstreams: [
        { id: 'u-ollama', name: 'Ollama', type: 'ollama', endpoint: 'http://localhost:11434', priority: 20, models: ['qwen2.5-coder:7b'] },
        { id: 'u-agy', name: 'Carbon', type: 'antigravity', endpoint: 'cli://agy', priority: 10, models: ['gemini-4-carbon'] },
      ],
    } as any);
    const decInput = decompiled.nodes.find((n) => n.type === 'inputNode')!;
    const decSw = decompiled.nodes.find((n) => n.type === 'switchyardNode')!;
    const decAgy = decompiled.nodes.find((n) => n.type === 'antigravityNode')!;
    expect(decInput.position.x).toBeLessThan(decSw.position.x);
    expect(decSw.position.x).toBeLessThan(decAgy.position.x);
  });

  it('resolves port collisions, ComfyUI --highvram contention, orphaned engines, and VRAM overcommits via one-click Auto-Fix', () => {
    const buggyNodes: Node[] = [
      { id: 'in-1', type: 'inputNode', position: { x: 80, y: 200 }, data: {} },
      { id: 'sw-1', type: 'switchyardNode', position: { x: 420, y: 200 }, data: {} },
      {
        id: 'rama-1',
        type: 'ramalamaNode',
        position: { x: 800, y: 100 },
        data: { endpoint: 'http://localhost:8080', model: 'qwen2.5-coder:32b', maxContextTokens: 32768 },
      },
      {
        id: 'vllm-1',
        type: 'vllmNode',
        position: { x: 800, y: 400 },
        data: { endpoint: 'http://localhost:8080', model: 'llama-3.3-70b', maxContextTokens: 32768 },
      },
      {
        id: 'comfy-1',
        type: 'comfyuiNode',
        position: { x: 800, y: 700 },
        data: {
          endpoint: 'http://localhost:8188',
          vramMode: 'highvram',
          comfyui: { workflowPreset: 'flux-dev', vramMode: 'highvram' },
        },
      },
    ];

    const buggyEdges: Edge[] = [
      { id: 'e-in-sw', source: 'in-1', target: 'sw-1' },
      { id: 'e-sw-rama', source: 'sw-1', sourceHandle: 'tier-1', target: 'rama-1' },
      { id: 'e-sw-comfy', source: 'sw-1', sourceHandle: 'tier-2', target: 'comfy-1' },
      // Note: vllm-1 is intentionally unconnected AND collides with rama-1 on :8080!
    ];

    const initialReport = analyzeGraphDiagnostics(buggyNodes, buggyEdges, 24);
    const initialCodes = initialReport.diagnostics.map((d) => d.code);
    expect(initialCodes).toContain('PORT_COLLISION');
    expect(initialCodes).toContain('UNCONNECTED_ENGINE');
    expect(initialCodes).toContain('VRAM_OVERCOMMIT');

    // Test single fix for PORT_COLLISION
    const portDiag = initialReport.diagnostics.find((d) => d.code === 'PORT_COLLISION')!;
    const afterPortFix = applyDiagnosticFix(buggyNodes, buggyEdges, portDiag);
    const vllmFixed = afterPortFix.nodes.find((n) => n.id === 'vllm-1')!;
    expect((vllmFixed.data as any).endpoint).toBe('http://localhost:8081');

    // Test single fix for ComfyUI --highvram co-hosting pin
    const comfyPinDiag = initialReport.diagnostics.find((d) => d.id.startsWith('comfyui-vram-pin-'))!;
    expect(comfyPinDiag).toBeDefined();
    const afterComfyFix = applyDiagnosticFix(buggyNodes, buggyEdges, comfyPinDiag);
    const comfyFixed = afterComfyFix.nodes.find((n) => n.id === 'comfy-1')!;
    expect((comfyFixed.data as any).comfyui.vramMode).toBe('lowvram');
    expect((comfyFixed.data as any).comfyui.reserveVramGb).toBeGreaterThanOrEqual(6);

    // Test applyAllDiagnosticFixes across the entire graph (with 48 GB budget so 4-bit quant resolves VRAM overcommit cleanly)
    const allFixed = applyAllDiagnosticFixes(buggyNodes, buggyEdges, 48);
    expect(allFixed.appliedCount).toBeGreaterThanOrEqual(3);

    const finalReport = analyzeGraphDiagnostics(allFixed.nodes, allFixed.edges, 48);
    expect(finalReport.diagnostics).toHaveLength(0);
  });

  it('computes non-destructive simulation edge overlays and ignores ephemeral status fields in Undo fingerprints', () => {
    const nodes: Node[] = [
      { id: 'in-1', type: 'inputNode', position: { x: 80, y: 100 }, data: {} },
      { id: 'sw-1', type: 'switchyardNode', position: { x: 400, y: 100 }, data: {} },
      { id: 'agy-1', type: 'antigravityNode', position: { x: 800, y: 60 }, data: { model: 'gemini-4-carbon' } },
      { id: 'ollama-1', type: 'ollamaNode', position: { x: 800, y: 320 }, data: { model: 'qwen2.5:7b' } },
      { id: 'claude-1', type: 'claudeNode', position: { x: 800, y: 580 }, data: {} },
      { id: 'obs-1', type: 'observabilityNode', position: { x: 1200, y: 100 }, data: {} },
    ];
    const baseEdges: Edge[] = [
      { id: 'e-in-sw', source: 'in-1', target: 'sw-1' },
      { id: 'e-sw-agy', source: 'sw-1', target: 'agy-1' },
      { id: 'e-sw-ollama', source: 'sw-1', target: 'ollama-1' },
      { id: 'e-sw-claude', source: 'sw-1', target: 'claude-1' },
      { id: 'e-agy-obs', source: 'agy-1', target: 'obs-1' },
    ];

    const overlay = applySimulationOverlayToEdges(baseEdges, nodes, {
      model: 'auto',
      strategy: 'cost-complexity',
      complexity: { score: 85, label: 'frontier', tokenEstimate: 1200, hasImages: false, hasTools: false },
      steps: [],
      rankedUpstreams: [
        { id: 'agy-1', name: 'Carbon', type: 'antigravity' },
        { id: 'ollama-1', name: 'Ollama', type: 'ollama' },
      ],
      chosenUpstreamId: 'agy-1',
    });

    // Base edges untouched
    expect(baseEdges[1].label).toBeUndefined();

    const byEdgeId = new Map(overlay.map((e) => [e.id, e]));
    expect(byEdgeId.get('e-in-sw')!.style?.stroke).toBe('#10b981');
    expect(byEdgeId.get('e-sw-agy')!.style?.stroke).toBe('#10b981');
    expect(byEdgeId.get('e-sw-agy')!.label).toBe('⚡ #1 Selected');
    expect(byEdgeId.get('e-agy-obs')!.style?.stroke).toBe('#10b981');
    expect(byEdgeId.get('e-sw-ollama')!.style?.stroke).toBe('#f59e0b');
    expect(byEdgeId.get('e-sw-ollama')!.label).toBe('Backup #2');
    expect(byEdgeId.get('e-sw-claude')!.style?.opacity).toBe(0.2);

    // Undo fingerprint ignores ephemeral health/model probes
    const fp1 = computeHistoryFingerprint(nodes, baseEdges);
    const nodesWithEphemeralProbe = nodes.map((n) =>
      n.id === 'ollama-1'
        ? { ...n, data: { ...n.data, status: 'online', models: ['qwen2.5:7b'], liveTelemetry: { rps: 3 } } }
        : n
    );
    const fp2 = computeHistoryFingerprint(nodesWithEphemeralProbe, baseEdges);
    expect(fp1).toBe(fp2);
  });

  it('simulates unsaved canvas graphs in-memory via configOverride on POST /api/v1/route-explain', async () => {
    saveConfig({
      strategy: 'priority',
      upstreams: [
        { id: 'saved-ollama', name: 'Saved Ollama', type: 'ollama', endpoint: 'http://127.0.0.1:11434', priority: 10, models: ['*'] },
      ],
    });

    const res = await postRouteExplain(
      new Request('http://localhost:3588/api/v1/route-explain', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${ADMIN_TOKEN}`,
        },
        body: JSON.stringify({
          model: 'auto',
          messages: [{ role: 'user', content: '/imagine an emerald glass citadel above clouds' }],
          configOverride: {
            strategy: 'cost-complexity',
            upstreams: [
              { id: 'ephemeral-ollama', name: 'Canvas Ollama', type: 'ollama', endpoint: 'http://127.0.0.1:11434', priority: 50, models: ['qwen2.5:7b'] },
              {
                id: 'ephemeral-comfy',
                name: 'Canvas ComfyUI',
                type: 'comfyui',
                endpoint: 'http://127.0.0.1:8188',
                priority: 20,
                models: ['flux1-dev.safetensors'],
                comfyui: { workflowPreset: 'flux-dev' },
              },
            ],
          },
        }),
      })
    );

    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.modality?.synthesisIntent).toBe('image-gen');
    expect(json.chosenUpstreamId).toBe('ephemeral-comfy');
  });

  it('supports both backward-compatible JSON (stream: false) and real-time SSE (stream: true) on POST /api/v1/chat with SQLite history persistence', async () => {
    saveConfig({
      strategy: 'priority',
      upstreams: [
        {
          id: 'local-ollama-sse',
          name: 'Local Ollama',
          type: 'ollama',
          endpoint: 'http://127.0.0.1:11434',
          priority: 50,
          models: ['*'],
        },
      ],
    });

    // 1. Non-streaming backward-compatible JSON mode
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          id: 'chatcmpl-sync-1',
          object: 'chat.completion',
          choices: [{ index: 0, message: { role: 'assistant', content: 'Sync reply OK' }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 10, completion_tokens: 4, total_tokens: 14 },
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      )
    );

    const syncRes = await postChat(
      new Request('http://localhost:3588/api/v1/chat', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${ADMIN_TOKEN}`,
        },
        body: JSON.stringify({
          model: 'auto',
          session_id: 'sess-sync-1',
          messages: [{ role: 'user', content: 'Ping sync' }],
        }),
      })
    );
    expect(syncRes.status).toBe(200);
    const syncJson = await syncRes.json();
    expect(syncJson.success).toBe(true);
    expect(syncJson.data.choices[0].message.content).toBe('Sync reply OK');
    expect(syncJson.trace.upstream).toBe('local-ollama-sse');

    // 2. Real-time SSE streaming mode (stream: true)
    const enc = new TextEncoder();
    const upstreamSse = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(
          enc.encode(
            `data: ${JSON.stringify({
              id: 'chatcmpl-sse-1',
              choices: [{ index: 0, delta: { reasoning_content: 'Checking invariants...' } }],
            })}\n\n`
          )
        );
        controller.enqueue(
          enc.encode(
            `data: ${JSON.stringify({
              id: 'chatcmpl-sse-1',
              choices: [{ index: 0, delta: { content: 'Hello ' } }],
            })}\n\n`
          )
        );
        controller.enqueue(
          enc.encode(
            `data: ${JSON.stringify({
              id: 'chatcmpl-sse-1',
              choices: [{ index: 0, delta: { content: 'Gemini 4 Carbon!' }, finish_reason: 'stop' }],
            })}\n\n`
          )
        );
        controller.enqueue(enc.encode('data: [DONE]\n\n'));
        controller.close();
      },
    });

    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(upstreamSse, {
        status: 200,
        headers: { 'Content-Type': 'text/event-stream; charset=utf-8' },
      })
    );

    const streamRes = await postChat(
      new Request('http://localhost:3588/api/v1/chat', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${ADMIN_TOKEN}`,
        },
        body: JSON.stringify({
          model: 'auto',
          stream: true,
          session_id: 'sess-stream-1',
          messages: [{ role: 'user', content: 'Stream test' }],
        }),
      })
    );

    expect(streamRes.status).toBe(200);
    expect(streamRes.headers.get('content-type')).toContain('text/event-stream');
    const rawSseText = await streamRes.text();
    expect(rawSseText).toContain('event: eluvix_trace');
    expect(rawSseText).toContain('Gemini 4 Carbon!');
    expect(rawSseText).toContain('event: eluvix_done');

    // Verify assembled <think> + content was persisted to SQLite chat history
    const savedMsgs = getChatHistory('sess-stream-1', 'default');
    expect(savedMsgs.length).toBe(2);
    expect(savedMsgs[0].content).toBe('Stream test');
    expect(savedMsgs[1].content).toContain('<think>');
    expect(savedMsgs[1].content).toContain('Checking invariants...');
    expect(savedMsgs[1].content).toContain('Hello Gemini 4 Carbon!');
  });
});
