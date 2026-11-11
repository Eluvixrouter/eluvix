import { escapeShellArg, sanitizeSafeIdentifier, sanitizePositiveInt } from './shell-utils.js';
import type { HarnessMcpServerConfig } from './harness/types.js';
import { validateUpstreamHttpEndpoint } from './ssrf-guard.js';

export type ComfyWorkflowPreset =
  | 'sdxl-txt2img'
  | 'flux-txt2img'
  | 'wan21-txt2vid'
  | 'hunyuan3d-mesh'
  | 'custom-json';

export type ComfyVramMode =
  | 'normalvram'
  | 'highvram'
  | 'gpu-only'
  | 'lowvram'
  | 'novram'
  | 'cpu';

export interface ComfyUIConfig {
  workflowPreset?: ComfyWorkflowPreset;
  checkpoint?: string;
  steps?: number;
  cfg?: number;
  samplerName?: string;
  scheduler?: string;
  width?: number;
  height?: number;
  batchSize?: number;
  negativePrompt?: string;
  seed?: number;
  vramMode?: ComfyVramMode;
  reserveVramGb?: number;
  /** Pillar 3: Upstream ID of a local LLM (Lemonade/Ollama/RamaLama) that expands prompts before ComfyUI execution */
  promptEnhancerUpstreamId?: string;
  /** Pillar 3: Downstream ArtCraft app ('photocraft' | 'filmcraft' | 'vectorcraft') for post-processing rendered outputs */
  postProcessArtCraftApp?: string;
  /** Pillar 4: Reverse loopback URL for ComfyUI LLM/VLM custom nodes calling back into Eluvix (:3588/v1) */
  loopbackEluvixUrl?: string;
  mcpEnabled?: boolean;
  customWorkflowJson?: Record<string, any> | string;
}

export const COMFYUI_MCP_TOOLS = [
  'comfyui_generate_image',
  'comfyui_generate_video',
  'comfyui_run_workflow',
  'comfyui_list_models',
  'comfyui_get_system_stats',
  'comfyui_get_queue',
  'comfyui_cancel_prompt',
] as const;

export function parseSizeDimensions(
  sizeStr?: string,
  defaultWidth = 1024,
  defaultHeight = 1024
): { width: number; height: number } {
  if (!sizeStr) return { width: defaultWidth, height: defaultHeight };
  const match = sizeStr.trim().match(/^(\d{2,5})x(\d{2,5})$/i);
  if (!match) return { width: defaultWidth, height: defaultHeight };
  const width = Math.min(4096, Math.max(64, parseInt(match[1], 10)));
  const height = Math.min(4096, Math.max(64, parseInt(match[2], 10)));
  return { width, height };
}

/**
 * Builds a ComfyUI API-format workflow DAG (`POST /prompt` payload `prompt` object)
 * for the selected preset or substitutes parameters into a custom API JSON graph.
 */
