import { Eluvix, RouterConfig, getAppPaths } from '@eluvix/router-core';
import { DEFAULT_CONFIG } from './default-config';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

export class ConfigValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigValidationError';
  }
}

export function getConfigPath(): string {
  const { configDir } = getAppPaths('eluvix');
  if (!fs.existsSync(configDir)) {
    fs.mkdirSync(configDir, { recursive: true });
  }
  return path.join(configDir, 'config.json');
}

function atomicWriteFile(filePath: string, content: string): void {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  const tmpPath = `${filePath}.tmp.${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  try {
    fs.writeFileSync(tmpPath, content, { encoding: 'utf-8', mode: 0o600 });
    fs.renameSync(tmpPath, filePath);
  } catch (err) {
    try {
      if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath);
    } catch {}
    throw err;
  }
}

export interface LoadedConfigSanitization {
  config: RouterConfig;
  warnings: string[];
  /** True when any repair, drop, or migration changed the loaded value. */
  changed: boolean;
  /** True when the loaded value was a recognizable config object, so persisting repairs over the file is safe. */
  recognizable: boolean;
}

/**
 * Validate and migrate a config loaded from disk.
 *
 * saveConfig() rejects an invalid config outright, but the file on disk can
 * still be hand-edited, written by an older build, or corrupted — and until
 * now loadConfig() fed it to the router unchecked. This applies the same
 * per-upstream rules as validateConfig() with load-appropriate semantics:
 * repair what is safely repairable, drop what is not (with a warning for
 * each change), and fall back to the shipped defaults only when nothing
 * usable remains. A config that is already valid passes through untouched.
 */
export function sanitizeLoadedConfig(raw: unknown): LoadedConfigSanitization {
  if (!raw || typeof raw !== 'object' || !Array.isArray((raw as any).upstreams)) {
    return {
      config: structuredClone(DEFAULT_CONFIG),
      warnings: ['Saved config is not a recognizable router config; using the shipped defaults'],
      changed: true,
      recognizable: false
    };
  }

  const warnings: string[] = [];
  const source = raw as Record<string, any>;
  const config: Record<string, any> = { ...source };

  if (config.egressPolicy !== undefined && config.egressPolicy !== 'local-only' && config.egressPolicy !== 'allow-egress') {
    warnings.push(`Dropping invalid "egressPolicy" value ${JSON.stringify(config.egressPolicy)} (expected "local-only" or "allow-egress"); the legacy default applies`);
    delete config.egressPolicy;
  }

  const upstreams: any[] = [];
  source.upstreams.forEach((upstream: any, index: number) => {
    const problem = upstreamProblem(upstream);
    if (problem) {
      const label = upstream && typeof upstream === 'object' && typeof upstream.id === 'string' ? ` "${upstream.id}"` : ` at index ${index}`;
      warnings.push(`Dropping invalid upstream${label}: ${problem}`);
    } else {
      upstreams.push(upstream);
    }
  });

  if (upstreams.length === 0) {
    warnings.push('Saved config has no valid upstreams; using the shipped defaults');
    return { config: structuredClone(DEFAULT_CONFIG), warnings, changed: true, recognizable: true };
  }
  config.upstreams = upstreams;

  // Auto-migrate stale placeholder models (lemonade-general, lemonade-code)
  const lemonadeUpstream = upstreams.find(u => u.type === 'lemonade' || u.id === 'local-lemonade');
  if (lemonadeUpstream && Array.isArray(lemonadeUpstream.models)) {
    if (lemonadeUpstream.models.includes('lemonade-general') || lemonadeUpstream.models.includes('lemonade-code')) {
      lemonadeUpstream.models = ['llama3.2-1b-FLM', 'Qwen3.5-4B-MTP-GGUF', '*'];
      warnings.push('Migrated stale placeholder models in Lemonade config to real models');
    }
  }

  return { config: config as RouterConfig, warnings, changed: warnings.length > 0, recognizable: true };
}

function loadConfig(): RouterConfig {
  try {
    const configFile = getConfigPath();
    if (fs.existsSync(configFile)) {
      const data = fs.readFileSync(configFile, 'utf-8');
      const parsed = JSON.parse(data);
      const { config, warnings, changed, recognizable } = sanitizeLoadedConfig(parsed);
      for (const warning of warnings) {
        console.warn(`[Eluvix] Config on load: ${warning}`);
      }
      if (changed && recognizable) {
        try {
          atomicWriteFile(configFile, JSON.stringify(config, null, 2));
        } catch {}
      }
      return config;
    }
  } catch (err) {
    console.warn('[Eluvix] Failed to read config file, using defaults:', err);
  }
  // Clone: the Eluvix constructor sorts config.upstreams in place, and the
  // canonical DEFAULT_CONFIG must never be mutated by a live router.
  return structuredClone(DEFAULT_CONFIG);
}

let activeConfig: RouterConfig = loadConfig();
let activeRouter: Eluvix = new Eluvix(activeConfig);
let activeProviderAgent: EluvixProviderAgent | null = null;

export function getRouter(): Eluvix {
  return activeRouter;
}

export function getConfig(): RouterConfig {
  return activeConfig;
}

export function reloadConfig(): RouterConfig {
  activeConfig = loadConfig();
  activeRouter = new Eluvix(activeConfig);
  return activeConfig;
}

function isValidCliPath(cliPath?: string): boolean {
  if (!cliPath) return true;
  // Disallow shell characters and command injection
  if (/[;&|`$<>\s]/.test(cliPath)) return false;
  const normalized = path.normalize(cliPath);
  if (normalized === 'agy') return true;

  const homeDir = os.homedir();
  const trustedPaths = [
    '/usr/local/bin/agy',
    '/usr/bin/agy',
    path.join(homeDir, '.local', 'bin', 'agy'),
    path.join(homeDir, 'bin', 'agy')
  ];
  return trustedPaths.includes(normalized);
}

