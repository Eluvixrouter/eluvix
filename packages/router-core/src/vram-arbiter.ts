import type { RouterConfig, UpstreamConfig } from './index.js';
import { validateUpstreamHttpEndpoint } from './ssrf-guard.js';

export type VramWorkloadKind = 'llm' | 'media' | 'audio';

export interface VramArbiterConfig {
  /**
   * Enable cooperative cross-engine GPU VRAM weight eviction between co-hosted
   * local engines (e.g., Ollama <-> ComfyUI) without stopping or killing containers.
   */
  enabled?: boolean;
  /**
   * Evict idle Ollama weights (`keep_alive: 0`) before heavy ComfyUI synthesis
   * (`flux-txt2img`, `wan21-txt2vid`, `hunyuan3d-mesh`) when zero LLM streams are in-flight.
   * Default: true when enabled.
   */
  evictOllamaBeforeComfyUi?: boolean;
  /**
   * Unload idle ComfyUI diffusion checkpoints (`POST /free`) before local LLM inference
   * following media synthesis when zero ComfyUI jobs are in-flight.
   * Default: true when enabled.
   */
  evictComfyUiBeforeLlm?: boolean;
  /**
   * Per-probe HTTP timeout in milliseconds for `/api/ps`, `keep_alive: 0`, and `/free`.
   * Default: 1500.
   */
  transitionTimeoutMs?: number;
}

export interface VramEvictionEvent {
  timestamp: string;
  targetEngine: 'ollama' | 'comfyui';
  upstreamId: string;
  detail: string;
}

export interface VramArbiterStats {
  activeInFlight: {
    llm: number;
    media: number;
    audio: number;
  };
  activeByEngine: Record<string, number>;
  lastActiveWorkload: VramWorkloadKind | 'none';
  ollamaEvictions: number;
  comfyUiEvictions: number;
  totalEvictions: number;
  skippedActiveInFlight: number;
  recentEvents: VramEvictionEvent[];
}

function normalizeLocalBaseUrl(endpoint: string): string {
  return endpoint
    .trim()
    .replace(/\/+$/, '')
    .replace(/\/v1$/, '');
}

export function classifyLocalEngineWorkload(upstream: UpstreamConfig): {
  kind: VramWorkloadKind | null;
  engineKey: string;
} {
  if (upstream.type === 'comfyui') {
    return { kind: 'media', engineKey: 'comfyui' };
  }
  if (
    upstream.type === 'audio' ||
    upstream.type === 'speaches' ||
    upstream.type === 'whisper' ||
    upstream.type === 'kokoro-tts'
  ) {
    const backend =
      upstream.audio?.sttBackend ||
      upstream.audio?.ttsBackend ||
      (upstream.type === 'audio' ? 'whisper' : upstream.type);
    return { kind: 'audio', engineKey: backend };
  }
  if (
    upstream.type === 'ollama' ||
    upstream.type === 'ramalama' ||
    upstream.type === 'vllm' ||
    upstream.type === 'sglang' ||
    upstream.type === 'lemonade'
  ) {
    return { kind: 'llm', engineKey: upstream.type };
  }
  return { kind: null, engineKey: upstream.type };
}

export class CooperativeVramArbiter {
  private activeInFlight: Record<VramWorkloadKind, number> = {
    llm: 0,
    media: 0,
    audio: 0,
  };
  private activeByEngine = new Map<string, number>();
  private activeByUpstream = new Map<string, number>();
  private lastActiveWorkload: VramWorkloadKind | 'none' = 'none';
  private ollamaEvictions = 0;
  private comfyUiEvictions = 0;
  private skippedActiveInFlight = 0;
  private recentEvents: VramEvictionEvent[] = [];
  private mutexTail: Promise<void> = Promise.resolve();

  private pushEvent(ev: VramEvictionEvent): void {
    this.recentEvents.push(ev);
    if (this.recentEvents.length > 25) {
      this.recentEvents.shift();
    }
  }

  private async runUnderTransitionMutex<T>(fn: () => Promise<T>): Promise<T> {
    let releaseMutex!: () => void;
    const prev = this.mutexTail;
    this.mutexTail = new Promise<void>((resolve) => {
      releaseMutex = resolve;
    });
    await prev;
    try {
      return await fn();
    } finally {
      releaseMutex();
    }
  }