export function buildComfyApiWorkflow(params: {
  prompt: string;
  negativePrompt?: string;
  config?: ComfyUIConfig;
  modelOverride?: string;
  sizeOverride?: string;
  seedOverride?: number;
  batchSizeOverride?: number;
}): Record<string, any> {
  const cfg = params.config || {};
  const preset: ComfyWorkflowPreset = cfg.workflowPreset || 'flux-txt2img';
  const positivePrompt = params.prompt || 'high quality detailed digital illustration';
  const negativePrompt =
    params.negativePrompt ??
    cfg.negativePrompt ??
    'blurry, low quality, distorted, watermark, artifacts';
  const seed =
    params.seedOverride ??
    cfg.seed ??
    Math.floor(Math.random() * 2147483647);

  const defaultW = cfg.width || 1024;
  const defaultH = cfg.height || 1024;
  const { width, height } = parseSizeDimensions(params.sizeOverride, defaultW, defaultH);
  const rawBatch = params.batchSizeOverride ?? cfg.batchSize ?? 1;
  const batchSize = Number.isFinite(Number(rawBatch))
    ? Math.min(8, Math.max(1, Math.floor(Number(rawBatch))))
    : 1;

  const rawCkpt =
    params.modelOverride && params.modelOverride !== '*' && params.modelOverride !== 'auto'
      ? params.modelOverride
      : cfg.checkpoint && cfg.checkpoint !== '*'
      ? cfg.checkpoint
      : preset === 'flux-txt2img'
      ? 'flux1-dev-fp8.safetensors'
      : preset === 'wan21-txt2vid'
      ? 'wan2.1_t2v_14B_fp8_e4m3fn.safetensors'
      : preset === 'hunyuan3d-mesh'
      ? 'hunyuan3d-dit-v2-0.safetensors'
      : 'sd_xl_base_1.0.safetensors';

  if (preset === 'custom-json' && cfg.customWorkflowJson) {
    try {
      const rawStr =
        typeof cfg.customWorkflowJson === 'string'
          ? cfg.customWorkflowJson
          : JSON.stringify(cfg.customWorkflowJson);
      const replaced = rawStr
        .replace(/\{\{positive_prompt\}\}/g, JSON.stringify(positivePrompt).slice(1, -1))
        .replace(/\{\{negative_prompt\}\}/g, JSON.stringify(negativePrompt).slice(1, -1))
        .replace(/\{\{ckpt_name\}\}/g, JSON.stringify(rawCkpt).slice(1, -1))
        .replace(/"\{\{seed\}\}"|\{\{seed\}\}/g, String(seed))
        .replace(/"\{\{steps\}\}"|\{\{steps\}\}/g, String(cfg.steps ?? 20))
        .replace(/"\{\{cfg\}\}"|\{\{cfg\}\}/g, String(cfg.cfg ?? 7.0))
        .replace(/"\{\{width\}\}"|\{\{width\}\}/g, String(width))
        .replace(/"\{\{height\}\}"|\{\{height\}\}/g, String(height))
        .replace(/"\{\{batch_size\}\}"|\{\{batch_size\}\}/g, String(batchSize));
      const parsed = JSON.parse(replaced);
      if (parsed && typeof parsed === 'object') {
        return parsed;
      }
    } catch {
      // Fall through to standard preset if custom JSON is invalid
    }
  }

  if (preset === 'wan21-txt2vid') {
    const steps = cfg.steps ?? 24;
    const cfgScale = cfg.cfg ?? 6.0;
    return {
      '3': {
        class_type: 'KSampler',
        inputs: {
          seed,
          steps,
          cfg: cfgScale,
          sampler_name: cfg.samplerName || 'uni_pc',
          scheduler: cfg.scheduler || 'simple',
          denoise: 1,
          model: ['4', 0],
          positive: ['6', 0],
          negative: ['7', 0],
          latent_image: ['5', 0],
        },
      },
      '4': {
        class_type: 'CheckpointLoaderSimple',
        inputs: { ckpt_name: rawCkpt },
      },
      '5': {
        class_type: 'EmptyHunyuanLatentVideo',
        inputs: { width: width || 832, height: height || 480, length: 33, batch_size: batchSize },
      },
      '6': {
        class_type: 'CLIPTextEncode',
        inputs: { text: positivePrompt, clip: ['4', 1] },
      },
      '7': {
        class_type: 'CLIPTextEncode',
        inputs: { text: negativePrompt, clip: ['4', 1] },
      },
      '8': {
        class_type: 'VAEDecode',
        inputs: { samples: ['3', 0], vae: ['4', 2] },
      },
      '9': {
        class_type: 'SaveAnimatedWEBP',
        inputs: {
          filename_prefix: 'Eluvix_Wan21',
          fps: 16,
          lossless: false,
          quality: 85,
          method: 'default',
          images: ['8', 0],
        },
      },
    };
  }

  if (preset === 'hunyuan3d-mesh') {
    return {
      '4': {
        class_type: 'CheckpointLoaderSimple',
        inputs: { ckpt_name: rawCkpt },
      },
      '6': {
        class_type: 'CLIPTextEncode',
        inputs: { text: positivePrompt, clip: ['4', 1] },
      },
      '9': {
        class_type: 'SaveGLB',
        inputs: {
          filename_prefix: 'Eluvix_Hunyuan3D',
          mesh: ['4', 0],
        },
      },
    };
  }

  // Default: flux-txt2img or sdxl-txt2img standard ComfyUI API graph
  const isFlux = preset === 'flux-txt2img';
  const steps = cfg.steps ?? (isFlux ? 20 : 25);
  const cfgScale = cfg.cfg ?? (isFlux ? 1.0 : 7.0);
  const samplerName = cfg.samplerName || 'euler';
  const scheduler = cfg.scheduler || (isFlux ? 'simple' : 'normal');

  return {
    '3': {
      class_type: 'KSampler',
      inputs: {
        seed,
        steps,
        cfg: cfgScale,
        sampler_name: samplerName,
        scheduler,
        denoise: 1,
        model: ['4', 0],
        positive: ['6', 0],
        negative: ['7', 0],
        latent_image: ['5', 0],
      },
    },
    '4': {
      class_type: 'CheckpointLoaderSimple',
      inputs: {
        ckpt_name: rawCkpt,
      },
    },
    '5': {
      class_type: 'EmptyLatentImage',
      inputs: {
        width,
        height,
        batch_size: batchSize,
      },
    },
    '6': {
      class_type: 'CLIPTextEncode',
      inputs: {
        text: positivePrompt,
        clip: ['4', 1],
      },
    },
    '7': {
      class_type: 'CLIPTextEncode',
      inputs: {
        text: isFlux ? '' : negativePrompt,
        clip: ['4', 1],
      },
    },
    '8': {
      class_type: 'VAEDecode',
      inputs: {
        samples: ['3', 0],
        vae: ['4', 2],
      },
    },
    '9': {
      class_type: 'SaveImage',
      inputs: {
        filename_prefix: isFlux ? 'Eluvix_Flux' : 'Eluvix_SDXL',
        images: ['8', 0],
      },
    },
  };
}

