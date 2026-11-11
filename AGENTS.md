# AGENTS.md — Eluvix Engineering, Testing & Documentation Rules

This file defines mandatory repository-wide instructions for AI coding agents (Google Antigravity `agy`, OpenCode, Claude Code, Codex, OpenHands, TrueForge) working in the **Eluvix** monorepo. Follow every rule below before considering any task complete.

---

## 1. Monorepo Architecture Overview

| Workspace Package | Directory | Responsibility |
| :--- | :--- | :--- |
| `@eluvix/router-core` | `packages/router-core` | Headless TypeScript routing engine, Switchyard L7 balancer, modality classifier, SQLite persistence (`node:sqlite` with `better-sqlite3` fallback), security/privacy/SSRF guards, harness/memory adapters, and hardware co-design modules (TEE, RDMA/Clos, NVFP4, FA3, CRS, ComfyUI, RamaLama, ArtCraft). |
| `nextjs` | `apps/nextjs` | Primary Next.js 14 web gateway (dual-protocol HTTP→HTTPS byte-sniffing demuxer on `:3588`), **Eluvix Visual Node Routing Editor** (`/editor`), Playground 2.0 (`/playground`), Observability (`/observability`), Provider Lab (`/provider`), `/api/v1/*` routes, and offline docs (`/docs`). |
| `githubio` | `apps/githubio` | Static MDX documentation website (`output: 'export'`) and interactive live demo mockup (`MockupEditor`) deployed to GitHub Pages. |
| `@eluvix/desktop` | `apps/desktop` | Cross-platform Electron desktop shell, system tray controller, and standalone `DesktopRouterServer` daemon with per-install `0o600` token authentication. |
| `@eluvix/opencode-harness` | `packages/opencode-eluvix` | Eluvix-integrated OpenCode autonomous SWE harness loop with mid-loop DLP and step tiering. |

---

## 2. Mandatory Documentation Synchronization Policy

**Every new feature, visual node, upstream provider, routing policy, API endpoint, response header, or CLI integration MUST be documented across the application and public website in the same task/commit.** Do not treat a feature as done until documentation is updated across all applicable surfaces:

1. **In-App Offline Documentation (`apps/nextjs/src/app/docs/docs-data.ts`)**:
   - Update the corresponding `DOC_SECTIONS` entry (or add a new section) with accurate parameter tables, response headers, and `curl` / CLI examples.
2. **Public Website MDX Documentation (`apps/githubio/src/app/docs/*/page.mdx`)**:
   - Synchronize the matching topic page(s) (e.g., `editor/page.mdx`, `switchyard/page.mdx`, `local-engines/page.mdx`, `cloud-providers/page.mdx`, `multimodal/page.mdx`, `playground/page.mdx`, `observability/page.mdx`, `desktop/page.mdx`).
   - Document any new REST routes, query parameters, status codes, or `X-Eluvix-*` headers in `apps/githubio/src/app/docs/api/page.mdx`.
   - Record major feature milestones in `apps/githubio/src/app/docs/releases/page.mdx`.
   - When adding a major visual node category or starter topology, keep the interactive demo in `apps/githubio/src/components/mockup/` synchronized where appropriate.
   - **Strict MDX Escaping Rule**: Never leave unescaped JSX-like angle brackets (`<think>`, `<ADMIN_PASSWORD>`), raw `{mustache}` braces (`{{POSITIVE_PROMPT}}`), or unescaped `$` pairs in `.mdx` prose outside backticks or fenced code blocks—always wrap tokens in backticks (`` `<think>` ``, `` `{{POSITIVE_PROMPT}}` ``) or escape currency (`\$0.05`) so `next build` MDX compilation never fails.
3. **Root `README.md`**:
   - Update Key Capabilities, architecture highlights, and test suite counts when shipping major capabilities.
4. **Canonical Naming & Comment Preservation**:
   - Always refer to the visual graph canvas in UI copy and documentation as the **"Eluvix Visual Node Routing Editor"**.
   - Preserve all existing comments and docstrings unrelated to your code changes.

