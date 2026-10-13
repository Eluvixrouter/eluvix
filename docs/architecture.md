# Eluvix Architecture Deep Dive

Eluvix is structured around a central **Switchyard** routing engine, capable of load-balancing, context truncation, and multi-tier failovers.

## 1. Switchyard Core (`@eluvix/router-core`)
The router operates independently of any UI, making it embeddable. Its primary lifecycle for a `routeChatCompletion` request is:

1. **Complexity Assessment**: The prompt is scanned for tokens, code blocks, structured schema, and reasoning keywords.
2. **Multimodal Assessment**: Prompts containing `image_url` types are flagged.
3. **Guardrails**:
   - Semantic Guard: Heuristically checks for prompt injection or instruction overrides.
   - Privacy Guard: Scans for PII (SSNs, API Keys, IPs) and either blocks or anonymizes them using token masking (e.g. `[REDACTED_SSN]`).
4. **Target Filtering**: 
   - Removes upstreams that do not support the requested model (unless wildcard `*` is specified).
   - If the request is Multimodal (`hasImages`), filters the targets to only include upstreams with the `vision` capability.
5. **Latency Spillover Sorting**: Queries the local SQLite DB for recent ping averages. Nodes exceeding `3000ms` latency are penalized and moved to the bottom of the routing stack.
6. **Execution**: Iterates through the sorted queue. If a local model fails (OOM, timeout), it seamlessly retries against the next fallback (e.g., Cloud).

## 2. Token Truncation
To prevent out-of-memory errors on local models with strict context windows, the engine employs middle-truncation. If a prompt exceeds 8,000 tokens, Eluvix preserves the crucial **system instructions (top)** and **recent context (bottom)**, swapping out the middle payload for a summary placeholder.

## 3. Database Layer
The `db.ts` SQLite module tracks:
- **`request_logs`**: Used for dashboard analytics and Latency Spillover metrics.
- **`chat_history`**: Stateful persistence for the Trace Playground, allowing developers to generate and export **JSONL** fine-tuning datasets via the Next.js API.

## 4. Agent Gateways & MCP
Instead of handling just raw text, Eluvix maps out Agent Gateways that route to multi-agent frameworks (like Antigravity or Claude Code). The visual editor compiles connections into an orchestration JSON file, dynamically injecting external **MCP Registries** or the internal **Native Tools** API (Calculator & WebScraper) into the agent's context.
