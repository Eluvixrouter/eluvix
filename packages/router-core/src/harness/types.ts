export type HarnessKind = 'hermes' | 'trueforge' | 'opencode' | 'acp';

export type HarnessApprovalPolicy = 'auto-deny' | 'auto-approve-readonly' | 'read-only' | 'surface';

export type HarnessSessionMode = 'per-request' | 'per-eluvix-session' | 'per-conversation';

export interface HarnessConfig {
  kind: HarnessKind;
  agentId?: string;
  command?: string | string[];
  args?: string[];
  cwd?: string;
  approvals?: HarnessApprovalPolicy;
  approvalPolicy?: HarnessApprovalPolicy;
  /**
   * Explicit allowlist of tool names eligible for auto-approval under the
   * 'auto-approve-readonly' / 'read-only' policies (security audit M-4).
   * Auto-approval is NEVER inferred from a tool's title or a read-only-
   * looking name pattern — titles are self-descriptive labels supplied by
   * the agent/server being approved. A permission request is auto-approved
   * only when the tool's name appears verbatim in this list.
   * Default: empty — nothing is auto-approved.
   */
  autoApproveTools?: string[];
  sessionMode?: HarnessSessionMode;
  /**
   * Whether the harness's underlying model provider is local to this machine/LAN.
   * Defaults to true when the harness points back at local Eluvix or local Ollama/vLLM.
   */
  providerIsLocal?: boolean;
}

