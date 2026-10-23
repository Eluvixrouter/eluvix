import type { ChatMessage, UpstreamConfig } from './index.js';
import {
  discoverAntigravityModels,
  getCachedAntigravityModels,
} from './antigravity-models.js';
import {
  tryResolveCliExecutable,
  ANTIGRAVITY_CLI_BINARIES,
} from './cli-exec.js';
import { parseComfyModelsResponse } from './comfyui.js';
import { fetchWithSafeRedirects, assertEndpointNotMetadata } from './fetch-policy.js';

export interface DiscoveredModel {
  id: string;
  name?: string;
  size?: number | string;
  recipe?: string;
  ownedBy?: string;
  labels?: string[];
  contextLength?: number;
}

export interface UpstreamDiscoveryResult {
  models: string[];
  details: DiscoveredModel[];
}

export async function detectUpstreamModelDetails(
  upstream: UpstreamConfig,
  timeoutMs = 5000
): Promise<UpstreamDiscoveryResult> {
  if (upstream.type === 'antigravity' || upstream.endpoint.startsWith('cli://')) {
    const cliPath = tryResolveCliExecutable(upstream.antigravity?.cliPath || 'agy', {
      allowedBasenames: ANTIGRAVITY_CLI_BINARIES,
    });
    const discovered = cliPath
      ? await discoverAntigravityModels(cliPath)
      : {
          models: getCachedAntigravityModels(),
          cachedAt: new Date().toISOString(),
          source: 'default' as const,
        };
    const models = [...discovered.models.map((m) => m.baseId), '*'];
    const details: DiscoveredModel[] = discovered.models.map((m) => ({
      id: m.baseId,
      name: m.displayName,
      recipe: 'antigravity-cli',
      ownedBy: 'antigravity',
      labels: [m.tier, ...m.efforts.map((e) => `effort:${e}`)],
      contextLength: m.contextLimit,
    }));
    return { models, details };
  }

  // S-2: refuse to probe cloud-metadata / link-local targets from the
  // router-core side too. The Next.js detect-models route runs its own
  // check, but desktop and other consumers call this function directly.
  // (TOCTOU residual: the check resolves the host, then fetch resolves
  // it again at connect time; fully closing the race needs a dispatcher
  // that pins the validated address — out of scope, accepted.)
  if (/^https?:\/\//i.test(upstream.endpoint)) {
    await assertEndpointNotMetadata(upstream.endpoint);
  }

  if (upstream.type === 'harness' || upstream.endpoint.startsWith('acp://')) {
    const kind =
      upstream.harness?.kind || (upstream.endpoint.startsWith('acp://') ? 'acp' : 'trueforge');
    if (kind === 'trueforge' && /^https?:\/\//i.test(upstream.endpoint)) {
      const base = upstream.endpoint.trim().replace(/\/+$/, '').replace(/\/v1$/, '');
      try {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), timeoutMs);
        const res = await fetchWithSafeRedirects(`${base}/v1/models`, {
          method: 'GET',
          headers: { Accept: 'application/json' },
          signal: controller.signal,
        });
        clearTimeout(timer);
        if (res.ok) {
          const data = await res.json();
          const parsed = parseModelDetails(data);
          if (parsed.models.length > 0) {
            return parsed;
          }
        }
      } catch {
        // Fall through to static harness models when container is offline
      }
    }
    if (kind) {
      const configured =
        Array.isArray(upstream.models) && upstream.models.length > 0
          ? upstream.models
          : [`harness/${kind}`, `${kind}/default`];
      const details: DiscoveredModel[] = configured
        .filter((m) => m !== '*')
        .map((id) => ({
          id,
          name: id,
          recipe: `harness:${kind}`,
          ownedBy: kind,
        }));
      return { models: configured, details };
    }
  }

  const trimmed = upstream.endpoint.trim().replace(/\/+$/, '');
  const candidateUrls: string[] = [];
  const baseWithoutV1 = trimmed.replace(/\/v1$/, '');

  if (upstream.type === 'comfyui') {
    const comfyUrls = [
      `${baseWithoutV1}/models/checkpoints`,
      `${baseWithoutV1}/models/diffusion_models`,
      `${baseWithoutV1}/models/unet`,
      `${baseWithoutV1}/object_info/CheckpointLoaderSimple`,
    ];
    const aggregatedModels = new Set<string>();
    const aggregatedDetails: DiscoveredModel[] = [];
    for (const url of comfyUrls) {
      try {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), timeoutMs);
        const res = await fetchWithSafeRedirects(url, {
          method: 'GET',
          headers: { Accept: 'application/json' },
          signal: controller.signal,
        });
        clearTimeout(timer);
        if (!res.ok) continue;
        const data = await res.json();
        const folder = url.includes('diffusion_models')
          ? 'diffusion_models'
          : url.includes('unet')
          ? 'unet'
          : 'checkpoints';
        const parsed = parseComfyModelsResponse(data, folder);
        for (const m of parsed.models) {
          if (!aggregatedModels.has(m)) {
            aggregatedModels.add(m);
            aggregatedDetails.push({
              id: m,
              name: m,
              ownedBy: 'comfyui',
              recipe: folder === 'checkpoints' ? 'comfyui:checkpoint' : `comfyui:${folder}`,
            });
          }
        }
      } catch {
        // Continue probing remaining ComfyUI endpoints
      }
    }
    if (aggregatedModels.size > 0) {
      return { models: Array.from(aggregatedModels), details: aggregatedDetails };
    }
  }

  if (upstream.type === 'ollama') {
    candidateUrls.push(
      `${baseWithoutV1}/v1/models`,
      `${baseWithoutV1}/api/tags`,
      `${baseWithoutV1}/models`
    );
  } else if (upstream.type === 'lemonade' || upstream.type === 'ramalama') {
    candidateUrls.push(
      `${baseWithoutV1}/v1/models`,
      `${baseWithoutV1}/models`,
      `${baseWithoutV1}/api/models`,
      `${baseWithoutV1}/api/tags`
    );
  } else if (trimmed.endsWith('/v1')) {
    candidateUrls.push(
      `${trimmed}/models`,
      `${baseWithoutV1}/models`,
      `${baseWithoutV1}/api/tags`
    );
  } else {
    candidateUrls.push(
      `${trimmed}/v1/models`,
      `${trimmed}/models`,
      `${trimmed}/api/tags`,
      `${trimmed}/api/models`
    );
  }

  const headers: Record<string, string> = {
    Accept: 'application/json',
  };
  if (upstream.apiKey) {
    headers['Authorization'] = `Bearer ${upstream.apiKey}`;
    if (upstream.type === 'anthropic' || upstream.endpoint.includes('anthropic.com')) {
      headers['x-api-key'] = upstream.apiKey;
      headers['anthropic-version'] = '2023-06-01';
    }
  }

  for (const url of candidateUrls) {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);

      const res = await fetchWithSafeRedirects(url, {
        method: 'GET',
        headers,
        signal: controller.signal,
      });
      clearTimeout(timer);

      if (!res.ok) continue;

      const data = await res.json();
      const result = parseModelDetails(data);
      if (result.models.length > 0) {
        return result;
      }
    } catch {
      // Continue to next candidate endpoint
    }
  }

  return { models: [], details: [] };
}