  private async fetchWithTimeout(
    url: string,
    init: RequestInit,
    timeoutMs: number
  ): Promise<Response> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      return await fetch(url, { ...init, signal: controller.signal });
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Acquires an in-flight lease for `upstream` and (when `config.vramArbiter?.enabled` is true)
   * cooperatively evicts idle weights from competing GPU engines under a transition mutex.
   * Never stops or kills running Podman/Docker containers.
   */
  async acquireLease(
    upstream: UpstreamConfig,
    config: RouterConfig
  ): Promise<() => void> {
    const { kind, engineKey } = classifyLocalEngineWorkload(upstream);
    if (!kind) {
      return () => {};
    }

    const arbiterCfg = config.vramArbiter;
    if (arbiterCfg?.enabled) {
      await this.runUnderTransitionMutex(async () => {
        const timeoutMs = Math.max(250, arbiterCfg.transitionTimeoutMs ?? 1500);

        if (kind === 'media' && arbiterCfg.evictOllamaBeforeComfyUi !== false) {
          if (this.activeInFlight.llm > 0) {
            this.skippedActiveInFlight++;
          } else {
            const ollamaUpstreams = (config.upstreams || []).filter(
              (u) => u.type === 'ollama' && (this.activeByUpstream.get(u.id) || 0) === 0
            );
            for (const ollamaU of ollamaUpstreams) {
              const base = normalizeLocalBaseUrl(ollamaU.endpoint);
              const check = validateUpstreamHttpEndpoint(base, { allowLoopbackAndLan: true });
              if (!check.ok) continue;

              try {
                const psRes = await this.fetchWithTimeout(
                  `${base}/api/ps`,
                  { method: 'GET', headers: { Accept: 'application/json' } },
                  timeoutMs
                );
                if (!psRes.ok) continue;
                const psJson: any = await psRes.json().catch(() => null);
                const loadedModels: Array<{ name?: string; model?: string }> = Array.isArray(
                  psJson?.models
                )
                  ? psJson.models
                  : [];

                for (const m of loadedModels) {
                  const modelName = (m?.name || m?.model || '').trim();
                  if (!modelName) continue;
                  // Re-verify zero in-flight requests before evicting
                  if (this.activeInFlight.llm > 0 || (this.activeByUpstream.get(ollamaU.id) || 0) > 0) {
                    this.skippedActiveInFlight++;
                    break;
                  }
                  const unloadRes = await this.fetchWithTimeout(
                    `${base}/api/generate`,
                    {
                      method: 'POST',
                      headers: { 'Content-Type': 'application/json' },
                      body: JSON.stringify({ model: modelName, keep_alive: 0 }),
                    },
                    timeoutMs
                  );
                  if (unloadRes.ok) {
                    this.ollamaEvictions++;
                    this.pushEvent({
                      timestamp: new Date().toISOString(),
                      targetEngine: 'ollama',
                      upstreamId: ollamaU.id,
                      detail: `Evicted idle Ollama model "${modelName}" (keep_alive: 0) ahead of ComfyUI synthesis on "${upstream.id}"`,
                    });
                  }
                }
              } catch {
                // Best-effort cooperative eviction; never block inference on offline peer engine
              }
            }
          }
        } else if (
          kind === 'llm' &&
          arbiterCfg.evictComfyUiBeforeLlm !== false &&
          this.lastActiveWorkload === 'media'
        ) {
          if (this.activeInFlight.media > 0) {
            this.skippedActiveInFlight++;
          } else {
            const comfyUpstreams = (config.upstreams || []).filter(
              (u) => u.type === 'comfyui' && (this.activeByUpstream.get(u.id) || 0) === 0
            );
            for (const comfyU of comfyUpstreams) {
              const base = normalizeLocalBaseUrl(comfyU.endpoint);
              const check = validateUpstreamHttpEndpoint(base, { allowLoopbackAndLan: true });
              if (!check.ok) continue;

              try {
                const freeRes = await this.fetchWithTimeout(
                  `${base}/free`,
                  {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ unload_models: true, free_memory: true }),
                  },
                  timeoutMs
                );
                if (freeRes.ok) {
                  this.comfyUiEvictions++;
                  this.pushEvent({
                    timestamp: new Date().toISOString(),
                    targetEngine: 'comfyui',
                    upstreamId: comfyU.id,
                    detail: `Unloaded idle ComfyUI checkpoints (POST /free) ahead of local LLM inference on "${upstream.id}"`,
                  });
                }
              } catch {
                // Best-effort cooperative eviction
              }
            }
          }
        }

        // Increment in-flight counters inside the transition mutex so concurrent callers see it immediately
        this.activeInFlight[kind]++;
        this.activeByEngine.set(engineKey, (this.activeByEngine.get(engineKey) || 0) + 1);
        this.activeByUpstream.set(upstream.id, (this.activeByUpstream.get(upstream.id) || 0) + 1);
        this.lastActiveWorkload = kind;
      });
    } else {
      this.activeInFlight[kind]++;
      this.activeByEngine.set(engineKey, (this.activeByEngine.get(engineKey) || 0) + 1);
      this.activeByUpstream.set(upstream.id, (this.activeByUpstream.get(upstream.id) || 0) + 1);
      this.lastActiveWorkload = kind;
    }

    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.activeInFlight[kind] = Math.max(0, this.activeInFlight[kind] - 1);
      const nextEng = Math.max(0, (this.activeByEngine.get(engineKey) || 0) - 1);
      if (nextEng === 0) this.activeByEngine.delete(engineKey);
      else this.activeByEngine.set(engineKey, nextEng);

      const nextUp = Math.max(0, (this.activeByUpstream.get(upstream.id) || 0) - 1);
      if (nextUp === 0) this.activeByUpstream.delete(upstream.id);
      else this.activeByUpstream.set(upstream.id, nextUp);
    };
  }

  getStats(): VramArbiterStats {
    const activeByEngineObj: Record<string, number> = {};
    for (const [k, v] of this.activeByEngine.entries()) {
      activeByEngineObj[k] = v;
    }
    return {
      activeInFlight: { ...this.activeInFlight },
      activeByEngine: activeByEngineObj,
      lastActiveWorkload: this.lastActiveWorkload,
      ollamaEvictions: this.ollamaEvictions,
      comfyUiEvictions: this.comfyUiEvictions,
      totalEvictions: this.ollamaEvictions + this.comfyUiEvictions,
      skippedActiveInFlight: this.skippedActiveInFlight,
      recentEvents: [...this.recentEvents],
    };
  }

  reset(): void {
    this.activeInFlight = { llm: 0, media: 0, audio: 0 };
    this.activeByEngine.clear();
    this.activeByUpstream.clear();
    this.lastActiveWorkload = 'none';
    this.ollamaEvictions = 0;
    this.comfyUiEvictions = 0;
    this.skippedActiveInFlight = 0;
    this.recentEvents = [];
  }
}

export const globalVramArbiter = new CooperativeVramArbiter();

export function getVramArbiterStats(): VramArbiterStats {
  return globalVramArbiter.getStats();
}

export function resetVramArbiterStats(): void {
  globalVramArbiter.reset();
}
