/**
 * Sampling-parameter bounds (hunt-3 L-A6).
 *
 * `temperature` and `max_tokens` used to flow from the caller straight to
 * the upstream with no numeric bounds — a huge `max_tokens` could inflate
 * cost if an upstream honors it, and an out-of-range temperature is
 * meaningless. Bounds (clamped, never rejected, matching the clamps used
 * elsewhere in the router for `top_k`/`window_hours`):
 *
 * - temperature: 0–2 (the OpenAI-compatible range; the MCP tool schema
 *   already documents 0.0–2.0).
 * - max_tokens / max_completion_tokens: 1–131072.
 *
 * Non-finite values are dropped (treated as unset) rather than clamped
 * to an arbitrary default. This module has zero `node:*` imports.
 */

export const SAMPLING_TEMPERATURE_MIN = 0;
export const SAMPLING_TEMPERATURE_MAX = 2;
export const SAMPLING_MAX_TOKENS_MIN = 1;
export const SAMPLING_MAX_TOKENS_MAX = 131072;

export function clampTemperature(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value)) return undefined;
  return Math.min(SAMPLING_TEMPERATURE_MAX, Math.max(SAMPLING_TEMPERATURE_MIN, value));
}

export function clampMaxTokens(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value)) return undefined;
  return Math.min(
    SAMPLING_MAX_TOKENS_MAX,
    Math.max(SAMPLING_MAX_TOKENS_MIN, Math.floor(value))
  );
}