export async function detectUpstreamModels(
  upstream: UpstreamConfig,
  timeoutMs = 5000
): Promise<string[]> {
  const result = await detectUpstreamModelDetails(upstream, timeoutMs);
  return result.models;
}

export function parseModelDetails(data: any): UpstreamDiscoveryResult {
  if (!data || typeof data !== 'object') return { models: [], details: [] };

  const details: DiscoveredModel[] = [];
  const modelSet = new Set<string>();

  if (Array.isArray(data.data)) {
    data.data.forEach((item: any) => {
      const id = typeof item === 'string' ? item : item?.id || item?.name || item?.model;
      if (typeof id === 'string' && id.length > 0 && !modelSet.has(id)) {
        modelSet.add(id);
        details.push({
          id,
          name: item?.name || id,
          size: typeof item?.size === 'number' ? `${item.size} GB` : item?.size,
          recipe: item?.recipe,
          ownedBy: item?.owned_by,
          labels: Array.isArray(item?.labels) ? item.labels : undefined,
          contextLength: item?.context_length || item?.max_context_window,
        });
      }
    });
  }

  if (Array.isArray(data.models)) {
    data.models.forEach((item: any) => {
      const id = typeof item === 'string' ? item : item?.name || item?.id || item?.model;
      if (typeof id === 'string' && id.length > 0 && !modelSet.has(id)) {
        modelSet.add(id);
        const labels: string[] = [];
        if (item?.details?.parameter_size) labels.push(item.details.parameter_size);
        if (item?.details?.quantization_level) labels.push(item.details.quantization_level);
        if (item?.details?.family) labels.push(item.details.family);

        details.push({
          id,
          name: id,
          size:
            typeof item?.size === 'number'
              ? `${(item.size / (1024 * 1024 * 1024)).toFixed(1)} GB`
              : undefined,
          recipe: 'ollama',
          labels: labels.length > 0 ? labels : undefined,
        });
      }
    });
  }

  for (const key of ['available_models', 'items', 'routes', 'nodes']) {
    if (Array.isArray(data[key])) {
      data[key].forEach((item: any) => {
        const id = typeof item === 'string' ? item : item?.id || item?.name || item?.model;
        if (typeof id === 'string' && id.length > 0 && !modelSet.has(id)) {
          modelSet.add(id);
          details.push({ id, name: id });
        }
      });
    }
  }

  if (Array.isArray(data)) {
    data.forEach((item: any) => {
      const id = typeof item === 'string' ? item : item?.id || item?.name || item?.model;
      if (typeof id === 'string' && id.length > 0 && !modelSet.has(id)) {
        modelSet.add(id);
        details.push({ id, name: id });
      }
    });
  }

  return {
    models: Array.from(modelSet),
    details,
  };
}

