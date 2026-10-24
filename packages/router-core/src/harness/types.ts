export type HarnessKind =
  | 'hermes'
  | 'trueforge'
  | 'opencode'
  | 'acp'
  | 'openhands'
  | 'mastra'
  | 'letta'
  | 'a2a';

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
  sessionMode?: HarnessSessionMode;
  /**
   * Whether the harness's underlying model provider is local to this machine/LAN.
   * Defaults to true when the harness points back at local Eluvix or local Ollama/vLLM.
   */
  providerIsLocal?: boolean;
  /**
   * Optional linked SandboxNode endpoint or runtime type for isolated code execution.
   */
  sandboxEndpoint?: string;
  sandboxType?: 'docker-local' | 'daytona' | 'e2b';
}
