import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { getAppPaths } from './paths.js';

/**
 * Central resolution + validation for every CLI executable router-core
 * spawns on behalf of a config value (security audit C-1 / M-1 / M-2).
 *
 * Before this module, the antigravity forwarding path trusted the config's
 * `cliPath` verbatim, model discovery spawned it with no check at all, and
 * the ACP harness checked only `path.basename` — so a config value such as
 * `/tmp/dropped/goose` or `/any/dir/agy` named an arbitrary binary for the
 * router to execute. `resolveCliExecutable` is now the single gate:
 *
 *  1. The basename must be on the caller's allowlist.
 *  2. The command is resolved to a canonical path (PATH lookup for bare
 *     names, `realpath` for explicit paths — symlinks are followed, so a
 *     symlink cannot launder a denied location).
 *  3. The file must exist and be executable.
 *  4. The resolved path must not live under a denied directory:
 *     world-writable scratch space (`os.tmpdir()`, `/tmp`, `/var/tmp`,
 *     `/dev/shm`) or Eluvix's own config/data/layouts dirs — locations a
 *     local account, a dropped file, or a config/state channel can write.
 */

export const ANTIGRAVITY_CLI_BINARIES: readonly string[] = ['agy', 'antigravity'];

export const ACP_CLI_BINARIES: readonly string[] = [
  'goose',
  'opencode',
  'openhands',
  'claude-code-acp',
  'agy'
];

export interface ResolveCliExecutableOptions {
  /** Basenames that may execute (e.g. ANTIGRAVITY_CLI_BINARIES). */
  allowedBasenames: readonly string[];
  /** Environment used for PATH lookup and app-path derivation. Defaults to process.env. */
  env?: NodeJS.ProcessEnv;
  /** Extra directories to deny, beyond the built-in set. */
  extraDeniedDirs?: readonly string[];
}

function canonicalDir(dir: string): string {
  const resolved = path.resolve(dir);
  try {
    return fs.realpathSync(resolved);
  } catch {
    return resolved;
  }
}

/**
 * Directories a spawned CLI must never be resolved from. Exported for tests
 * and for callers that want to explain a denial.
 */
export function getDeniedCliDirs(env: NodeJS.ProcessEnv = process.env): string[] {
  const { configDir, dataDir, layoutsDir } = getAppPaths('eluvix');
  const raw = [
    os.tmpdir(),
    '/tmp',
    '/var/tmp',
    '/dev/shm',
    configDir,
    dataDir,
    layoutsDir
  ];
  const seen = new Set<string>();
  const dirs: string[] = [];
  for (const dir of raw) {
    const canonical = canonicalDir(dir);
    if (!seen.has(canonical)) {
      seen.add(canonical);
      dirs.push(canonical);
    }
  }
  return dirs;
}

function isInsideDir(candidate: string, dir: string): boolean {
  const rel = path.relative(dir, candidate);
  return rel === '' || (!rel.startsWith('..' + path.sep) && !path.isAbsolute(rel));
}

function findOnPath(name: string, env: NodeJS.ProcessEnv): string | null {
  const pathEnv = env.PATH || env.Path || '';
  const dirs = pathEnv.split(path.delimiter).filter(Boolean);
  const suffixes = process.platform === 'win32' && !/\.[^\\/]+$/.test(name) ? ['', '.exe'] : [''];
  for (const dir of dirs) {
    for (const suffix of suffixes) {
      const candidate = path.join(dir, name + suffix);
      try {
        if (fs.statSync(candidate).isFile()) return candidate;
      } catch {}
    }
  }
  return null;
}

/**
 * Resolve a config-supplied CLI command to the canonical executable path
 * that may be spawned, or throw an `Execution denied` Error. Callers spawn
 * the RETURNED path, never the raw config value.
 */
export function resolveCliExecutable(
  command: string,
  options: ResolveCliExecutableOptions
): string {
  const env = options.env ?? process.env;
  const raw = (command || '').trim();
  if (!raw) {
    throw new Error('Execution denied: empty CLI command.');
  }

  const base = path.basename(raw);
  if (!options.allowedBasenames.includes(base)) {
    throw new Error(`Execution denied: '${base}' is not an authorized CLI binary.`);
  }

  const hasSeparator = raw.includes('/') || raw.includes('\\');
  const candidate = hasSeparator ? path.resolve(raw) : findOnPath(raw, env);
  if (!candidate) {
    throw new Error(`Execution denied: CLI binary '${base}' was not found on PATH.`);
  }

  let resolved: string;
  try {
    resolved = fs.realpathSync(candidate);
  } catch {
    throw new Error(`Execution denied: CLI binary '${base}' does not exist at '${candidate}'.`);
  }

  let stat: fs.Stats;
  try {
    stat = fs.statSync(resolved);
  } catch {
    throw new Error(`Execution denied: CLI binary '${base}' does not exist at '${resolved}'.`);
  }
  if (!stat.isFile()) {
    throw new Error(`Execution denied: '${resolved}' is not a file.`);
  }
  try {
    fs.accessSync(resolved, fs.constants.X_OK);
  } catch {
    throw new Error(`Execution denied: '${resolved}' is not executable.`);
  }

  const deniedDirs = [
    ...getDeniedCliDirs(env),
    ...(options.extraDeniedDirs ?? []).map(canonicalDir)
  ];
  for (const dir of deniedDirs) {
    if (isInsideDir(resolved, dir)) {
      throw new Error(
        `Execution denied: '${resolved}' resolves into '${dir}', a world-writable or config-controlled location.`
      );
    }
  }

  return resolved;
}

/** Non-throwing variant for probe/discovery paths that fall back gracefully. */
export function tryResolveCliExecutable(
  command: string,
  options: ResolveCliExecutableOptions
): string | null {
  try {
    return resolveCliExecutable(command, options);
  } catch {
    return null;
  }
}