/**
 * Parses model lists returned by ComfyUI's `/models/{folder}` or `/object_info/CheckpointLoaderSimple`.
 */
export function parseComfyModelsResponse(
  data: any,
  folder = 'checkpoints'
): {
  models: string[];
  details: Array<{ id: string; name: string; recipe?: string; labels?: string[] }>;
} {
  const modelSet = new Set<string>();
  const details: Array<{ id: string; name: string; recipe?: string; labels?: string[] }> = [];

  const addModel = (rawName: unknown, label: string) => {
    if (typeof rawName !== 'string') return;
    const id = rawName.trim();
    if (!id || modelSet.has(id)) return;
    modelSet.add(id);
    const lower = id.toLowerCase();
    const tags = [label];
    if (lower.includes('flux')) tags.push('Flux');
    else if (lower.includes('xl') || lower.includes('sdxl')) tags.push('SDXL');
    else if (lower.includes('wan')) tags.push('Wan-Video');
    else if (lower.includes('hunyuan')) tags.push('Hunyuan');
    if (lower.includes('fp8')) tags.push('FP8');
    else if (lower.includes('gguf')) tags.push('GGUF');

    details.push({
      id,
      name: id,
      recipe: 'comfyui',
      labels: tags,
    });
  };

  // 1. Plain string array from GET /models/checkpoints or /models/diffusion_models or /models/unet
  if (Array.isArray(data)) {
    for (const item of data) {
      if (typeof item === 'string') {
        addModel(item, folder);
      } else if (item && typeof item === 'object') {
        addModel(item.id || item.name || item.filename, folder);
      }
    }
  } else if (data && typeof data === 'object') {
    // 2. GET /object_info/CheckpointLoaderSimple or /object_info
    const ckptLoader = data.CheckpointLoaderSimple || data.UNETLoader;
    const requiredInputs = ckptLoader?.input?.required;
    const ckptList = requiredInputs?.ckpt_name?.[0] || requiredInputs?.unet_name?.[0];
    if (Array.isArray(ckptList)) {
      for (const item of ckptList) {
        addModel(item, 'checkpoint');
      }
    }
    // 3. Standard OpenAI { data: [...] } fallback
    if (Array.isArray(data.data)) {
      for (const item of data.data) {
        addModel(typeof item === 'string' ? item : item?.id || item?.name, folder);
      }
    }
  }

  return {
    models: Array.from(modelSet),
    details,
  };
}

