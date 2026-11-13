# Paperclip × Eluvix Same-Machine End-to-End Runbook

This runbook verifies all three Paperclip integration tiers (Tier 0 virtual models, Tier 1 `eluvix_local` OpenCode adapter, and Tier 2 `@eluvix/paperclip-plugin`) on a single machine (`127.0.0.1`).

---

## 1. Prerequisites

1. **Eluvix Gateway** running on `http://127.0.0.1:3588` (either `apps/nextjs` or `@eluvix/desktop` daemon) with at least one healthy local or cloud upstream configured.
2. **`opencode` CLI** installed on `PATH` (for Tier 1 `eluvix_local`).
3. **Scoped Eluvix API Key**:
   - Create a named key in Eluvix with `scopes: ["paperclip"]` (or `["*"]`).
   - Store the plaintext `elx_...` token in an environment variable:
     ```bash
     export ELUVIX_API_KEY="elx_..."
     ```

---

## 2. Tier 0 — Zero-Code Loopback Connection

Configure a Paperclip OpenAI-compatible AI connection pointing at Eluvix:

- **Base URL**: `http://127.0.0.1:3588/v1`
- **API Key**: `$ELUVIX_API_KEY`
- **Virtual Models** (listed automatically by `GET /api/v1/models`):
  - `eluvix/auto` — dynamic Switchyard complexity + priority + budget routing
  - `eluvix/fast-local` — Tier 1 local/low-latency upstreams (`\$0.00`)
  - `eluvix/code-specialist` — Tier 2 code-focused local/hybrid upstreams
  - `eluvix/heavy-reasoning` — Tier 3 high-complexity reasoning
  - `eluvix/frontier-verified` — Tier 4 frontier / consensus verified

Verify from the shell:

```bash
curl -sS http://127.0.0.1:3588/api/v1/paperclip/whoami \
  -H "Authorization: Bearer $ELUVIX_API_KEY"
```

---

## 3. Tier 1 — `eluvix_local` External Adapter

1. Build `@eluvix/paperclip-adapter`:
   ```bash
   npm --prefix packages/paperclip-adapter run build
   ```
2. Register `@eluvix/paperclip-adapter` in Paperclip's external adapter registry (`eluvix_local`).
3. Create or update a Paperclip agent with:
   - `adapterType: "eluvix_local"`
   - `eluvixBaseUrl: "http://127.0.0.1:3588"`
   - `eluvixApiKeyEnv: "ELUVIX_API_KEY"` (never hardcode `elx_...` in config JSON)
   - `model: "eluvix/auto"`
4. Run Paperclip's **Test Environment** button (`testEluvixEnvironment`), which verifies loopback URL, `paperclip` scope, live Switchyard capabilities, and `opencode` binary availability.
5. Trigger a heartbeat run; Eluvix correlates every LLM call via `x-paperclip-run-id` and `eluvix_local` reads authoritative tokens + `costStatus: "reported"` from `GET /api/v1/paperclip/usage/:runId`.

---

## 4. Tier 2 — `@eluvix/paperclip-plugin` (`eluvix.switchyard`)

1. Build `@eluvix/paperclip-plugin`:
   ```bash
   npm --prefix packages/paperclip-plugin run build
   ```
2. Install the plugin in Paperclip and configure `autoAssign.mode`:
   - `off`: tools only (`eluvix:capabilities`, `eluvix:classify_task`, `eluvix:recommend_assignee`, `eluvix:explain_route`, `eluvix:budget`)
   - `advisory` *(default)*: posts a deduplicated Switchyard recommendation comment on unassigned issues
   - `shadow`: logs recommendations without posting comments or mutating issues
   - `auto`: assigns unlocked, unassigned issues in allowlisted `companies` when `confidence >= minConfidence` and hourly/tree-depth guards pass

---

## 5. Paperclip Fork Patches (F1 & F2)

If running the Paperclip fork with managed AI connections:

- Apply [`fork-patches-f1-f2.patch`](./fork-patches-f1-f2.patch) on top of Paperclip `master`:
  - **F1**: Recognizes loopback `:3588` Eluvix endpoints as `biller: "eluvix"` and ingests numeric `usage.cost` as reported USD cost.
  - **F2**: Forwards `x-paperclip-run-id`, `x-paperclip-issue-id`, `x-paperclip-agent-id`, `x-paperclip-company-id`, `x-paperclip-issue-priority`, and `x-paperclip-hop` through `managedProviderRouting` into OpenCode provider headers.