export function isAntigravitySupportedModel(
  modelName: string,
  upstreamModels: string[] = []
): boolean {
  if (!modelName || modelName === 'auto') return false;
  if (upstreamModels.includes(modelName)) return true;

  // Reject explicitly retired Google Gemini models (3.1, 3.6, 3.7, 2.5).
  // The (?![0-9]) guard keeps a future gemini-3.10 from colliding with the
  // 3.1 prefix, while gemini-3.1-pro etc. still match.
  if (/^gemini-(?:3\.1|3\.6|3\.7|2\.5)(?![0-9])/i.test(modelName)) return false;

  const catalog = getCachedAntigravityModels();
  const lower = modelName.toLowerCase();
  for (const entry of catalog) {
    if (entry.baseId.toLowerCase() === lower) return true;
    if (entry.variants.some((v) => v.toLowerCase() === lower)) return true;
  }

  if (/^gemini-(?:4-carbon|4-argon|4-argo|3\.8)/i.test(modelName)) return true;
  if (/^claude-(?:opus|sonnet)/i.test(modelName)) return true;
  if (/^gpt-oss-120b/i.test(modelName)) return true;
  return false;
}

export function buildCliPrompt(messages: ChatMessage[], maxBytes = 100000): string {
  if (!messages || messages.length === 0) return 'Hello';

  const systemParts: string[] = [];
  const conversationTurns: { role: string; text: string }[] = [];

  for (const m of messages) {
    const text = typeof m.content === 'string' ? m.content : JSON.stringify(m.content);
    if (m.role && m.role.toLowerCase() === 'system') {
      systemParts.push(`[SYSTEM]: ${text}`);
    } else {
      conversationTurns.push({ role: (m.role || 'user').toUpperCase(), text });
    }
  }

  const systemBlock = systemParts.join('\n\n');
  const systemBytes = Buffer.byteLength(systemBlock, 'utf8');

  if (systemBytes >= maxBytes - 1000) {
    const buf = Buffer.from(systemBlock, 'utf8');
    return buf.subarray(0, maxBytes - 100).toString('utf8') + '\n\n[System truncated]';
  }

  const remainingBudget = maxBytes - (systemBytes > 0 ? systemBytes + 2 : 0);
  const includedTurns: string[] = [];
  let currentBytes = 0;
  let omittedTurns = false;

  for (let i = conversationTurns.length - 1; i >= 0; i--) {
    const turn = `[${conversationTurns[i].role}]: ${conversationTurns[i].text}`;
    const turnBytes = Buffer.byteLength(turn, 'utf8') + 2;
    if (currentBytes + turnBytes <= remainingBudget) {
      includedTurns.unshift(turn);
      currentBytes += turnBytes;
    } else if (i === conversationTurns.length - 1 && includedTurns.length === 0) {
      const prefix = `[${conversationTurns[i].role}]: `;
      const truncNote = '\n[Eluvix Note: Latest message truncated to stay within argument limit]';
      const omitReserve =
        i > 0
          ? Buffer.byteLength(
              '[Eluvix Note: Prior conversation history omitted to stay within argument limit]',
              'utf8'
            ) + 2
          : 0;
      const avail =
        remainingBudget -
        2 -
        Buffer.byteLength(prefix, 'utf8') -
        Buffer.byteLength(truncNote, 'utf8') -
        omitReserve -
        4;
      if (avail > 0) {
        const textBuf = Buffer.from(conversationTurns[i].text, 'utf8');
        const truncated = prefix + textBuf.subarray(0, avail).toString('utf8') + truncNote;
        includedTurns.unshift(truncated);
        currentBytes += Buffer.byteLength(truncated, 'utf8') + 2;
        if (i > 0) omittedTurns = true;
      } else {
        omittedTurns = true;
      }
      break;
    } else {
      omittedTurns = true;
      break;
    }
  }

  const parts: string[] = [];
  if (systemBlock) {
    parts.push(systemBlock);
  }
  if (omittedTurns) {
    parts.push('[Eluvix Note: Prior conversation history omitted to stay within argument limit]');
  }
  if (includedTurns.length > 0) {
    parts.push(includedTurns.join('\n\n'));
  }

  return parts.join('\n\n');
}