export interface ComfyGeneratedMedia {
  filename: string;
  subfolder: string;
  type: string;
  viewUrl: string;
}

export interface ComfyExecutionResult {
  promptId: string;
  images: ComfyGeneratedMedia[];
  workflow: Record<string, any>;
}

/**
 * Submits a workflow DAG to ComfyUI `POST /prompt` and polls `GET /history/{prompt_id}`
 * until output media artifacts are ready.
 */
export async function executeComfyWorkflow(
  endpoint: string,
  workflow: Record<string, any>,
  options?: {
    timeoutMs?: number;
    pollIntervalMs?: number;
    signal?: AbortSignal;
  }
): Promise<ComfyExecutionResult> {
  const endpointCheck = validateUpstreamHttpEndpoint(endpoint, { allowLoopbackAndLan: true });
  if (!endpointCheck.ok) {
    throw new Error(`Blocked unsafe ComfyUI endpoint: ${endpointCheck.reason}`);
  }
  const base = endpoint.trim().replace(/\/+$/, '').replace(/\/v1$/, '');
  const timeoutMs = options?.timeoutMs ?? 60000;
  const pollIntervalMs = options?.pollIntervalMs ?? 500;
  const deadline = Date.now() + timeoutMs;

  const promptRes = await fetch(`${base}/prompt`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      prompt: workflow,
      client_id: 'eluvix-router',
    }),
    signal: options?.signal,
  });

  if (!promptRes.ok) {
    const errText = await promptRes.text().catch(() => '');
    throw new Error(`ComfyUI /prompt failed (${promptRes.status}): ${errText || promptRes.statusText}`);
  }

  const promptJson = (await promptRes.json()) as { prompt_id?: string };
  const promptId = String(promptJson?.prompt_id || '').trim();
  if (!promptId) {
    throw new Error('ComfyUI /prompt response did not include a prompt_id');
  }

  const images: ComfyGeneratedMedia[] = [];

  while (Date.now() < deadline) {
    if (options?.signal?.aborted) {
      throw new DOMException('Client aborted ComfyUI generation', 'AbortError');
    }

    try {
      const histRes = await fetch(`${base}/history/${encodeURIComponent(promptId)}`, {
        method: 'GET',
        headers: { Accept: 'application/json' },
        signal: options?.signal,
      });

      if (histRes.ok) {
        const histJson = (await histRes.json()) as Record<string, any>;
        const entry = histJson?.[promptId] || histJson;
        const outputs = entry?.outputs;
        if (outputs && typeof outputs === 'object' && Object.keys(outputs).length > 0) {
          for (const nodeOut of Object.values(outputs) as Array<Record<string, any>>) {
            const mediaBuckets = [
              ...(Array.isArray(nodeOut?.images) ? nodeOut.images : []),
              ...(Array.isArray(nodeOut?.gifs) ? nodeOut.gifs : []),
              ...(Array.isArray(nodeOut?.audio) ? nodeOut.audio : []),
              ...(Array.isArray(nodeOut?.['3d']) ? nodeOut['3d'] : []),
            ];
            for (const item of mediaBuckets) {
              const filename = String(item?.filename || '').trim();
              if (!filename) continue;
              const subfolder = String(item?.subfolder || '');
              const type = String(item?.type || 'output');
              const qs = new URLSearchParams({ filename, subfolder, type });
              images.push({
                filename,
                subfolder,
                type,
                viewUrl: `${base}/view?${qs.toString()}`,
              });
            }
          }
          break;
        }
      }
    } catch (err: any) {
      if (err?.name === 'AbortError') throw err;
    }

    await new Promise((r) => setTimeout(r, pollIntervalMs));
  }

  return {
    promptId,
    images,
    workflow,
  };
}

/**
 * Pillar 3: Converts a ComfyUINode configuration into a HarnessMcpServerConfig
 * so autonomous coding/creative harnesses can invoke ComfyUI via MCP.
 */
export function toComfyMcpServerConfig(
  nodeId: string,
  endpoint: string,
  _config?: ComfyUIConfig
): HarnessMcpServerConfig {
  const safeName = sanitizeSafeIdentifier(nodeId, 'comfyui');
  return {
    name: safeName,
    endpoint: endpoint || 'http://127.0.0.1:8188',
    transport: 'http',
    tools: [...COMFYUI_MCP_TOOLS],
  };
}

