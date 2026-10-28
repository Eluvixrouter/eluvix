# `@eluvix/opencode-harness`

Standalone server and programmatic SDK for the **Eluvix-Forked OpenCode** coding agent harness (`eluvix-opencode`).

## Features

1. **Client Tool-Calling Bridge (`request.tools`)**: Accepts OpenAI-compatible `tools` definitions, evaluates each against `isToolAutoApproved(approvalPolicy, [toolName], autoApproveTools)`, executes approved tools, and returns OpenAI `tool_calls`.
2. **Governed MCP Mesh Injection (`mcpServers`)**: Binds MCP servers (such as `axonwall-mcp` over `unix:///var/run/axonwalld.sock`) directly into OpenCode sessions.
3. **Mid-Loop Tool Observation Guard (`inspectHarnessObservation`)**: Scrubs leaked secrets/PII (`PrivacyGuard`: API keys, SSNs, credit cards, emails, phone numbers, IPv4s) and strips or blocks indirect prompt injections (`PromptGuard`) from tool outputs before they re-enter the LLM context window.
4. **Per-Step Switchyard Tiering (`selectSwitchyardStepTier`)**: Routes mechanical tool selection to Tier 1 (`fast-local`), code edits to Tier 2 (`code-specialist`), orchestration to Tier 3 (`heavy-reasoning`), and security/synthesis turns to Tier 4 (`frontier-verified`).
5. **Deterministic KV-Cache Prefix Pinning (`computeHarnessKvPrefixHash`)**: Pins `x-eluvix-prefix-hash` (`elx-kv-<16hex>`) across multi-turn agent trajectories.

## Quick Start

```ts
import { createEluvixOpenCodeServer } from '@eluvix/opencode-harness';

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
});

const { url } = await server.listen();
console.log(`Eluvix-OpenCode server listening on ${url}`);
```

See [`docs/opencode-eluvix-fork.md`](../../docs/opencode-eluvix-fork.md) for the complete architecture, router configuration, and HTTP protocol reference.