export function validateConfig(config: any): void {
  if (!config || typeof config !== 'object') {
    throw new ConfigValidationError('Invalid configuration: must be an object');
  }
  if (!Array.isArray(config.upstreams)) {
    throw new ConfigValidationError('Invalid configuration: "upstreams" must be an array');
  }
  if (config.egressPolicy !== undefined && config.egressPolicy !== 'local-only' && config.egressPolicy !== 'allow-egress') {
    throw new ConfigValidationError('Invalid configuration: "egressPolicy" must be "local-only" or "allow-egress"');
  }
  for (const upstream of config.upstreams) {
    const problem = upstreamProblem(upstream);
    if (problem) {
      const hasId = upstream && typeof upstream === 'object' && typeof upstream.id === 'string';
      throw new ConfigValidationError(hasId ? `Invalid upstream ${upstream.id}: ${problem}` : `Invalid upstream: ${problem}`);
    }
  }
}

/**
 * The reason one upstream entry is invalid, or null when it is valid.
 * Shared by validateConfig() (save path) and sanitizeLoadedConfig()
 * (load path) so the two can never drift into different rules.
 */
function upstreamProblem(upstream: any): string | null {
  if (!upstream || typeof upstream !== 'object' || !upstream.id || typeof upstream.id !== 'string') {
    return '"id" string is required';
  }
  if (!upstream.name || typeof upstream.name !== 'string') {
    return '"name" string is required';
  }
  if (!upstream.type || typeof upstream.type !== 'string') {
    return '"type" string is required';
  }
  if (!upstream.endpoint || typeof upstream.endpoint !== 'string') {
    return '"endpoint" string is required';
  }
  if (!Array.isArray(upstream.models)) {
    return '"models" array is required';
  }
  // Restrict cliPath on antigravity
  if (upstream.antigravity?.cliPath && !isValidCliPath(upstream.antigravity.cliPath)) {
    return `unauthorized or unsafe cliPath "${upstream.antigravity.cliPath}"`;
  }
  return null;
}

export function saveConfig(newConfig: RouterConfig): RouterConfig {
  validateConfig(newConfig);
  activeConfig = newConfig;
  activeRouter = new Eluvix(activeConfig);
  try {
    const configFile = getConfigPath();
    atomicWriteFile(configFile, JSON.stringify(activeConfig, null, 2));
  } catch (err) {
    console.error('[Eluvix] Failed to persist config file:', err);
  }
  return activeConfig;
}

import { EluvixProviderAgent, getProviderSettings } from '@eluvix/router-core';

export function getProviderAgent(): EluvixProviderAgent {
  if (!activeProviderAgent) {
    activeProviderAgent = new EluvixProviderAgent();
    const settings = getProviderSettings();
    if (settings && settings.enabled === 1) {
      activeProviderAgent.start().catch((err) => {
        console.warn('[Provider Agent Auto-Start]', err.message);
      });
    }
  }
  return activeProviderAgent;
}