---

## 3. Mandatory Testing & Build Verification Gates

**Every new feature, compiler transformation, security control, or bug fix MUST include automated Vitest coverage and pass all workspace builds before committing.**

### Where to Add Tests
- **Core Router, Guards, SQLite, Modality & Protocol Adapters**: `packages/router-core/src/__tests__/*.test.ts`
- **Next.js API Routes, Middleware, Compiler/Decompiler, Auto-Layout, Diagnostics & Desktop Parity**: `apps/nextjs/src/lib/__tests__/*.test.ts`

### Test Hygiene & Isolation Rules
- **Isolate Both `XDG_CONFIG_HOME` and `XDG_DATA_HOME`**:
  - On Linux, `getAppPaths('eluvix').configDir` reads `process.env.XDG_CONFIG_HOME` (`auth.json`, `keys.json`, `config.json`, layouts), while `getAppPaths('eluvix').dataDir` reads `process.env.XDG_DATA_HOME` (`eluvix.db` SQLite database).
  - Any test reading or writing config, keys, chat history, or `request_logs` **MUST** point **both** `XDG_CONFIG_HOME` and `XDG_DATA_HOME` at an isolated `fs.mkdtempSync(...)` directory in `beforeEach` and restore/remove them in `afterEach`.
- **Preserve Snapshot & Default-Graph Stability**:
  - `apps/nextjs/src/lib/__tests__/compiler.test.ts` and `default-config.test.ts` verify deterministic compilation output. When adding new optional fields to `SwitchyardNode` or other nodes in `compiler.ts`, emit new config keys conditionally (only when enabled or non-default) so existing graphs compile identically.
- **Never Make Live External Network Calls in Unit Tests**:
  - Mock `globalThis.fetch` via `vi.spyOn(globalThis, 'fetch')` and restore mocks in `afterEach` (`vi.restoreAllMocks()`).

### Pre-Commit Verification Sequence
Run these commands in order (always build `@eluvix/router-core` first so downstream packages consume fresh `dist/` declarations and JS):

```bash
# 1. Build & test @eluvix/router-core
npm --prefix packages/router-core run build && npm --prefix packages/router-core test

# 2. Run Next.js unit & integration test suite
npm --prefix apps/nextjs test

# 3. Verify Desktop TypeScript compilation & asset copy
npm --prefix apps/desktop run build

# 4. Verify Next.js production build (types, ESLint, client/server bundle boundaries)
npm --prefix apps/nextjs run build

# 5. Verify GitHub Pages static MDX export build
npm --prefix apps/githubio run build
```

---

## 4. Critical Architectural & Security Invariants

### 4.1 Browser-Safe Client Bundle Boundary (`@eluvix/router-core`)
- Client-rendered modules in `apps/nextjs` (`RoutingEditor.tsx`, `nodes/*.tsx`, `compiler.ts`, `decompiler.ts`, `diagnostics.ts`) import shared helpers from `@eluvix/router-core/*` subpaths.
- **Any `@eluvix/router-core` file imported by browser/client code MUST contain ZERO `node:*` imports** (`node:fs`, `node:child_process`, `node:os`, `node:sqlite`, `node:net`, etc.).
- Place Node-only runtime helpers (CLI spawning, temp files, SQLite access) in dedicated server-only modules (such as `cli-exec.ts`, `db.ts`, or `comfyui-postprocess.ts`) and never re-export them from browser-imported subpath modules.

### 4.2 Dual Registration for `@eluvix/router-core` Subpath Exports
Whenever creating a new subpath module `packages/router-core/src/<module>.ts`:
1. Add `"./<module>"` (`types` + `default`) to `exports` in `packages/router-core/package.json`.
2. Add `'@eluvix/router-core/<module>'` to `resolve.alias` in `apps/nextjs/vitest.config.ts` **ABOVE** the catch-all `'@eluvix/router-core'` entry (Vite matches alias keys in insertion order; placing it below `'@eluvix/router-core'` breaks Vitest module resolution).

