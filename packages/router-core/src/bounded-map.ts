/**
 * Bounded Map insertion helper: sets `key` → `value`, refreshing the key's
 * recency, then evicts oldest entries (insertion order) until the map is at
 * most `maxEntries` in size. Used by the harness session caches and the
 * OpenViking turn counter so per-session state cannot grow without bound
 * for the lifetime of the process.
 */
export const DEFAULT_MAX_CACHE_ENTRIES = 256;

export function setBounded<K, V>(
  map: Map<K, V>,
  key: K,
  value: V,
  maxEntries: number = DEFAULT_MAX_CACHE_ENTRIES
): void {
  if (map.has(key)) {
    map.delete(key);
  }
  map.set(key, value);
  while (map.size > maxEntries) {
    const oldest = map.keys().next().value as K;
    map.delete(oldest);
  }
}
