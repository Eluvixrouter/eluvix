import type {
  AdapterConfigSchema,
  AdapterSessionCodec,
  ServerAdapterModule,
} from '../paperclip-types.js';
import { executeEluvixLocal } from './execute.js';
import { testEluvixEnvironment } from './test-env.js';
import {
  STATIC_ELUVIX_MODELS,
  listEluvixModels,
  getEluvixQuotaWindows,
} from './models.js';

export const type = 'eluvix_local';
export const label = 'Eluvix Switchyard (OpenCode Harness)';

export const sessionCodec: AdapterSessionCodec = {
  deserialize(raw) {
    if (!raw || typeof raw !== 'object') return null;
    const sid = (raw as Record<string, unknown>).sessionId;
    return typeof sid === 'string' && sid ? { sessionId: sid } : null;
  },
  serialize(params) {
    if (!params || typeof params.sessionId !== 'string' || !params.sessionId) return null;
    return { sessionId: params.sessionId };
  },
  getDisplayId(params) {
    return typeof params?.sessionId === 'string' ? params.sessionId : null;
  },
};

export function getConfigSchema(): AdapterConfigSchema {
  return {
    fields: [
      {
        key: 'eluvixBaseUrl',
        label: 'Eluvix Gateway URL',
        type: 'text',
        default: 'http://127.0.0.1:3588',
        hint: 'Loopback URL of your local Eluvix gateway.',
        required: true,
        group: 'Connection',
      },
      {
        key: 'eluvixApiKey',
        label: 'Eluvix API Key (or env:ELUVIX_API_KEY)',
        type: 'text',
        default: 'env:ELUVIX_API_KEY',
        hint: 'Use a Paperclip envBinding secret ELUVIX_API_KEY or an elx_ key with chat,paperclip scopes.',
        group: 'Connection',
      },
      {
        key: 'model',
        label: 'Model / Switchyard Tier',
        type: 'combobox',
        default: 'eluvix/auto',
        options: STATIC_ELUVIX_MODELS.map((m) => ({ label: m.label, value: m.id })),
        hint: 'Use eluvix/auto to let Switchyard route per turn.',
        group: 'Routing',
      },
      {
        key: 'egressPolicy',
        label: 'Egress Policy Override',
        type: 'select',
        default: 'inherit',
        options: [
          { label: 'Inherit Eluvix Policy', value: 'inherit' },
          { label: 'Local Only ($0 Sovereign)', value: 'local-only' },
          { label: 'Cloud Allowed', value: 'allow-egress' },
        ],
        group: 'Routing',
      },
      {
        key: 'stepTiering',
        label: 'Per-Step Switchyard Tiering',
        type: 'toggle',
        default: true,
        group: 'Harness',
      },
      {
        key: 'approvalPolicy',
        label: 'Tool Approval Policy',
        type: 'select',
        default: 'auto-approve-readonly',
        options: [
          { label: 'Auto-Approve Read-Only', value: 'auto-approve-readonly' },
          { label: 'Strict Allowlist', value: 'allowlist' },
          { label: 'Deny All Tools', value: 'deny-all' },
        ],
        group: 'Harness',
      },
      {
        key: 'autoApproveTools',
        label: 'Auto-Approve Tool Allowlist',
        type: 'textarea',
        default: 'read_file\ngrep_search\nlist_dir\ninspect_repo',
        hint: 'One tool name per line.',
        group: 'Harness',
      },
      {
        key: 'opencodeBinary',
        label: 'OpenCode Binary',
        type: 'text',
        default: 'opencode',
        group: 'Runtime',
      },
      {
        key: 'timeoutSec',
        label: 'Timeout (seconds)',
        type: 'number',
        default: 1800,
        group: 'Runtime',
      },
    ],
  };
}

export const agentConfigurationDoc = `# Eluvix Local Adapter (\`eluvix_local\`)

Runs the Eluvix OpenCode harness inside Paperclip's execution workspace while routing all LLM turns through local Eluvix Switchyard (\`http://127.0.0.1:3588\`).

- **Recommended model**: \`eluvix/auto\`
- **Secret binding**: bind \`ELUVIX_API_KEY\` in Paperclip's Environment / Secrets section with an \`elx_\` key scoped to \`chat,paperclip\`.
- **Cost attribution**: automatically reports per-run USD cost and token breakdown from Eluvix \`request_logs\`.
`;

export function createServerAdapter(): ServerAdapterModule {
  return {
    type,
    execute: (ctx) => executeEluvixLocal(ctx),
    testEnvironment: (ctx) => testEluvixEnvironment(ctx),
    sessionCodec,
    supportsLocalAgentJwt: true,
    runtimeToolDelivery: 'native_mcp',
    models: STATIC_ELUVIX_MODELS,
    listModels: (ctx) => listEluvixModels(ctx),
    getQuotaWindows: (ctx) => getEluvixQuotaWindows(ctx),
    getConfigSchema,
    agentConfigurationDoc,
  };
}

export { executeEluvixLocal, testEluvixEnvironment, listEluvixModels, getEluvixQuotaWindows, STATIC_ELUVIX_MODELS };
export * from './headers.js';
export * from './errors.js';
export * from './usage.js';
