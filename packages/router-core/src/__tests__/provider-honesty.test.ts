import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  EluvixProviderAgent,
  detectGpuHardware,
  probeLocalEngineModels
} from '../provider.js';
import { getProviderSettings, saveProviderSettings } from '../db.js';

/**
 * Regression tests for bug-hunt findings 9, 21, 25 (2026-10-22):
 * the provider agent must not fail open — no fabricated node identity,
 * no invented model catalog, no liveness timestamps for heartbeats that
 * never landed, and no fabricated GPU telemetry.
 */

const SERVER = 'http://billama.test';
const ENGINE = 'http://engine.test';

function jsonResponse(body: any, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' }
  });
}

interface FetchPlan {
  register: () => Response | Promise<Response>;
  /** null/undefined => engine connection throws; array => Ollama /api/tags payload models */
  engineModels?: Array<{ name: string; size?: number }> | null;
  heartbeat?: () => Response | Promise<Response>;
}

function stubFetch(plan: FetchPlan) {
  const mock = vi.fn(async (url: any, _init?: any): Promise<Response> => {
    const u = String(url);
    if (u.includes('/api/nodes/register')) return plan.register();
    if (u.includes('/api/nodes/heartbeat')) {
      return plan.heartbeat ? plan.heartbeat() : jsonResponse({});
    }
    if (u.startsWith(ENGINE)) {
      if (!plan.engineModels) throw new Error('connect ECONNREFUSED (engine)');
      if (u.includes('/api/tags')) return jsonResponse({ models: plan.engineModels });
      return jsonResponse({});
    }
    throw new Error(`unexpected fetch: ${u}`);
  });
  vi.stubGlobal('fetch', mock);
  return mock;
}

function makeAgent(): EluvixProviderAgent {
  const agent = new EluvixProviderAgent({
    serverUrl: SERVER,
    engineUrl: ENGINE,
    engineType: 'ollama',
    nodeToken: 'test-token',
    heartbeatIntervalMs: 60_000
  });
  // start() emits 'error' on failure; without a listener EventEmitter throws.
  agent.on('error', () => {});
  return agent;
}

function registerBody(fetchMock: ReturnType<typeof stubFetch>): any {
  const call = fetchMock.mock.calls.find((c) => String(c[0]).includes('/api/nodes/register'));
  if (!call) throw new Error('register endpoint was never called');
  return JSON.parse((call[1] as any).body);
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('Finding 9: registration failure is fatal and visible', () => {
  it('rejects start() when the marketplace rejects registration (401), persists no node id', async () => {
    const beforeNodeId = getProviderSettings()?.node_id ?? null;
    stubFetch({
      register: () => jsonResponse({ error: 'Invalid node token' }, 401),
      engineModels: [{ name: 'some-model', size: 1 }]
    });

    const agent = makeAgent();
    await expect(agent.start()).rejects.toThrow('Invalid node token');

    const status = await agent.getStatus();
    expect(status.status).not.toBe('ONLINE');
    expect(status.status).toBe('ERROR');
    expect(status.errorMessage).toContain('Invalid node token');
    expect((agent as any).isRunning).toBe(false);

    // No fabricated identity was persisted over whatever was there before.
    expect(getProviderSettings()?.node_id ?? null).toBe(beforeNodeId);
    expect(getProviderSettings()?.node_id ?? '').not.toMatch(/^eluvix-node-/);
  });

  it('rejects start() when the marketplace is unreachable', async () => {
    const beforeNodeId = getProviderSettings()?.node_id ?? null;
    stubFetch({
      register: () => {
        throw new Error('fetch failed: ECONNREFUSED (server)');
      },
      engineModels: [{ name: 'some-model', size: 1 }]
    });

    const agent = makeAgent();
    await expect(agent.start()).rejects.toThrow(/ECONNREFUSED/);

    const status = await agent.getStatus();
    expect(status.status).not.toBe('ONLINE');
    expect(status.errorMessage).toBeTruthy();
    expect(getProviderSettings()?.node_id ?? null).toBe(beforeNodeId);
    expect(getProviderSettings()?.node_id ?? '').not.toMatch(/^eluvix-node-/);
  });
});

describe('Finding 9: invented models are never registered as installed', () => {
  it('registers an empty catalog when the local engine does not answer probes', async () => {
    const fetchMock = stubFetch({
      register: () => jsonResponse({ node: { id: 'node-real-1', reputationScore: 99 }, rawToken: 'tok-1' }),
      engineModels: null // engine unreachable
    });

    const agent = makeAgent();
    await expect(agent.start()).resolves.toBeUndefined();
    try {
      expect(registerBody(fetchMock).models).toEqual([]);

      const status = await agent.getStatus();
      expect(status.status).toBe('ONLINE');
      expect(status.nodeId).toBe('node-real-1');
      expect(status.models).toEqual([]);
    } finally {
      await agent.stop();
    }
  });

  it('registers exactly the models the engine reported', async () => {
    const fetchMock = stubFetch({
      register: () => jsonResponse({ node: { id: 'node-real-2' }, rawToken: 'tok-2' }),
      engineModels: [{ name: 'real-llm:7b', size: 7_000_000_000 }]
    });

    const agent = makeAgent();
    await expect(agent.start()).resolves.toBeUndefined();
    try {
      const body = registerBody(fetchMock);
      expect(body.models).toHaveLength(1);
      expect(body.models[0].modelName).toBe('real-llm:7b');

      const status = await agent.getStatus();
      expect(status.models).toEqual(['real-llm:7b']);
    } finally {
      await agent.stop();
    }
  });

  it('probeLocalEngineModels distinguishes no-answer from an empty catalog', async () => {
    // No stub: a dead port refuses the connection.
    await expect(probeLocalEngineModels('http://127.0.0.1:9', 'ollama')).resolves.toBeNull();

    // Engine answers but serves no models: honest empty list.
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ models: [] })));
    await expect(probeLocalEngineModels(ENGINE, 'ollama')).resolves.toEqual([]);

    // Engine reports models: they come through.
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ models: [{ name: 'm1', size: 10 }] })));
    const probed = await probeLocalEngineModels(ENGINE, 'ollama');
    expect(probed?.map((m) => m.name)).toEqual(['m1']);
  });
});

