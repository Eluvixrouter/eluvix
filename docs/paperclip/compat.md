# Eluvix × Paperclip Compatibility & P0 Spike Report

- **Paperclip Baseline**: `master@d169dd5a` (2026-11-12) + fork PR #21121 (`agy_local` at `46b4510c`)
- **`@paperclipai/adapter-utils`**: `0.3.1`
- **`@paperclipai/plugin-sdk`**: `1.0.0`
- **Local `opencode` binary**: detected (`mise` install on `PATH`)

## Spike Findings

| Spike | Result | Design Impact |
| :--- | :--- | :--- |
| **S1** OpenCode `options.headers` | **PASS** — `opencode-local` injects `provider.<alias>.options.headers` via `OPENCODE_CONFIG_CONTENT`. | `eluvix_local` passes `x-paperclip-run-id`, `-issue-id`, `-agent-id`, `-company-id`, `-issue-priority`, `-budget-remaining-pct`, `-sensitivity` directly in `OPENCODE_CONFIG_CONTENT`. |
| **S2** `getConfigSchema()` field types | **PASS (with note)** — Supports `text \| select \| toggle \| number \| textarea \| combobox`. No native `secret` field type. | Support `env.ELUVIX_API_KEY` (via Paperclip's built-in `envBindings` secret picker) as well as `config.eluvixApiKey` / secret-ref string. |
| **S3** `ctx.agents.list()` visibility | **PASS** — `plugin-host-services.ts` returns full `Agent` rows (`adapterType`, `adapterConfig.model`, `capabilities`, `budgetMonthlyCents`, `spentMonthlyCents`) under `agents.read`. | Plugin scoring reads `adapterType` and `adapterConfig.model` directly without needing a separate board-key REST workaround. |
| **S4** `ctx.issues.update()` lock behavior | **PASS (with guard)** — `plugin-host-services.ts` emits `issue.updated` activity log; `issues.update` does not enforce `checkoutRunId` lock on behalf of plugins. | Plugin **must** explicitly verify `!issue.checkoutRunId && !issue.assigneeAgentId` before auto-assigning. |
| **S5** Plugin SDK test harness | **PASS** — `@paperclipai/plugin-sdk/testing` is exported. | Plugin unit tests use the official SDK test harness + mocked Eluvix fetch. |
| **S6** OpenCode server compatibility | **PASS** — `opencode` binary available; `@eluvix/opencode-harness` drives both stock (`forked: false`) and Eluvix-forked (`forked: true`) `opencode serve`. | Auto-detect `eluvix-opencode` / `opencode` binary, preferring the Eluvix fork when present. |
