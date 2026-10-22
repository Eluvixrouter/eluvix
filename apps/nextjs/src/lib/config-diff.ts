import type { MemoryConfig, RouterConfig, UpstreamConfig } from '@eluvix/router-core';

export interface UpstreamChange {
  id: string;
  name: string;
  /** Names of the fields that differ (values are never included — apiKey safe). */
  fields: string[];
}

export interface MemoryChange {
  kind: 'added' | 'removed' | 'changed';
  /** Names of the fields that differ (values are never included — apiKey safe). */
  fields: string[];
}

export interface ConfigDiff {
  added: UpstreamConfig[];
  removed: UpstreamConfig[];
  changed: UpstreamChange[];
  egressPolicy?: { from?: string; to?: string };
  memory?: MemoryChange;
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

const MEMORY_FIELDS: Array<keyof MemoryConfig> = [
  'enabled',
  'provider',
  'endpoint',
  'apiKey',
  'recallBudgetTokens',
  'recallTimeoutMs',
  'writeBack',
  'autoCommitTurns',
  'allowCloudEgress',
  'cloudMode',
  'openviking'
];

/**
 * Diff the top-level memory section. It is a single settings block rather
 * than a list, so it reports as added / removed / changed with the field
 * NAMES that differ — including allowCloudEgress, whose flip changes
 * whether recalled memories may leave the machine and must never be
 * invisible in the apply confirmation (bug hunt finding 4).
 */
function diffMemory(
  current: MemoryConfig | undefined,
  next: MemoryConfig | undefined
): MemoryChange | undefined {
  if (!current && !next) return undefined;
  if (!current && next) {
    return { kind: 'added', fields: MEMORY_FIELDS.filter(f => next[f] !== undefined) };
  }
  if (current && !next) {
    return { kind: 'removed', fields: MEMORY_FIELDS.filter(f => current[f] !== undefined) };
  }
  const fields = MEMORY_FIELDS.filter(f => fieldDiffers(current![f], next![f]));
  return fields.length > 0 ? { kind: 'changed', fields } : undefined;
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

  const memory = diffMemory(current?.memory, next.memory);

  return {
    added,
    removed,
    changed,
    egressPolicy,
    memory,
    isEmpty:
      added.length === 0 &&
      removed.length === 0 &&
      changed.length === 0 &&
      !egressPolicy &&
      !memory
  };
}
