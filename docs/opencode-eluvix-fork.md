# Eluvix-Forked OpenCode (`@eluvix/opencode-harness`) & TrueForge Deep Integration

This document covers the architecture, configuration, HTTP protocol extensions, security guardrails, and deployment modes for the **Eluvix-Forked OpenCode** runtime (`@eluvix/opencode-harness` / `eluvix-opencode`) and **TrueForge** deep integration inside `@eluvix/router-core`.

---

## 1. Why OpenCode Was Forked for Deep Integration

Stock upstream `opencode serve` has several architectural limitations when placed behind an enterprise AI router:

| Capability | Stock OpenCode (`forked: false`) | Eluvix-Forked OpenCode (`forked: true` / `deepIntegration: true`) |
| :--- | :--- | :--- |
| **Client Tool Calling (`request.tools`)** | **Rejected** (`opencode harness does not support tool calling`) because stock `/session/:id/message` drops OpenAI `tools` definitions. | **Supported**: Forwards `request.tools`, executes or delegates approved tools, and returns OpenAI-compatible `choices[0].message.tool_calls`. |
| **Governed MCP Mesh (`mcpServers`)** | Configured statically on disk per developer machine. | **Injected per session** via `POST /session` and `POST /session/:id/message` (e.g., `axonwall-mcp` over `unix:///var/run/axonwalld.sock`). |
| **Headless Permission Gates** | Blocks indefinitely waiting for interactive TUI confirmation on tool use. | **Automated `/session/:id/permission/:permId/reply`** governed by `approvalPolicy` and exact-match `autoApproveTools`. |
| **Mid-Loop Tool Observation DLP & PromptGuard** | Tool outputs (`bash`, `read_file`, `grep`, `web_fetch`) go straight back into the LLM context uninspected. | **`inspectHarnessObservation`** scrubs leaked secrets/PII (`PrivacyGuard`) and strips or blocks indirect prompt injections (`PromptGuard`) on every `tool` part **before** context re-ingestion. |
| **Per-Step Switchyard Model Tiering** | Uses one static model for the entire session. | **`selectSwitchyardStepTier`** dynamically routes Tier-1 (`fast-local`) for mechanical tool selection, Tier-2 (`code-specialist`) for edits, Tier-3 (`heavy-reasoning`) for orchestration, and Tier-4 (`frontier-verified`) for final synthesis/security audits. |
| **KV-Cache Prefix Pinning** | Recomputes or churns system/tool prefixes across turns. | **`computeHarnessKvPrefixHash`** pins `x-eluvix-prefix-hash` (`elx-kv-<16hex>`) across all turns of a trajectory for DeepSeek MLA FP8 / Mooncake / NIXL KV-cache reuse. |

---

## 2. Three Execution Modes

You can run the Eluvix OpenCode fork in three ways depending on your infrastructure:

### Mode A: Embedded In-Process (`opencode-eluvix://` or `embedded: true`)
Runs directly inside `@eluvix/router-core` (`executeEmbeddedOpenCodeTurn`) with **zero HTTP hop overhead**. Automatically treated as a **local upstream** (`isLocalUpstream(u) === true`) under `egressPolicy: 'local-only'`.

```ts
import { Eluvix, type UpstreamConfig } from '@eluvix/router-core';

const openCodeEmbedded: UpstreamConfig = {
  id: 'opencode-embedded',
  name: 'Embedded Eluvix OpenCode',
  type: 'harness',
  endpoint: 'opencode-eluvix://embedded', // or 'opencode://embedded'
  priority: 95,
  models: ['harness/opencode', 'opencode/build', 'opencode/plan', '*'],
  harness: {
    kind: 'opencode',
    embedded: true,
    forked: true,
    deepIntegration: true,
    agentId: 'build',
    sessionMode: 'per-eluvix-session',
    approvalPolicy: 'auto-approve-readonly',
    autoApproveTools: ['read_file', 'grep_search', 'list_dir', 'inspect_firewall'],
    mcpServers: [
      {
        name: 'axonwall-mcp',
        endpoint: 'unix:///var/run/axonwalld.sock',
        transport: 'unix',
        tools: ['read_policy', 'list_zones'],
      },
    ],
    midLoopGuard: {
      enabled: true,
      redactPii: true,
      redactionStyle: 'token', // 'token' | 'asterisk' | 'hash'
      stripInjection: true,
      blockOnInjection: false, // set true to return HTTP 403 on indirect prompt injection
    },
    switchyardTiering: true,
    kvPrefixPinning: true,
  },
};

const router = new Eluvix({
  defaultModel: 'harness/opencode',
  egressPolicy: 'local-only',
  upstreams: [openCodeEmbedded],
});
```

