import type { AdapterModel } from '../paperclip-types.js';
import { resolveEluvixApiKey, validateLoopbackEluvixUrl } from './headers.js';

export const STATIC_ELUVIX_MODELS: AdapterModel[] = [
  { id: 'eluvix/auto', label: 'Eluvix Auto (Switchyard)' },
  { id: 'eluvix/fast-local', label: 'Eluvix Fast Local (Tier 1)' },
  { id: 'eluvix/code-specialist', label: 'Eluvix Code Specialist (Tier 2)' },
  { id: 'eluvix/heavy-reasoning', label: 'Eluvix Heavy Reasoning (Tier 3)' },
  { id: 'eluvix/frontier-verified', label: 'Eluvix Frontier Verified (Tier 4)' },
];

export async function listEluvixModels(
  ctx?: { config?: Record<string, unknown> },
  deps?: { fetch?: typeof globalThis.fetch }
): Promise<AdapterModel[]> {
  const fetchFn = deps?.fetch || globalThis.fetch;
  const rawBaseUrl = String(ctx?.config?.eluvixBaseUrl || 'http://127.0.0.1:3588');
  const urlCheck = validateLoopbackEluvixUrl(rawBaseUrl);
  if (!urlCheck.ok || !fetchFn) return STATIC_ELUVIX_MODELS;

  const apiKey = ctx?.config ? resolveEluvixApiKey(ctx.config) : '';
  try {
    const res = await fetchFn(`${urlCheck.url}/api/v1/paperclip/capabilities`, {
      headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : {},
    });
    if (!res.ok) return STATIC_ELUVIX_MODELS;
    const json: any = await res.json();
    const out: AdapterModel[] = [...STATIC_ELUVIX_MODELS];
    const seen = new Set(out.map((m) => m.id));
    for (const u of json.upstreams || []) {
      const tag = u.isLocal ? 'local' : `$${Number(u.costPer1kTokens || 0).toFixed(4)}/1k`;
      for (const m of u.models || []) {
        if (m && m !== '*' && !seen.has(m)) {
          seen.add(m);
          out.push({ id: m, label: `${m} (${u.name}, ${tag})` });
        }
      }
    }
    return out;
  } catch {
    return STATIC_ELUVIX_MODELS;
  }
}

export async function getEluvixQuotaWindows(
  ctx?: { config?: Record<string, unknown> },
  deps?: { fetch?: typeof globalThis.fetch }
) {
  const fetchFn = deps?.fetch || globalThis.fetch;
  const rawBaseUrl = String(ctx?.config?.eluvixBaseUrl || 'http://127.0.0.1:3588');
  const urlCheck = validateLoopbackEluvixUrl(rawBaseUrl);
  if (!urlCheck.ok || !fetchFn) {
    return { ok: false, error: 'Invalid Eluvix URL', windows: [] };
  }
  const apiKey = ctx?.config ? resolveEluvixApiKey(ctx.config) : '';
  try {
    const res = await fetchFn(`${urlCheck.url}/api/v1/paperclip/whoami`, {
      headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : {},
    });
    if (!res.ok) {
      return { ok: false, error: `HTTP ${res.status}`, windows: [] };
    }
    const json: any = await res.json();
    const windows = [];
    if (typeof json.maxDailySpendUsd === 'number' && json.maxDailySpendUsd > 0) {
      windows.push({
        id: 'daily_spend_usd',
        label: 'Eluvix 24h Spend',
        used: Number(json.rolling24hSpendUsd || 0),
        limit: json.maxDailySpendUsd,
        unit: 'USD',
      });
    }
    return { ok: true, windows };
  } catch (err: any) {
    return { ok: false, error: err?.message || 'Failed to query Eluvix', windows: [] };
  }
}
