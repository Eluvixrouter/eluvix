import type { UpstreamConfig } from './index.js';
import { isDedicatedAudioUpstreamType } from './audio.js';

/**
 * Whether an endpoint points at a cloud instance metadata service (IMDS).
 */
export function isCloudMetadataEndpoint(endpoint: string): boolean {
  try {
    let host = new URL(endpoint).hostname.toLowerCase().replace(/^\[|\]$/g, '').trim();
    if (host.startsWith('::ffff:')) {
      const mapped = host.slice(7);
      const hexMatch = mapped.match(/^([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i);
      if (hexMatch) {
        const high = parseInt(hexMatch[1], 16);
        const low = parseInt(hexMatch[2], 16);
        host = `${(high >>> 8) & 255}.${high & 255}.${(low >>> 8) & 255}.${low & 255}`;
      } else {
        host = mapped;
      }
    }
    // Strip a trailing dot so "metadata.google.internal." matches too.
    host = host.replace(/\.$/, '');
    return (
      host.startsWith('169.254.') ||
      host === '169.254.169.254' ||
      host === 'fd00:ec2::254' ||
      host.startsWith('fe80:') ||
      host.startsWith('64:ff9b::') ||
      host === 'metadata.google.internal' ||
      host.endsWith('.metadata.google.internal')
    );
  } catch {
    return false;
  }
}

/**
 * Whether serving a prompt through this upstream keeps the prompt on the
 * user's own machine / LAN.
 */
export function isLocalUpstream(upstream: UpstreamConfig): boolean {
  if (!upstream) return false;
  if (isCloudMetadataEndpoint(upstream.endpoint || '')) return false;
  if (upstream.type === 'antigravity') return false;
  if (upstream.type === 'harness' && upstream.harness?.providerIsLocal !== undefined) {
    return upstream.harness.providerIsLocal;
  }
  const endpoint = (upstream.endpoint || '').trim().toLowerCase();
  if (
    upstream.harness?.embedded === true ||
    endpoint.startsWith('trueforge://') ||
    endpoint.startsWith('inprocess://') ||
    endpoint.startsWith('opencode://') ||
    endpoint.startsWith('opencode-eluvix://') ||
    endpoint.startsWith('aider://') ||
    endpoint.startsWith('swe-agent://') ||
    endpoint.startsWith('cline://') ||
    endpoint.startsWith('plandex://')
  ) {
    return true;
  }
  if (endpoint.startsWith('cli://')) return false;
  if (endpoint.startsWith('acp://')) {
    // An ACP endpoint is not local unless explicitly declared so. The old
    // default treated undeclared remote ACP endpoints as on-machine for
    // egress purposes (harness upstreams were fixed in T1; non-harness
    // upstreams kept the legacy local-unless-declared-otherwise default).
    return upstream.harness?.providerIsLocal === true;
  }
  let host: string;
  try {
    host = new URL(endpoint).hostname.toLowerCase().replace(/^\[|\]$/g, '').trim();
  } catch {
    return false;
  }
  if (host.startsWith('::ffff:')) {
    const mapped = host.slice(7);
    const hexMatch = mapped.match(/^([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i);
    if (hexMatch) {
      const high = parseInt(hexMatch[1], 16);
      const low = parseInt(hexMatch[2], 16);
      host = `${(high >>> 8) & 255}.${high & 255}.${(low >>> 8) & 255}.${low & 255}`;
    } else {
      host = mapped;
    }
  }
  if (host === 'localhost' || host === '127.0.0.1' || host === '::1' || host === '0.0.0.0') return true;
  if (/^10\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host)) return true;
  if (/^192\.168\.\d{1,3}\.\d{1,3}$/.test(host)) return true;
  if (/^172\.(1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3}$/.test(host)) return true;
  if (host.endsWith('.local') || host.endsWith('.lan') || host.endsWith('.internal')) return true;
  return false;
}

/**
 * Computes the effective USD cost per 1,000 tokens for an upstream.
 * Explicit `upstream.costPer1kTokens` always takes precedence; otherwise external
 * cloud APIs (`openai-compatible`, `billama`, `anthropic`) default to `$0.005/1K`
 * while local engines and subscription CLI agents default to `$0.00`.
 */
export function getEffectiveCostPer1kTokens(upstream: UpstreamConfig): number {
  if (typeof upstream.costPer1kTokens === 'number' && Number.isFinite(upstream.costPer1kTokens)) {
    return Math.max(0, upstream.costPer1kTokens);
  }
  if (
    !isLocalUpstream(upstream) &&
    (upstream.type === 'openai-compatible' || upstream.type === 'billama' || upstream.type === 'anthropic')
  ) {
    return 0.005;
  }
  return 0;
}

export interface CacheTokenUsage {
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
}

/**
 * Estimates total USD spend for a completed request on `upstream`, accounting
 * for prompt-cache read discounts (default `0.1x` on Anthropic/OpenAI) and
 * cache creation writes (default `1.25x` on Anthropic).
 */
export function estimateUpstreamRequestCostUsd(
  upstream: UpstreamConfig,
  promptTokens: number,
  completionTokens: number,
  cacheUsage?: CacheTokenUsage
): number {
  const rate = getEffectiveCostPer1kTokens(upstream);
  if (rate <= 0) return 0;

  const cacheRead = Math.max(0, cacheUsage?.cacheReadTokens || 0);
  const cacheWrite = Math.max(0, cacheUsage?.cacheWriteTokens || 0);
  const readMultiplier =
    typeof upstream.cacheReadMultiplier === 'number' && Number.isFinite(upstream.cacheReadMultiplier)
      ? Math.max(0, upstream.cacheReadMultiplier)
      : 0.1;
  const writeMultiplier =
    typeof upstream.cacheWriteMultiplier === 'number' && Number.isFinite(upstream.cacheWriteMultiplier)
      ? Math.max(0, upstream.cacheWriteMultiplier)
      : 1.25;

  const uncachedPrompt = Math.max(0, (promptTokens || 0) - cacheRead - cacheWrite);
  const effectiveTokens =
    uncachedPrompt +
    cacheRead * readMultiplier +
    cacheWrite * writeMultiplier +
    Math.max(0, completionTokens || 0);

  return Number(((effectiveTokens / 1000) * rate).toFixed(6));
}

/**
 * Whether an upstream can serve requests that contain images.
 */
export function isVisionCapableUpstream(upstream: UpstreamConfig): boolean {
  if (!upstream) return false;
  if (isDedicatedAudioUpstreamType(upstream.type)) return false;
  if (upstream.type === 'comfyui') {
    return Boolean(upstream.capabilities?.includes('vision-input'));
  }
  if (upstream.capabilities?.includes('vision')) return true;
  if (
    upstream.type === 'openai-compatible' ||
    upstream.type === 'anthropic' ||
    upstream.type === 'antigravity' ||
    upstream.type === 'billama'
  ) {
    return true;
  }
  return (
    Array.isArray(upstream.models) &&
    upstream.models.some((m) =>
      /gpt-4o|gpt-4-turbo|claude|gemini|llava|-vl\b|vision|omni|pixtral|gemma-?3|minicpm-v|internvl|molmo/i.test(m)
    )
  );
}
