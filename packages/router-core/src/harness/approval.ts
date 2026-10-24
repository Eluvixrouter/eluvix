import type { HarnessApprovalPolicy } from './types.js';

/**
 * Auto-approval decision for harness tool-permission requests.
 *
 * Security audit M-4: the previous implementation auto-approved any tool
 * whose *title* matched a read-only-looking name prefix (read|get|list|
 * fetch|…). The title is a self-descriptive label supplied by the very
 * agent/server being approved, and get/fetch/list-prefixed tools
 * routinely mutate — the classification trusted the label, not the
 * tool's effect.
 *
 * Auto-approval now requires an exact match against an explicit
 * per-harness allowlist (HarnessConfig.autoApproveTools). The default
 * allowlist is empty, so under 'auto-approve-readonly' (and TrueForge's
 * 'read-only') nothing is auto-approved by name: every permission
 * request is denied headlessly unless the operator has listed that
 * exact tool. Matching is exact and case-sensitive — tool names are
 * identifiers, and fuzzy matching is what caused the original finding.
 *
 * `identifiers` carries every name-like value the protocol supplied for
 * the tool (e.g. ACP toolCall name and title); the tool is approved if
 * any of them appears verbatim in the allowlist.
 */
export function isToolAutoApproved(
  policy: HarnessApprovalPolicy,
  identifiers: readonly string[],
  autoApproveTools?: readonly string[]
): boolean {
  if (policy !== 'auto-approve-readonly' && policy !== 'read-only') {
    return false;
  }
  if (!autoApproveTools || autoApproveTools.length === 0) {
    return false;
  }
  const allowed = new Set(autoApproveTools);
  return identifiers.some(id => typeof id === 'string' && id.length > 0 && allowed.has(id));
}
