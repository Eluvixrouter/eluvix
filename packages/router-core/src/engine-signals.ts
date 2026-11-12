/**
 * Live Local & LAN Engine Load Signals Scraper (`@eluvix/router-core/engine-signals`).
 *
 * Scrapes real-time queue depth, KV cache occupancy, and VRAM residency from:
 * - vLLM / SGLang Prometheus `/metrics` (`vllm:num_requests_waiting`, `vllm:gpu_cache_usage_perc`, `sglang:num_queue_reqs`)
 * - Ollama `/api/ps` (currently loaded warm models in VRAM)
 * - ComfyUI `/queue` (`queue_running`, `queue_pending`)
 *
 * IMPORTANT: Keep ZERO `node:*` imports in this module so client-side diagnostics,
 * compiler, and simulator bundles can import `@eluvix/router-core/engine-signals`.
 */

import { validateUpstreamHttpEndpoint } from './ssrf-guard.js';

export interface EngineLoadSignal {
  upstreamId: string;
  engineType: 'vllm' | 'sglang' | 'ollama' | 'comfyui' | 'generic';
  reachable: boolean;
  scrapedAtMs: number;
  queueWaiting: number;
  queueRunning: number;
  kvCacheUsageRatio?: number;
  warmModels?: string[];
  vramUsedBytes?: number;
}

interface CachedEngineSignal {
  signal: EngineLoadSignal;
  expiresAtMs: number;
}

const engineSignalCache = new Map<string, CachedEngineSignal>();
export const DEFAULT_ENGINE_SIGNAL_TTL_MS = 2000;

export function clearEngineSignalCache(): void {
  engineSignalCache.clear();
}

export function setEngineSignalForTesting(upstreamId: string, signal: EngineLoadSignal, ttlMs = 60_000): void {
  engineSignalCache.set(upstreamId, {
    signal,
    expiresAtMs: Date.now() + ttlMs,
  });
}

export function getCachedEngineSignal(upstreamId: string, nowMs = Date.now()): EngineLoadSignal | undefined {
  const entry = engineSignalCache.get(upstreamId);
  if (!entry) return undefined;
  if (entry.expiresAtMs <= nowMs) {
    engineSignalCache.delete(upstreamId);
    return undefined;
  }
  return entry.signal;
}

/**
 * Parses Prometheus text exposition lines from vLLM (`/metrics`) or SGLang (`/metrics`).
 */
export function parsePrometheusEngineMetrics(rawText: string): {
  queueWaiting: number;
  queueRunning: number;
  kvCacheUsageRatio?: number;
} {
  let queueWaiting = 0;
  let queueRunning = 0;
  let kvCacheUsageRatio: number | undefined;

  if (!rawText || typeof rawText !== 'string') {
    return { queueWaiting, queueRunning };
  }

  for (const rawLine of rawText.split('\n')) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;

    // Match metric_name{optional="labels"} value
    const match = /^([a-zA-Z_:][a-zA-Z0-9_:]*)(?:\{[^}]*\})?\s+([+-]?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)/.exec(
      line
    );
    if (!match) continue;
    const metricName = match[1];
    const val = Number(match[2]);
    if (!Number.isFinite(val)) continue;

    if (
      metricName === 'vllm:num_requests_waiting' ||
      metricName === 'sglang:num_queue_reqs' ||
      metricName.endsWith(':num_requests_waiting')
    ) {
      queueWaiting += Math.max(0, Math.round(val));
    } else if (
      metricName === 'vllm:num_requests_running' ||
      metricName === 'sglang:num_running_reqs' ||
      metricName.endsWith(':num_requests_running')
    ) {
      queueRunning += Math.max(0, Math.round(val));
    } else if (
      metricName === 'vllm:gpu_cache_usage_perc' ||
      metricName === 'vllm:kv_cache_usage_perc' ||
      metricName === 'sglang:token_usage'
    ) {
      const normalized = val > 1 && val <= 100 ? val / 100 : Math.max(0, Math.min(1, val));
      kvCacheUsageRatio =
        kvCacheUsageRatio === undefined ? normalized : Math.max(kvCacheUsageRatio, normalized);
    }
  }

  return { queueWaiting, queueRunning, kvCacheUsageRatio };
}

