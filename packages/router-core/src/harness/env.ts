/**
 * Environment construction for spawned child processes (ACP agents, the
 * antigravity CLI, model probes).
 *
 * Security audit H-1 / decision D3: agent CLIs are autonomous code steered
 * by untrusted prompt text, so they must never inherit the router's own
 * credentials through the environment. `getOrCreateAuthConfig` (auth.ts)
 * deliberately propagates ADMIN_PASSWORD and NEXTAUTH_SECRET into
 * process.env for in-process consumers — that propagation stays — but at
 * the spawn boundary the environment is scrubbed with a denylist (D3
 * chose a denylist over a strict allowlist so harnesses keep the rest of
 * the operator's environment: PATH, HOME, provider CLI config, etc.).
 *
 * The denylist covers:
 * - ADMIN_PASSWORD / NEXTAUTH_SECRET: the dashboard's master credential
 *   and session-signing secret. A child reading /proc/self/environ could
 *   otherwise take over the admin API and forge sessions offline.
 * - MEM0_API_KEY / OPENVIKING_API_KEY: the memory-provider service keys
 *   (context/mem0.ts, context/openviking.ts read them from process.env).
 *   The router itself talks to those providers; spawned agents have no
 *   business holding the keys.
 */
export const CHILD_ENV_DENYLIST: readonly string[] = [
  'ADMIN_PASSWORD',
  'NEXTAUTH_SECRET',
  'MEM0_API_KEY',
  'OPENVIKING_API_KEY'
];

/**
 * Build the environment for a child process: a copy of process.env with
 * every denylisted key removed, overlaid with `extra` (e.g. HOME,
 * ELUVIX_ORIGIN). Extras are applied first and the denylist is enforced
 * last, so a caller can never re-introduce a denied key through `extra`.
 */
export function buildChildEnv(extra?: Record<string, string>): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (typeof value === 'string') {
      env[key] = value;
    }
  }
  if (extra) {
    Object.assign(env, extra);
  }
  for (const key of CHILD_ENV_DENYLIST) {
    delete env[key];
  }
  return env;
}