/**
 * Generates the ComfyUI launch script, ArtCraft post-processing bridge, and
 * Pillar 4 reverse loopback configuration (`http://127.0.0.1:3588/v1`).
 */
export function generateComfyUISetupScript(
  nodeId: string,
  endpoint: string,
  config?: ComfyUIConfig
): string {
  const safeId = sanitizeSafeIdentifier(nodeId, 'comfyui-1');
  const cfg = config || {};
  let port = 8188;
  try {
    const u = new URL(endpoint || 'http://127.0.0.1:8188');
    if (u.port) port = sanitizePositiveInt(u.port, 8188, 1, 65535);
  } catch {}

  const vramMode = cfg.vramMode || 'normalvram';
  const validVramFlag =
    vramMode === 'highvram' ||
    vramMode === 'gpu-only' ||
    vramMode === 'lowvram' ||
    vramMode === 'novram' ||
    vramMode === 'cpu'
      ? `--${vramMode}`
      : '--normalvram';
  const reserveFlag =
    typeof cfg.reserveVramGb === 'number' && cfg.reserveVramGb > 0
      ? ` --reserve-vram ${Number(cfg.reserveVramGb)}`
      : '';
  const loopbackUrl = cfg.loopbackEluvixUrl || 'http://127.0.0.1:3588/v1';

  const lines: string[] = [
    '#!/usr/bin/env bash',
    '# ============================================================================',
    `# Eluvix — ComfyUI (${safeId}) Diffusion / Video / 3D Engine & Loopback Setup`,
    '# ============================================================================',
    'set -euo pipefail',
    '',
    `# 1. Start ComfyUI on :${port} with VRAM coordinator mode (${validVramFlag})`,
    `python3 main.py --listen 0.0.0.0 --port ${port} ${validVramFlag}${reserveFlag} --preview-method auto`,
    '',
    '# 2. Pillar 4: Reverse Loopback — Point ComfyUI LLM / VLM Custom Nodes at Eluvix',
    `export OPENAI_API_BASE=${escapeShellArg(loopbackUrl)}`,
    'export OPENAI_API_KEY="elx_local_comfyui_loopback"',
    '# Custom nodes (ComfyUI-LLM-Party, ComfyUI-OpenAI, JoyCaption) will route through',
    '# Eluvix Switchyard with x-eluvix-hops loop protection.',
  ];

  if (cfg.postProcessArtCraftApp) {
    const app = sanitizeSafeIdentifier(cfg.postProcessArtCraftApp, 'photocraft');
    lines.push(
      '',
      `# 3. Pillar 3: Post-Processing Handoff to ArtCraft Suite (${app}-cli)`,
      `# Rendered outputs from /view are automatically piped into ${app}-cli mcp.`
    );
  }

  return lines.join('\n');
}

const MAX_MEDIA_BYTES = 50 * 1024 * 1024; // 50 MiB ceiling for in-memory base64 / CLI post-process fetch

/**
 * Fetches a rendered ComfyUI `/view` artifact and encodes it as Base64 for
 * OpenAI-compatible `response_format: "b64_json"` clients.
 */
export async function fetchComfyMediaAsBase64(
  viewUrl: string,
  options?: { signal?: AbortSignal; maxBytes?: number }
): Promise<{ b64Json: string; contentType: string; byteLength: number }> {
  const viewCheck = validateUpstreamHttpEndpoint(viewUrl, { allowLoopbackAndLan: true });
  if (!viewCheck.ok) {
    throw new Error(`Blocked unsafe ComfyUI media URL: ${viewCheck.reason}`);
  }
  const maxBytes = options?.maxBytes ?? MAX_MEDIA_BYTES;
  const res = await fetch(viewUrl, {
    method: 'GET',
    signal: options?.signal,
  });
  if (!res.ok) {
    throw new Error(`ComfyUI /view fetch failed (${res.status}): ${res.statusText}`);
  }
  const contentType = res.headers.get('content-type') || 'image/png';
  const ab = await res.arrayBuffer();
  if (ab.byteLength > maxBytes) {
    throw new Error(`ComfyUI media artifact exceeds max size (${ab.byteLength} > ${maxBytes} bytes)`);
  }
  const buf = Buffer.from(ab);
  return {
    b64Json: buf.toString('base64'),
    contentType,
    byteLength: buf.byteLength,
  };
}