/**
 * Parses Ollama `/api/ps` JSON response listing models currently resident in VRAM.
 */
export function parseOllamaPsResponse(payload: unknown): {
  warmModels: string[];
  vramUsedBytes: number;
} {
  if (!payload || typeof payload !== 'object') {
    return { warmModels: [], vramUsedBytes: 0 };
  }
  const models = Array.isArray((payload as any).models) ? (payload as any).models : [];
  const warmModels: string[] = [];
  let vramUsedBytes = 0;

  for (const m of models) {
    const name = typeof m?.name === 'string' ? m.name.trim() : typeof m?.model === 'string' ? m.model.trim() : '';
    if (name && !warmModels.includes(name)) {
      warmModels.push(name);
      const baseName = name.split(':')[0];
      if (baseName && !warmModels.includes(baseName)) {
        warmModels.push(baseName);
      }
    }
    const sizeVram = Number(m?.size_vram ?? m?.size ?? 0);
    if (Number.isFinite(sizeVram) && sizeVram > 0) {
      vramUsedBytes += sizeVram;
    }
  }

  return { warmModels, vramUsedBytes };
}

/**
 * Parses ComfyUI `/queue` JSON response.
 */
export function parseComfyQueueResponse(payload: unknown): {
  queueRunning: number;
  queueWaiting: number;
} {
  if (!payload || typeof payload !== 'object') {
    return { queueRunning: 0, queueWaiting: 0 };
  }
  const running = Array.isArray((payload as any).queue_running)
    ? (payload as any).queue_running.length
    : 0;
  const pending = Array.isArray((payload as any).queue_pending)
    ? (payload as any).queue_pending.length
    : 0;
  return { queueRunning: running, queueWaiting: pending };
}

/**
 * Computes a routing score delta from a live engine signal:
 * - Warm model in Ollama VRAM: `+25`
 * - Cold model on Ollama when other models occupy VRAM: `-10`
 * - Queue waiting penalty: `-15 * queueWaiting`
 * - High KV cache usage (`>= 0.90`): `-40`
 */
export function computeEngineLoadScoreAdjustment(
  signal: EngineLoadSignal | undefined,
  requestedModel?: string
): { scoreDelta: number; isModelWarm?: boolean; reason?: string } {
  if (!signal || !signal.reachable) {
    return { scoreDelta: 0 };
  }

  let scoreDelta = 0;
  let isModelWarm: boolean | undefined;
  const reasons: string[] = [];

  if (Array.isArray(signal.warmModels)) {
    const target = (requestedModel || '').trim().toLowerCase();
    if (target && target !== 'auto' && target !== '*') {
      const targetBase = target.split(':')[0];
      isModelWarm = signal.warmModels.some(
        (m) => m.toLowerCase() === target || m.toLowerCase() === targetBase
      );
      if (isModelWarm) {
        scoreDelta += 25;
        reasons.push(`warm-vram(${requestedModel})`);
      } else if (signal.warmModels.length > 0) {
        scoreDelta -= 10;
        reasons.push('cold-swap-needed');
      }
    } else if (signal.warmModels.length > 0) {
      isModelWarm = true;
      scoreDelta += 15;
      reasons.push(`warm-vram(${signal.warmModels[0]})`);
    }
  }

  if (signal.queueWaiting > 0) {
    const penalty = Math.min(90, signal.queueWaiting * 15);
    scoreDelta -= penalty;
    reasons.push(`queue-waiting=${signal.queueWaiting}`);
  }

  if (typeof signal.kvCacheUsageRatio === 'number') {
    if (signal.kvCacheUsageRatio >= 0.9) {
      scoreDelta -= 40;
      reasons.push(`kv-pressure=${(signal.kvCacheUsageRatio * 100).toFixed(0)}%`);
    } else if (signal.kvCacheUsageRatio >= 0.75) {
      scoreDelta -= 15;
      reasons.push(`kv-elevated=${(signal.kvCacheUsageRatio * 100).toFixed(0)}%`);
    }
  }

  return {
    scoreDelta,
    isModelWarm,
    reason: reasons.length > 0 ? reasons.join(', ') : 'nominal',
  };
}

/**
 * Formats an `X-Eluvix-Engine-Load` response header string.
 */