### 4.3 Security, Auth, SSRF & Subprocess Hardening
- **Unified SSRF & Cloud Metadata Guard (`@eluvix/router-core/ssrf-guard`)**:
  - Every server-side HTTP fetch to a user-provided or configurable endpoint **MUST** validate the URL first via `validateUpstreamHttpEndpoint` or `isBlockedSsrfHost`:
    - Public internet tools (e.g., web scraper): `{ allowLoopbackAndLan: false }` (default).
    - Local/LAN AI engine probes & media proxies (Ollama, vLLM, RamaLama, ComfyUI, Lemonade, Desktop `/api/detect-models`): `{ allowLoopbackAndLan: true }` — permits loopback and RFC1918/Tailscale LAN while still strictly blocking cloud IMDS (`169.254.169.254`, `100.100.100.200`, `fd00:ec2::254`, `metadata.google.internal`), IPv4-mapped IPv6, octal/hex/decimal IP encodings, NAT64, `0.0.0.0`, embedded `user:pass@` credentials, and non-`http(s):` schemes.
- **Subprocess & Generated Script Safety**:
  - Never pass unsanitized strings to `child_process.exec` or `shell: true`. Use `spawn` / `execFile` with explicit argument arrays.
  - Sanitize all values interpolated into compiler-generated shell scripts, YAML, or systemd Quadlet files using `escapeShellArg`, `sanitizeSafeIdentifier`, `sanitizeIpv6SegmentList`, and `sanitizePositiveInt` from `@eluvix/router-core/shell-utils`.
- **Two-Layer API Authentication (`middleware.ts` + Route Handlers)**:
  - Next.js Edge `middleware.ts` validates session JWTs and `ADMIN_PASSWORD`, and only format-checks `Bearer elx_<letters>` tokens because Edge runtime cannot read `~/.config/eluvix/keys.json`.
  - Every `/api/v1/*` route added to the `elx_` allowlist in `apps/nextjs/src/middleware.ts` **MUST** also verify the key on disk inside the Node route handler using `resolveCallerIdentity(req)` or `resolveBearerToken(token)` and scope data access to the resolved `userId`.
- **Recursion & Loop Firewall (`x-eluvix-hops`)**:
  - Any subsystem that can dispatch nested requests back through Eluvix (agent harnesses, ComfyUI reverse-loopback custom nodes, local LLM prompt enhancers, consensus judges) must forward and increment `x-eluvix-hops` so the Loop Guard prevents runaway token recursion.

---

## 5. Full-Stack Checklist When Adding a New Node or Upstream Engine

When introducing a new inference backend, guardrail, or orchestration node, wire the full lifecycle end-to-end:

1. **Core (`packages/router-core`)**:
   - Extend `UpstreamConfig` / `RouterConfig` types, model discovery (`detectUpstreamModels`), cost calculation (`getEffectiveCostPer1kTokens` — local/LAN sovereign engines default to `$0.00`), modality filtering (`modality.ts`), and `explainRoute()` trace steps.
2. **Eluvix Visual Node Routing Editor (`apps/nextjs`)**:
   - Create the React Flow node component in `src/components/routing-editor/nodes/` with ergonomic handles and live health badge support (`NodeHealthIndicator.tsx`).
   - Register the node in `RoutingEditor.tsx`, `CommandPaletteModal.tsx` (`Cmd/Ctrl+K`), `auto-layout.ts` (Sugiyama topological stage rank), and `diagnostics.ts` (linting + one-click `applyDiagnosticFix` healing).
   - Implement forward compilation (`compiler.ts`), reverse graph reconstruction (`decompiler.ts`), and config diffing (`config-diff.ts`).
3. **Desktop Daemon Parity (`apps/desktop/src/main/server.ts`)**:
   - Mirror new core `/v1/*` routes, SSRF protections, and default local upstream entries in `DesktopRouterServer`.
4. **Tests & Documentation**:
   - Add Vitest suites, update `docs-data.ts`, `apps/githubio/src/app/docs/*.mdx`, and `README.md`, and run all 5 verification commands in Section 3 before committing.