---

### Mode B: Remote / Containerized Fork Server (`http://127.0.0.1:4096`)
Runs the standalone Eluvix-Forked OpenCode HTTP server (`createEluvixOpenCodeServer` or the Docker container `eluvix-opencode` on port `4096`) and connects `@eluvix/router-core` to it via `forwardOpencodeHarness`.

#### 1. Start the Server via Docker Compose
```bash
docker compose -f docker/compose/harnesses.yml --profile harness up -d opencode
```
Or run it programmatically in Node.js / TypeScript:
```ts
import { createEluvixOpenCodeServer } from '@eluvix/opencode-harness';
// (Also exported directly from '@eluvix/router-core')

const server = createEluvixOpenCodeServer({
  port: 4096,
  host: '127.0.0.1',
  defaultApprovalPolicy: 'auto-approve-readonly',
  defaultAutoApproveTools: ['read_file', 'grep_search', 'list_dir', 'inspect_repo'],
  midLoopGuard: {
    enabled: true,
    redactPii: true,
    redactionStyle: 'token',
    stripInjection: true,
    blockOnInjection: false,
  },
  // Optional custom tool executor hook:
  toolExecutor: async (toolName, args) => {
    if (toolName === 'read_file') {
      return `Contents of requested file for query: ${args.prompt}`;
    }
    return `Executed ${toolName}`;
  },
});

const { url } = await server.listen(4096, '127.0.0.1');
console.log(`Eluvix-OpenCode listening at ${url}`);
```

#### 2. Configure the Upstream in Eluvix
```ts
const openCodeRemote: UpstreamConfig = {
  id: 'opencode-fork-remote',
  name: 'Eluvix-Forked OpenCode Server',
  type: 'harness',
  endpoint: 'http://127.0.0.1:4096',
  priority: 90,
  models: ['harness/opencode', '*'],
  harness: {
    kind: 'opencode',
    forked: true,          // Unlocks client tools, MCP injection & deep guard
    deepIntegration: true, // Equivalent flag enabling deep integration
    agentId: 'build',
    sessionMode: 'per-eluvix-session',
    approvalPolicy: 'auto-approve-readonly',
    autoApproveTools: ['read_file', 'grep_search', 'list_dir'],
    mcpServers: [
      { name: 'axonwall-mcp', endpoint: 'unix:///var/run/axonwalld.sock', transport: 'unix' },
    ],
    midLoopGuard: {
      enabled: true,
      redactPii: true,
      stripInjection: true,
      blockOnInjection: false,
    },
  },
};
```

---

### Mode C: Legacy / Stock OpenCode Compatibility (`forked: false`)
When `forked` and `deepIntegration` are omitted or `false` on an `http(s)://` endpoint:
- Eluvix maintains strict backward compatibility with stock `opencode serve`.
- Any request carrying `request.tools` throws `Error: Upstream "<name>" (opencode harness) does not support tool calling...` so client tools are never silently dropped.

---

## 3. Forked HTTP Protocol Specification

The Eluvix-Forked OpenCode server implements the OpenCode session REST API plus Eluvix deep-integration extensions:

### `GET /health` (or `/healthz`)
Returns server readiness, fork metadata, enabled features, and active session count:
```json
{
  "status": "ok",
  "service": "eluvix-opencode",
  "fork": "Eluvixrouter/opencode-eluvix",
  "version": "1.0.11",
  "features": [
    "client-tool-calling",
    "mcp-mesh-injection",
    "mid-loop-prompt-privacy-guard",
    "switchyard-step-tiering",
    "deepseek-mla-kv-prefix-pinning"
  ],
  "activeSessions": 1
}
```