export function formatEngineLoadHeader(
  signal: EngineLoadSignal,
  requestedModel?: string
): string {
  const adj = computeEngineLoadScoreAdjustment(signal, requestedModel);
  const parts = [
    `engine=${signal.engineType}`,
    `waiting=${signal.queueWaiting}`,
    `running=${signal.queueRunning}`,
  ];
  if (typeof signal.kvCacheUsageRatio === 'number') {
    parts.push(`kv=${signal.kvCacheUsageRatio.toFixed(2)}`);
  }
  if (adj.isModelWarm !== undefined) {
    parts.push(`warm=${adj.isModelWarm ? 'true' : 'false'}`);
  }
  parts.push(`delta=${adj.scoreDelta}`);
  return parts.join(';');
}

/**
 * Probes a single local/LAN upstream for live queue & VRAM residency signals with a 2s TTL cache.
 */
export async function probeEngineLoadSignal(
  upstream: {
    id: string;
    type: string;
    endpoint: string;
  },
  options?: {
    fetchImpl?: typeof fetch;
    nowMs?: number;
    ttlMs?: number;
    timeoutMs?: number;
  }
): Promise<EngineLoadSignal | undefined> {
  const nowMs = options?.nowMs ?? Date.now();
  const cached = getCachedEngineSignal(upstream.id, nowMs);
  if (cached) return cached;

  const trimmed = (upstream.endpoint || '').trim().replace(/\/+$/, '').replace(/\/v1$/, '');
  const ssrf = validateUpstreamHttpEndpoint(trimmed, { allowLoopbackAndLan: true });
  if (!ssrf.ok) return undefined;

  const fetchFn = options?.fetchImpl || globalThis.fetch;
  const timeoutMs = options?.timeoutMs ?? 800;
  const ttlMs = options?.ttlMs ?? DEFAULT_ENGINE_SIGNAL_TTL_MS;

  try {
    if (upstream.type === 'ollama') {
      const res = await fetchFn(`${trimmed}/api/ps`, {
        method: 'GET',
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!res.ok) return undefined;
      const json = await res.json();
      const parsed = parseOllamaPsResponse(json);
      const signal: EngineLoadSignal = {
        upstreamId: upstream.id,
        engineType: 'ollama',
        reachable: true,
        scrapedAtMs: nowMs,
        queueWaiting: 0,
        queueRunning: parsed.warmModels.length > 0 ? 1 : 0,
        warmModels: parsed.warmModels,
        vramUsedBytes: parsed.vramUsedBytes,
      };
      engineSignalCache.set(upstream.id, { signal, expiresAtMs: nowMs + ttlMs });
      return signal;
    }

    if (upstream.type === 'comfyui') {
      const res = await fetchFn(`${trimmed}/queue`, {
        method: 'GET',
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!res.ok) return undefined;
      const json = await res.json();
      const parsed = parseComfyQueueResponse(json);
      const signal: EngineLoadSignal = {
        upstreamId: upstream.id,
        engineType: 'comfyui',
        reachable: true,
        scrapedAtMs: nowMs,
        queueWaiting: parsed.queueWaiting,
        queueRunning: parsed.queueRunning,
      };
      engineSignalCache.set(upstream.id, { signal, expiresAtMs: nowMs + ttlMs });
      return signal;
    }

    if (
      upstream.type === 'vllm' ||
      upstream.type === 'vllm-sr' ||
      upstream.type === 'sglang' ||
      upstream.type === 'ramalama'
    ) {
      const res = await fetchFn(`${trimmed}/metrics`, {
        method: 'GET',
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!res.ok) return undefined;
      const text = await res.text();
      const parsed = parsePrometheusEngineMetrics(text);
      const signal: EngineLoadSignal = {
        upstreamId: upstream.id,
        engineType: upstream.type === 'sglang' ? 'sglang' : 'vllm',
        reachable: true,
        scrapedAtMs: nowMs,
        queueWaiting: parsed.queueWaiting,
        queueRunning: parsed.queueRunning,
        kvCacheUsageRatio: parsed.kvCacheUsageRatio,
      };
      engineSignalCache.set(upstream.id, { signal, expiresAtMs: nowMs + ttlMs });
      return signal;
    }
  } catch {
    return undefined;
  }

  return undefined;
}
