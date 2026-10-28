export type HarnessKind =
  | 'hermes'
  | 'trueforge'
  | 'opencode'
  | 'aider'
  | 'swe-agent'
  | 'cline'
  | 'plandex'
  | 'acp'
  | 'openhands'
  | 'mastra'
  | 'letta'
  | 'a2a';

export type HarnessApprovalPolicy = 'auto-deny' | 'auto-approve-readonly' | 'read-only' | 'surface';

export type HarnessSessionMode = 'per-request' | 'per-eluvix-session' | 'per-conversation';

export interface HarnessMcpServerConfig {
  name: string;
  endpoint: string;
  transport?: 'stdio' | 'sse' | 'unix' | 'http';
  tools?: string[];
}

export interface HarnessMidLoopGuardConfig {
  enabled?: boolean;
  redactPii?: boolean;
  redactionStyle?: 'token' | 'asterisk' | 'hash';
  stripInjection?: boolean;
  blockOnInjection?: boolean;
}

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
  /**
   * Optional linked SandboxNode endpoint or runtime type for isolated code execution.
   */
  sandboxEndpoint?: string;
  sandboxType?: 'docker-local' | 'daytona' | 'e2b';
  /**
   * Run TrueForge or Eluvix-forked OpenCode directly in-process inside @eluvix/router-core
   * with zero HTTP hop overhead. Also inferred when endpoint uses `trueforge://`,
   * `inprocess://`, or `opencode-eluvix://`.
   */
  embedded?: boolean;
  /**
   * Enable Eluvix deep-fork harness extensions (client tool-calling bridge,
   * mid-loop PromptGuard/PrivacyGuard tool-observation scrubbing, per-turn Switchyard
   * model tiering, and deterministic KV-cache prefix hash pinning).
   */
  deepIntegration?: boolean;
  /**
   * Alias for `deepIntegration` when targeting the Eluvix-forked OpenCode runtime.
   */
  forked?: boolean;
  /**
   * Governed MCP servers injected directly into the harness session.
   */
  mcpServers?: HarnessMcpServerConfig[];
  /**
   * Mid-loop PromptGuard (indirect prompt injection) & PrivacyGuard (PII/secret DLP)
   * applied to every tool observation and harness output chunk before context re-ingestion.
   */
  midLoopGuard?: HarnessMidLoopGuardConfig;
  /**
   * Enable per-step Switchyard model tiering across multi-turn agent loops
   * (Tier-1 local for mechanical tool calls, Tier-4 frontier for synthesis).
   */
  switchyardTiering?: boolean;
  /**
   * Compute and attach deterministic KV-cache prefix hashes (`x-eluvix-prefix-hash`)
   * across multi-turn harness trajectories for DeepSeek MLA FP8 / Mooncake / NIXL reuse.
   */
  kvPrefixPinning?: boolean;
  /**
   * Dual-model Architect/Plan model override (used by Aider Architect+Editor and Cline Plan/Act).
   */
  architectModel?: string;
  /**
   * Dual-model Editor/Act model override (used by Aider Architect+Editor and Cline Plan/Act).
   */
  editorModel?: string;
  /**
   * Tree-sitter repository map token budget for Aider (`default: 1024`).
   */
  repoMapTokens?: number;
  /**
   * Code edit format for Aider / Cline (`diff` | `udiff` | `whole` | `architect`).
   */
  editFormat?: 'diff' | 'udiff' | 'whole' | 'architect';
  /**
   * Agent-Computer Interface profile for SWE-agent (`default` | `cve-patch` | `test-repair`).
   */
  aciProfile?: 'default' | 'cve-patch' | 'test-repair';
}