### `POST /session`
Creates a stateful session pinned to a deterministic KV-cache prefix hash and governed MCP servers.
- **Request Body**:
  ```json
  {
    "title": "Eluvix Session (user-123)",
    "kvPrefixHash": "elx-kv-8f01a4b9c2d3e4f5",
    "mcpServers": [
      { "name": "axonwall-mcp", "endpoint": "unix:///var/run/axonwalld.sock" }
    ]
  }
  ```
- **Response (`200 OK`)**:
  - Headers: `x-eluvix-harness-fork: eluvix-opencode`, `x-eluvix-prefix-hash: elx-kv-...`
  - Body: `{ "id": "oc_elx_...", "title": "...", "kvPrefixHash": "...", "mcpServers": [...], "createdAt": "..." }`

### `POST /session/:id/message`
Executes an agent turn with mid-loop DLP/PromptGuard, tool execution, and Switchyard step tiering.
- **Request Body**:
  ```json
  {
    "agent": "build",
    "parts": [{ "type": "text", "text": "Inspect config.yaml using read_file" }],
    "tools": [
      {
        "type": "function",
        "function": {
          "name": "read_file",
          "description": "Read a workspace file",
          "parameters": { "type": "object", "properties": { "path": { "type": "string" } } }
        }
      }
    ],
    "mcpServers": [
      { "name": "axonwall-mcp", "endpoint": "unix:///var/run/axonwalld.sock" }
    ],
    "eluvix": {
      "kvPrefixHash": "elx-kv-8f01a4b9c2d3e4f5",
      "switchyardTier": 2,
      "approvalPolicy": "auto-approve-readonly",
      "autoApproveTools": ["read_file"]
    }
  }
  ```
- **Response (`200 OK`)**:
  ```json
  {
    "id": "msg_1730145000000",
    "agent": "build",
    "parts": [
      {
        "type": "tool",
        "tool": "read_file",
        "state": {
          "status": "completed",
          "output": "File .env: OPENAI_API_KEY=[REDACTED_API_KEY]",
          "piiRedacted": ["api_key"],
          "injectionDetected": false
        }
      },
      {
        "type": "text",
        "text": "[Eluvix-OpenCode (build)] Inspect config.yaml using read_file — Tool Results: read_file: File .env: OPENAI_API_KEY=[REDACTED_API_KEY]"
      }
    ],
    "tool_calls": [
      {
        "id": "call_oc_1730145000000_0",
        "type": "function",
        "function": {
          "name": "read_file",
          "arguments": "{\"query\":\"Inspect config.yaml using read_file\"}"
        }
      }
    ],
    "switchyardTier": 2
  }
  ```

### `POST /session/:id/permission/:permId/reply`
Headless permission gate endpoint called automatically by `forwardOpencodeHarness` when a `permission_request` part is encountered.
- **Request Body**:
  ```json
  {
    "response": "once",
    "tool": "read_file",
    "reason": "Eluvix policy \"auto-approve-readonly\" auto-approved tool \"read_file\""
  }
  ```
  *(If `isToolAutoApproved` returns `false`, Eluvix sends `"response": "reject"` so unapproved tools never execute or hang.)*

---

## 4. Telemetry & Security Response Headers

Every response returned by `forwardOpencodeHarness` or `executeEmbeddedOpenCodeTurn` includes structured observability headers:

| Header | Example Value | Description |
| :--- | :--- | :--- |
| `x-eluvix-harness` | `opencode` | Identifies the OpenCode harness adapter. |
| `x-eluvix-harness-fork` | `eluvix-opencode` | Present when running in forked / deep-integration mode. |
| `x-eluvix-harness-mode` | `embedded-inprocess` | Present when running in-process without HTTP hop overhead. |
| `x-eluvix-session` | `oc_elx_1730...` | Server-side or embedded OpenCode session ID. |
| `x-eluvix-prefix-hash` | `elx-kv-9a8b7c6d5e4f3a2b` | Deterministic 64-bit FNV-1a KV-cache prefix hash over system prompt + tools + MCP servers. |
| `x-eluvix-switchyard-tier` | `1->2` or `1->4` | Per-step Switchyard model tier trajectory (`tool-selection -> final-synthesis`). |
| `x-eluvix-guard-redactions` | `2` | Total number of PII/secret entities redacted across mid-loop tool observations and output. |
| `x-eluvix-guard-injections` | `1` | Total number of indirect prompt injection payloads stripped or blocked mid-loop. |