describe('Finding 21: heartbeat liveness is recorded only on success', () => {
  const SENTINEL = '2000-01-01T00:00:00.000Z';

  function heartbeatReadyAgent(fetchImpl: (url: any, init?: any) => Promise<Response>) {
    const agent = makeAgent();
    // Skip real GPU probing; this "hardware" reports no temperature.
    agent.detectHardware = vi.fn().mockResolvedValue({
      vendor: 'CPU',
      model: 'Test CPU',
      count: 2,
      vramTotalGb: 16,
      vramFreeGb: 8
    });
    (agent as any).nodeId = 'node-hb-1';
    (agent as any).isRunning = true;
    const mock = vi.fn(fetchImpl);
    vi.stubGlobal('fetch', mock);
    return { agent, fetchMock: mock };
  }

  it('does not advance last_heartbeat_at when the server rejects the heartbeat', async () => {
    saveProviderSettings({ last_heartbeat_at: SENTINEL });
    const { agent } = heartbeatReadyAgent(async () => jsonResponse({ error: 'unknown node' }, 500));

    await (agent as any).sendHeartbeat();

    expect(getProviderSettings()?.last_heartbeat_at).toBe(SENTINEL);
  });

  it('does not advance last_heartbeat_at when the heartbeat never arrives', async () => {
    saveProviderSettings({ last_heartbeat_at: SENTINEL });
    const { agent } = heartbeatReadyAgent(async () => {
      throw new Error('fetch failed: ECONNREFUSED (heartbeat)');
    });

    await (agent as any).sendHeartbeat();

    expect(getProviderSettings()?.last_heartbeat_at).toBe(SENTINEL);
  });

  it('advances last_heartbeat_at on an accepted heartbeat, and reports no invented temperature', async () => {
    saveProviderSettings({ last_heartbeat_at: SENTINEL });
    const { agent, fetchMock } = heartbeatReadyAgent(async () => jsonResponse({}));

    await (agent as any).sendHeartbeat();

    const after = getProviderSettings()?.last_heartbeat_at;
    expect(after).toBeTruthy();
    expect(after).not.toBe(SENTINEL);
    expect(Date.parse(after as string)).toBeGreaterThan(Date.now() - 60_000);

    // The mocked hardware measured no temperature, so the payload must say
    // so (null) instead of claiming a measured 45.
    const hbCall = fetchMock.mock.calls.find((c) => String(c[0]).includes('/api/nodes/heartbeat'));
    const payload = JSON.parse((hbCall![1] as any).body);
    expect(payload.temperatureC).toBeNull();
  });
});

describe('Finding 25: GPU telemetry is measured or absent, never invented', () => {
  it('CPU fallback reports no fabricated temperature', async () => {
    const gpu = await detectGpuHardware();
    // On hosts with a real GPU this exercises a different path; the CPU
    // fallback is the one that hardcoded 45 °C.
    if (gpu.vendor === 'CPU') {
      expect(gpu.temperatureC).toBeUndefined();
      expect(gpu.vramTotalGb).toBeGreaterThan(0);
      expect(gpu.vramFreeGb).toBeGreaterThan(0);
    }
  });
});
