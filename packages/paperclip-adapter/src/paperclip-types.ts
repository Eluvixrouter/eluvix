export interface AdapterModel {
  id: string;
  label: string;
}

export interface ConfigFieldOption {
  label: string;
  value: string;
  group?: string;
}

export interface ConfigFieldSchema {
  key: string;
  label: string;
  type: 'text' | 'select' | 'toggle' | 'number' | 'textarea' | 'combobox';
  options?: ConfigFieldOption[];
  default?: unknown;
  hint?: string;
  required?: boolean;
  group?: string;
  meta?: Record<string, unknown>;
}

export interface AdapterConfigSchema {
  fields: ConfigFieldSchema[];
}

export interface AdapterUsageCheckpoint {
  inputTokens?: number;
  outputTokens?: number;
  cachedInputTokens?: number;
  cacheWriteTokens?: number;
  costUsd?: number;
  model?: string;
}

export interface AdapterExecutionContext {
  runId: string;
  agent: {
    id: string;
    companyId: string;
    name: string;
    adapterType?: string | null;
    adapterConfig?: Record<string, unknown>;
  };
  runtime?: {
    sessionId?: string | null;
    sessionParams?: Record<string, unknown> | null;
    sessionDisplayId?: string | null;
    taskKey?: string | null;
  };
  config: Record<string, unknown>;
  context: Record<string, unknown>;
  authToken?: string;
  runtimeMcp?: {
    url?: string;
    token?: string;
  };
  signal?: AbortSignal;
  onLog: (stream: 'stdout' | 'stderr', chunk: string) => void | Promise<void>;
  onMeta?: (meta: Record<string, unknown>) => void | Promise<void>;
  onEvent?: (event: Record<string, unknown>) => void | Promise<void>;
  onUsage?: (checkpoint: AdapterUsageCheckpoint) => void | Promise<void>;
}

export type AdapterExecutionErrorFamily =
  | 'transient_upstream'
  | 'provider_quota'
  | 'model_refusal'
  | 'auth_required'
  | 'invalid_request';

export interface AdapterExecutionResult {
  exitCode: number | null;
  signal: string | null;
  timedOut: boolean;
  errorMessage?: string | null;
  errorFamily?: AdapterExecutionErrorFamily | null;
  retryNotBefore?: string | null;
  usage?: {
    inputTokens: number;
    outputTokens: number;
    cachedInputTokens?: number;
    cacheWriteTokens?: number;
  };
  usageByModel?: Array<{
    model: string;
    provider?: string;
    inputTokens: number;
    outputTokens: number;
    cachedInputTokens?: number;
    cacheWriteTokens?: number;
    costUsd?: number;
  }>;
  usageBasis?: 'per_run' | 'session_cumulative';
  sessionParams?: Record<string, unknown> | null;
  sessionDisplayId?: string | null;
  provider?: string;
  biller?: string;
  model?: string;
  billingType?: 'api' | 'subscription' | 'metered_api' | 'credits' | 'fixed';
  costUsd?: number;
  costStatus?: 'reported' | 'estimated' | 'unpriced';
  pricingProvenance?: {
    source: 'provider_reported' | 'operator' | 'rate_card';
  };
  summary?: string;
  resultJson?: Record<string, unknown> | null;
}

export interface AdapterEnvironmentCheck {
  code: string;
  level: 'info' | 'warn' | 'error';
  message: string;
  hint?: string;
}

export interface AdapterEnvironmentTestResult {
  adapterType: string;
  status: 'pass' | 'warn' | 'fail';
  checks: AdapterEnvironmentCheck[];
  testedAt: string;
}

export interface AdapterSessionCodec {
  deserialize(raw: unknown): Record<string, unknown> | null;
  serialize(params: Record<string, unknown> | null): Record<string, unknown> | null;
  getDisplayId?(params: Record<string, unknown> | null): string | null;
}

export interface ServerAdapterModule {
  type: string;
  execute(ctx: AdapterExecutionContext): Promise<AdapterExecutionResult>;
  testEnvironment(ctx: {
    companyId: string;
    adapterType: string;
    config: Record<string, unknown>;
  }): Promise<AdapterEnvironmentTestResult>;
  sessionCodec?: AdapterSessionCodec;
  supportsLocalAgentJwt?: boolean;
  runtimeToolDelivery?: 'native_mcp' | 'environment' | 'invocation_context';
  models?: AdapterModel[];
  listModels?: (ctx?: { config?: Record<string, unknown> }) => Promise<AdapterModel[]>;
  getQuotaWindows?: (ctx?: { config?: Record<string, unknown> }) => Promise<{
    ok: boolean;
    error?: string;
    windows: Array<{
      id: string;
      label: string;
      used: number;
      limit: number;
      unit: string;
    }>;
  }>;
  getConfigSchema?: () => AdapterConfigSchema;
  agentConfigurationDoc?: string;
}
