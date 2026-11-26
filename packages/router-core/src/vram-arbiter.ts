import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
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

/**
 * Cross-process lease directory (hunt-3 L-A7). The in-process counters
 * below cannot see a second Eluvix process (desktop daemon + Next.js
 * gateway) sharing one Ollama/ComfyUI on the same box, so a process
 * could evict weights while the other had a stream in flight. Each
 * lease is one file per in-flight request, named
 * `<kind>-<pid>-<random>.lease`, holding `{ pid, kind, upstreamId }`.
 * The directory is the OS temp dir, shared by every process on the
 * box; a lease whose owner pid is dead is stale and is removed on
 * sight. All file operations are best-effort: if the temp dir is
 * unwritable, the arbiter degrades to in-process counters only and
 * never blocks inference.
 */
// Overridable for tests: the per-worker test setup points this at a
// worker-private temp dir so parallel workers' arbiters never see each
// other's leases. In production the env var is unset and every process
// on the box shares os.tmpdir()/eluvix-vram-leases — which is the point.
function getVramLeaseDir(): string {
  return process.env.ELUVIX_VRAM_LEASE_DIR || path.join(os.tmpdir(), 'eluvix-vram-leases');
}

function readLeaseMeta(file: string): { pid?: number; kind?: string } | null {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8')) as { pid?: number; kind?: string };
  } catch {
    return null;
  }
}

function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err: any) {
    // ESRCH: no such process. EPERM: alive, just not signalable.
    return err?.code !== 'ESRCH';
  }
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
  /** Absolute paths of cross-process lease files created by this instance. */
  private crossProcessLeases = new Set<string>();

  /**
   * Creates one cross-process lease file for an in-flight request
   * (hunt-3 L-A7). Returns the file path, or null when the lease could
   * not be created (best-effort: the in-process counters still apply).
   */
  private acquireCrossProcessLease(kind: VramWorkloadKind, upstreamId: string): string | null {
    try {
      fs.mkdirSync(getVramLeaseDir(), { recursive: true });
      const name = `${kind}-${process.pid}-${crypto.randomBytes(6).toString('hex')}.lease`;
      const file = path.join(getVramLeaseDir(), name);
      fs.writeFileSync(
        file,
        JSON.stringify({ pid: process.pid, kind, upstreamId, acquiredAt: Date.now() }),
        { flag: 'wx' }
      );
      this.crossProcessLeases.add(file);
      return file;
    } catch {
      return null;
    }
  }

  private releaseCrossProcessLease(file: string | null): void {
    if (!file) return;
    this.crossProcessLeases.delete(file);
    try {
      fs.unlinkSync(file);
    } catch {
      // Already removed (e.g. by another process's stale cleanup).
    }
  }

  /**
   * True when any live process on this box holds an in-flight lease of
   * `kind` — including this process's own leases. Stale leases (owner
   * pid dead) are removed and ignored. Returns false when the lease
   * directory cannot be read: fail-open to the in-process counters.
   */
  private hasLiveCrossProcessLease(kind: VramWorkloadKind): boolean {
    let entries: string[];
    try {
      entries = fs.readdirSync(getVramLeaseDir());
    } catch {
      return false;
    }
    for (const entry of entries) {
      if (!entry.startsWith(`${kind}-`) || !entry.endsWith('.lease')) continue;
      const file = path.join(getVramLeaseDir(), entry);
      const meta = readLeaseMeta(file);
      if (!meta || typeof meta.pid !== 'number') continue;
      if (!isPidAlive(meta.pid)) {
        try {
          fs.unlinkSync(file);
        } catch {
          // Another process removed it first.
        }
        continue;
      }
      return true;
    }
    return false;
  }

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

    // Hunt-3 L-A7: claim a cross-process lease BEFORE any eviction
    // decision, so a sibling process on this box sees this request in
    // flight. Only llm/media kinds participate in eviction; audio
    // leases are in-process only. The lease is created up front (not
    // inside the mutex) because the eviction checks below must observe
    // other processes' leases, and our own lease must be visible to
    // them for the whole request.
    const crossProcessLease =
      kind === 'llm' || kind === 'media'
        ? this.acquireCrossProcessLease(kind, upstream.id)
        : null;

    const arbiterCfg = config.vramArbiter;
    if (arbiterCfg?.enabled) {
      await this.runUnderTransitionMutex(async () => {
        const timeoutMs = Math.max(250, arbiterCfg.transitionTimeoutMs ?? 1500);

        if (kind === 'media' && arbiterCfg.evictOllamaBeforeComfyUi !== false) {
          // Hunt-3 L-A7: skip eviction when ANY process on this box has
          // an LLM stream in flight, not just this one.
          if (this.activeInFlight.llm > 0 || this.hasLiveCrossProcessLease('llm')) {
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
                  // (in-process AND cross-process — hunt-3 L-A7).
                  if (
                    this.activeInFlight.llm > 0 ||
                    (this.activeByUpstream.get(ollamaU.id) || 0) > 0 ||
                    this.hasLiveCrossProcessLease('llm')
                  ) {
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
          if (this.activeInFlight.media > 0 || this.hasLiveCrossProcessLease('media')) {
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
      this.releaseCrossProcessLease(crossProcessLease);
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
    for (const file of [...this.crossProcessLeases]) {
      this.releaseCrossProcessLease(file);
    }
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
