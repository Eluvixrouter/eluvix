import type { RouterConfig, UpstreamConfig } from '@eluvix/router-core';

export interface UpstreamChange {
  id: string;
  name: string;
  /** Names of the fields that differ (values are never included — apiKey safe). */
  fields: string[];
}

export interface ConfigDiff {
  added: UpstreamConfig[];
  removed: UpstreamConfig[];
  changed: UpstreamChange[];
  egressPolicy?: { from?: string; to?: string };
  isEmpty: boolean;
}

const COMPARED_FIELDS: Array<keyof UpstreamConfig> = [
  'name',
  'type',
  'endpoint',
  'priority',
  'models',
  'costPer1kTokens',
  'maxComplexityScore',
  'tier',
  'capabilities',
  'apiKey'
];

function fieldDiffers(a: unknown, b: unknown): boolean {
  return JSON.stringify(a ?? null) !== JSON.stringify(b ?? null);
}

/**
 * Diff two router configs by upstream id: what an authoritative apply of
 * `next` would add, remove, and change relative to `current`. Used by the
 * routing editor to show the user exactly what an apply will do —
 * including the removals — before anything is written. A null `current`
 * (live config unavailable) reports every upstream as added.
 */
export function diffRouterConfigs(current: RouterConfig | null, next: RouterConfig): ConfigDiff {
  const currentById = new Map((current?.upstreams ?? []).map(u => [u.id, u]));
  const nextById = new Map((next.upstreams ?? []).map(u => [u.id, u]));

  const added: UpstreamConfig[] = [];
  const removed: UpstreamConfig[] = [];
  const changed: UpstreamChange[] = [];

  for (const upstream of next.upstreams ?? []) {
    const before = currentById.get(upstream.id);
    if (!before) {
      added.push(upstream);
      continue;
    }
    const fields = COMPARED_FIELDS.filter(f => fieldDiffers((before as any)[f], (upstream as any)[f]));
    if (fields.length > 0) {
      changed.push({ id: upstream.id, name: upstream.name, fields });
    }
  }
  for (const upstream of current?.upstreams ?? []) {
    if (!nextById.has(upstream.id)) {
      removed.push(upstream);
    }
  }

  const egressPolicy =
    (current?.egressPolicy ?? undefined) !== (next.egressPolicy ?? undefined)
      ? { from: current?.egressPolicy, to: next.egressPolicy }
      : undefined;

  return {
    added,
    removed,
    changed,
    egressPolicy,
    isEmpty: added.length === 0 && removed.length === 0 && changed.length === 0 && !egressPolicy
  };
}