export interface ComfySystemStatus {
  online: boolean;
  comfyuiVersion?: string;
  pytorchVersion?: string;
  os?: string;
  queueRunning: number;
  queuePending: number;
  vramTotalGb?: number;
  vramFreeGb?: number;
  devices: Array<{
    name: string;
    type: string;
    vramTotalGb: number;
    vramFreeGb: number;
  }>;
  error?: string;
}

/**
 * Probes ComfyUI `GET /system_stats` and `GET /queue` to surface live GPU VRAM
 * and active diffusion queue depth in the Eluvix Visual Node Routing Editor.
 */
export async function probeComfyUISystemStatus(
  endpoint: string,
  timeoutMs = 4000
): Promise<ComfySystemStatus> {
  const endpointCheck = validateUpstreamHttpEndpoint(endpoint, { allowLoopbackAndLan: true });
  if (!endpointCheck.ok) {
    return {
      online: false,
      queueRunning: 0,
      queuePending: 0,
      devices: [],
      error: `Blocked unsafe ComfyUI endpoint: ${endpointCheck.reason}`,
    };
  }
  const base = endpoint.trim().replace(/\/+$/, '').replace(/\/v1$/, '');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const [statsRes, queueRes] = await Promise.all([
      fetch(`${base}/system_stats`, {
        method: 'GET',
        headers: { Accept: 'application/json' },
        signal: controller.signal,
      }),
      fetch(`${base}/queue`, {
        method: 'GET',
        headers: { Accept: 'application/json' },
        signal: controller.signal,
      }).catch(() => null),
    ]);

    if (!statsRes.ok) {
      return {
        online: false,
        queueRunning: 0,
        queuePending: 0,
        devices: [],
        error: `HTTP ${statsRes.status}`,
      };
    }

    const statsJson = (await statsRes.json()) as Record<string, any>;
    const sys = statsJson?.system || {};
    const rawDevices = Array.isArray(statsJson?.devices) ? statsJson.devices : [];
    const devices = rawDevices.map((d: any) => ({
      name: String(d?.name || 'GPU'),
      type: String(d?.type || 'cuda'),
      vramTotalGb: Number(((Number(d?.vram_total) || 0) / (1024 * 1024 * 1024)).toFixed(2)),
      vramFreeGb: Number(((Number(d?.vram_free) || 0) / (1024 * 1024 * 1024)).toFixed(2)),
    }));

    let queueRunning = 0;
    let queuePending = 0;
    if (queueRes && queueRes.ok) {
      try {
        const qJson = (await queueRes.json()) as Record<string, any>;
        if (Array.isArray(qJson?.queue_running)) queueRunning = qJson.queue_running.length;
        if (Array.isArray(qJson?.queue_pending)) queuePending = qJson.queue_pending.length;
      } catch {}
    }

    const totalVram = devices.reduce((acc: number, d: { vramTotalGb: number }) => acc + d.vramTotalGb, 0);
    const freeVram = devices.reduce((acc: number, d: { vramFreeGb: number }) => acc + d.vramFreeGb, 0);

    return {
      online: true,
      comfyuiVersion: sys.comfyui_version ? String(sys.comfyui_version) : undefined,
      pytorchVersion: sys.pytorch_version ? String(sys.pytorch_version) : undefined,
      os: sys.os ? String(sys.os) : undefined,
      queueRunning,
      queuePending,
      vramTotalGb: devices.length > 0 ? Number(totalVram.toFixed(2)) : undefined,
      vramFreeGb: devices.length > 0 ? Number(freeVram.toFixed(2)) : undefined,
      devices,
    };
  } catch (err: any) {
    return {
      online: false,
      queueRunning: 0,
      queuePending: 0,
      devices: [],
      error: err?.message || 'Unreachable',
    };
  } finally {
    clearTimeout(timer);
  }
}
