import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { getAppPaths } from './paths.js';

export type AgyEffortLevel = 'low' | 'medium' | 'high' | 'xhigh' | 'max';

export interface AgyModelEntry {
  baseId: string;
  displayName: string;
  efforts: AgyEffortLevel[];
  defaultEffort: 'low' | 'medium' | 'high';
  variants: string[];
  tier: 'Frontier' | 'Standard';
  contextLimit: number;
  outputLimit: number;
}

export const DEFAULT_AGY_MODELS: AgyModelEntry[] = [
  {
    baseId: 'gemini-4-argon',
    displayName: 'Gemini 4 Argon',
    efforts: ['low', 'medium', 'high'],
    defaultEffort: 'medium',
    variants: ['gemini-4-argon-low', 'gemini-4-argon-medium', 'gemini-4-argon-high'],
    tier: 'Frontier',
    contextLimit: 2097152,
    outputLimit: 65536
  },
  {
    baseId: 'gemini-3.8-flash',
    displayName: 'Gemini 3.8 Flash',
    efforts: ['low', 'medium', 'high'],
    defaultEffort: 'low',
    variants: ['gemini-3.8-flash-low', 'gemini-3.8-flash-medium', 'gemini-3.8-flash-high'],
    tier: 'Standard',
    contextLimit: 1048576,
    outputLimit: 65536
  },
  {
    baseId: 'claude-opus-5-5',
    displayName: 'Claude Opus 5.5',
    efforts: ['low', 'medium', 'high'],
    defaultEffort: 'medium',
    variants: ['claude-opus-5-5-low', 'claude-opus-5-5-medium', 'claude-opus-5-5-high'],
    tier: 'Frontier',
    contextLimit: 200000,
    outputLimit: 65536
  },
  {
    baseId: 'claude-sonnet-5-5',
    displayName: 'Claude Sonnet 5.5',
    efforts: ['low', 'medium', 'high'],
    defaultEffort: 'low',
    variants: ['claude-sonnet-5-5-low', 'claude-sonnet-5-5-medium', 'claude-sonnet-5-5-high'],
    tier: 'Frontier',
    contextLimit: 200000,
    outputLimit: 65536
  },
  {
    baseId: 'gpt-oss-120b',
    displayName: 'GPT-OSS 120B',
    efforts: ['medium'],
    defaultEffort: 'medium',
    variants: ['gpt-oss-120b-medium'],
    tier: 'Frontier',
    contextLimit: 131072,
    outputLimit: 8192
  }
];

const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes
let memoryCache: { models: AgyModelEntry[]; timestamp: number } | null = null;

function getCacheFilePath(): string {
  const isTest = process.env.NODE_ENV === 'test' || Boolean(process.env.VITEST);
  const configDir = isTest
    ? path.join(os.tmpdir(), 'eluvix-test-config')
    : getAppPaths('eluvix').configDir;
  return path.join(configDir, 'agy-models-cache.json');
}

export function inferModelMetadata(baseId: string): {
  tier: 'Frontier' | 'Standard';
  contextLimit: number;
  outputLimit: number;
} {
  const lower = baseId.toLowerCase();
  if (lower.includes('4-argon') || lower.includes('4-argo')) {
    return { tier: 'Frontier', contextLimit: 2097152, outputLimit: 65536 };
  }
  if (lower.includes('gemini-3.8') || lower.includes('flash')) {
    return { tier: 'Standard', contextLimit: 1048576, outputLimit: 65536 };
  }
  if (lower.includes('claude-opus') || lower.includes('claude-sonnet')) {
    return { tier: 'Frontier', contextLimit: 200000, outputLimit: 65536 };
  }
  if (lower.includes('120b')) {
    return { tier: 'Frontier', contextLimit: 131072, outputLimit: 8192 };
  }
  return { tier: 'Frontier', contextLimit: 128000, outputLimit: 16384 };
}

/**
 * Parses raw `agy models` stdout (stripping ANSI codes & spinners) into grouped AgyModelEntry objects.
 */
export function parseAgyModelsOutput(rawOutput: string): AgyModelEntry[] {
  // Strip ANSI escape sequences and carriage returns from CLI spinners
  const cleaned = rawOutput
    .replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '')
    .replace(/[\r]/g, '\n');

  const lines = cleaned
    .split('\n')
    .map(l => l.trim())
    .filter(Boolean);

  const grouped = new Map<string, {
    baseId: string;
    displayName: string;
    efforts: Set<AgyEffortLevel>;
    variants: string[];
  }>();

  for (const line of lines) {
    if (line.includes('Fetching available models')) continue;
    // Match lines like: "gemini-4-argon-medium     Gemini 4 Argon (Medium)"
    const match = line.match(/^([a-zA-Z0-9._-]+?)-(low|medium|high|xhigh|max)\s+(.+?)(?:\s*\((Low|Medium|High|XHigh|Max)\))?$/i);
    if (match) {
      const baseId = match[1];
      const effort = match[2].toLowerCase() as AgyEffortLevel;
      const displayName = match[3].trim();
      const fullVariant = `${baseId}-${effort}`;

      let entry = grouped.get(baseId);
      if (!entry) {
        entry = {
          baseId,
          displayName,
          efforts: new Set<AgyEffortLevel>(),
          variants: []
        };
        grouped.set(baseId, entry);
      }
      entry.efforts.add(effort);
      if (!entry.variants.includes(fullVariant)) {
        entry.variants.push(fullVariant);
      }
    }
  }

  if (grouped.size === 0) {
    return [];
  }

  const orderWeight: Record<AgyEffortLevel, number> = {
    low: 1,
    medium: 2,
    high: 3,
    xhigh: 4,
    max: 5
  };

  const results: AgyModelEntry[] = [];
  for (const item of grouped.values()) {
    const sortedEfforts = Array.from(item.efforts).sort((a, b) => orderWeight[a] - orderWeight[b]);
    const meta = inferModelMetadata(item.baseId);
    const defaultEffort: 'low' | 'medium' | 'high' =
      sortedEfforts.includes('low') && meta.tier === 'Standard'
        ? 'low'
        : sortedEfforts.includes('medium')
          ? 'medium'
          : (sortedEfforts[0] as 'low' | 'medium' | 'high') || 'medium';

    results.push({
      baseId: item.baseId,
      displayName: item.displayName,
      efforts: sortedEfforts,
      defaultEffort,
      variants: item.variants,
      tier: meta.tier,
      contextLimit: meta.contextLimit,
      outputLimit: meta.outputLimit
    });
  }

  return results;
}

/**
 * Synchronously returns cached Antigravity models (from memory, disk cache, or built-in defaults).
 */
export function getCachedAntigravityModels(): AgyModelEntry[] {
  if (memoryCache && Date.now() - memoryCache.timestamp < CACHE_TTL_MS) {
    return memoryCache.models;
  }

  try {
    const cacheFile = getCacheFilePath();
    if (fs.existsSync(cacheFile)) {
      const raw = JSON.parse(fs.readFileSync(cacheFile, 'utf-8'));
      if (Array.isArray(raw.models) && raw.models.length > 0) {
        // The disk cache is subject to the same TTL as the memory cache.
        // Adopting raw.timestamp without an age check (the old behavior)
        // served an arbitrarily old catalog — e.g. one written days ago
        // on a previous run — as if it were current, and those models
        // feed isAntigravitySupportedModel routing decisions.
        const cachedAt = typeof raw.timestamp === 'number' ? raw.timestamp : 0;
        if (Date.now() - cachedAt < CACHE_TTL_MS) {
          memoryCache = {
            models: raw.models,
            timestamp: cachedAt
          };
          return raw.models;
        }
        // Stale disk cache: treat as a miss and fall through to defaults.
      }
    }
  } catch {}

  return DEFAULT_AGY_MODELS;
}

/**
 * Asynchronously discovers models from `agy models` CLI and updates memory + disk cache.
 */
export async function discoverAntigravityModels(
  cliPath = 'agy',
  forceRefresh = false
): Promise<{ models: AgyModelEntry[]; cachedAt: string; source: 'cli' | 'cache' | 'default' }> {
  if (!forceRefresh && memoryCache && Date.now() - memoryCache.timestamp < CACHE_TTL_MS) {
    return {
      models: memoryCache.models,
      cachedAt: new Date(memoryCache.timestamp).toISOString(),
      source: 'cache'
    };
  }

  return new Promise((resolve) => {
    let stdout = '';
    let resolved = false;

    const finishFallback = () => {
      if (resolved) return;
      resolved = true;
      const fallback = getCachedAntigravityModels();
      resolve({
        models: fallback,
        cachedAt: new Date(memoryCache?.timestamp || Date.now()).toISOString(),
        source: memoryCache ? 'cache' : 'default'
      });
    };

    let child;
    try {
      child = spawn(cliPath, ['models'], {
        stdio: ['ignore', 'pipe', 'pipe']
      });
    } catch {
      finishFallback();
      return;
    }

    const timer = setTimeout(() => {
      try { child.kill('SIGTERM'); } catch {}
      finishFallback();
    }, 6000);

    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString();
    });

    child.on('error', () => {
      clearTimeout(timer);
      finishFallback();
    });

    child.on('close', (code) => {
      clearTimeout(timer);
      if (resolved) return;
      if (code === 0 && stdout.trim()) {
        const parsed = parseAgyModelsOutput(stdout);
        if (parsed.length > 0) {
          resolved = true;
          const now = Date.now();
          memoryCache = { models: parsed, timestamp: now };
          try {
            const cacheFile = getCacheFilePath();
            fs.mkdirSync(path.dirname(cacheFile), { recursive: true });
            fs.writeFileSync(cacheFile, JSON.stringify({ models: parsed, timestamp: now }, null, 2), 'utf-8');
          } catch {}
          resolve({
            models: parsed,
            cachedAt: new Date(now).toISOString(),
            source: 'cli'
          });
          return;
        }
      }
      finishFallback();
    });
  });
}

/**
 * Resolves the base model name and adaptive `--effort` flag based on:
 * 1. Explicit effort suffix on the model name (e.g. `claude-opus-5-5-high`)
 * 2. Configured effort (`auto`, `low`, `medium`, `high`)
 * 3. Switchyard prompt complexity score (1-2 -> low, 3 -> medium, 4 -> high)
 * 4. Model's supported effort capabilities (e.g. `gpt-oss-120b` clamps to `medium`)
 */
export function resolveAntigravityEffort(
  requestedModel: string,
  configuredEffort: 'auto' | 'low' | 'medium' | 'high' | undefined,
  complexityScore: 1 | 2 | 3 | 4 = 1,
  catalog: AgyModelEntry[] = getCachedAntigravityModels()
): { baseModel: string; effort: 'low' | 'medium' | 'high' } {
  let baseModel = requestedModel;
  let explicitSuffixEffort: 'low' | 'medium' | 'high' | null = null;

  const suffixMatch = requestedModel.match(/^(.+?)-(low|medium|high)$/i);
  if (suffixMatch) {
    baseModel = suffixMatch[1];
    explicitSuffixEffort = suffixMatch[2].toLowerCase() as 'low' | 'medium' | 'high';
  }

  // Normalize gemini-4-argo alias to gemini-4-argon for CLI invocation
  if (/^gemini-4-argo$/i.test(baseModel)) {
    baseModel = 'gemini-4-argon';
  }

  let targetEffort: 'low' | 'medium' | 'high';
  if (explicitSuffixEffort) {
    targetEffort = explicitSuffixEffort;
  } else if (configuredEffort && configuredEffort !== 'auto') {
    targetEffort = configuredEffort;
  } else {
    // Adaptive effort mapped from Switchyard prompt complexity score
    if (complexityScore >= 4) {
      targetEffort = 'high';
    } else if (complexityScore === 3) {
      targetEffort = 'medium';
    } else {
      targetEffort = 'low';
    }
  }

  // Clamp to model's supported effort tiers
  const modelEntry = catalog.find(m => m.baseId.toLowerCase() === baseModel.toLowerCase());
  const supportedEfforts = modelEntry?.efforts || (
    /^gpt-oss-120b/i.test(baseModel) ? ['medium'] : ['low', 'medium', 'high']
  );

  if (!supportedEfforts.includes(targetEffort)) {
    if (supportedEfforts.includes('medium')) {
      targetEffort = 'medium';
    } else if (supportedEfforts.includes('low')) {
      targetEffort = 'low';
    } else if (supportedEfforts.includes('high')) {
      targetEffort = 'high';
    }
  }

  return { baseModel, effort: targetEffort };
}

/**
 * Prepares an isolated HOME directory (`~/.eluvix/agy-headless-home`) for headless `agy` API calls.
 * Symlinks authentication and state files from the real `~/.gemini` directory while providing
 * an empty plugin registry (`"plugins": {}`) so SessionStart hooks and 70+ IDE skills do not
 * bloat prompt prefill tokens or inject plugin setup prompts.
 */
export function prepareCleanAgyHome(realHomeDir: string = os.homedir()): string {
  const cleanHome = path.join(realHomeDir, '.eluvix', 'agy-headless-home');
  const realGeminiDir = path.join(realHomeDir, '.gemini');
  const cleanGeminiDir = path.join(cleanHome, '.gemini');

  try {
    fs.mkdirSync(path.join(cleanGeminiDir, 'config'), { recursive: true });
    fs.mkdirSync(path.join(cleanGeminiDir, 'antigravity-cli'), { recursive: true });
    fs.mkdirSync(path.join(cleanGeminiDir, 'antigravity'), { recursive: true });

    const ensureSymlink = (src: string, dest: string) => {
      if (!fs.existsSync(src)) return;
      try {
        const stat = fs.lstatSync(dest, { throwIfNoEntry: false });
        if (stat) {
          // If it's a broken symlink, remove and recreate it
          if (stat.isSymbolicLink() && !fs.existsSync(dest)) {
            fs.unlinkSync(dest);
          } else {
            return;
          }
        }
        fs.symlinkSync(src, dest);
      } catch {}
    };

    // Symlink top-level auth & identity files from ~/.gemini
    const topLevelFiles = [
      'oauth_creds.json',
      'google_accounts.json',
      'installation_id',
      'projects.json',
      'state.json',
      'settings.json',
      'trustedFolders.json'
    ];

    for (const file of topLevelFiles) {
      ensureSymlink(path.join(realGeminiDir, file), path.join(cleanGeminiDir, file));
    }

    // Symlink antigravity-cli state & auth files
    const cliFiles = [
      'jetski_state.pbtxt',
      'installation_id',
      'settings.json'
    ];
    for (const file of cliFiles) {
      ensureSymlink(
        path.join(realGeminiDir, 'antigravity-cli', file),
        path.join(cleanGeminiDir, 'antigravity-cli', file)
      );
    }

    // Symlink antigravity state & auth files
    const agyFiles = [
      'antigravity_state.pbtxt',
      'installation_id'
    ];
    for (const file of agyFiles) {
      ensureSymlink(
        path.join(realGeminiDir, 'antigravity', file),
        path.join(cleanGeminiDir, 'antigravity', file)
      );
    }

    // Write clean config.json with empty plugins to prevent SessionStart hook injections
    const cleanConfigPath = path.join(cleanGeminiDir, 'config', 'config.json');
    const cleanConfig = {
      plugins: {},
      userSettings: {
        autoExecutionPolicy: 'CASCADE_COMMANDS_AUTO_EXECUTION_EAGER',
        enableTerminalSandbox: false,
        nonWorkspaceFileAccessPolicy: 'AGENT_SETTING_POLICY_ALLOW',
        permissionGrantsV2Migrated: true
      }
    };
    fs.writeFileSync(cleanConfigPath, JSON.stringify(cleanConfig, null, 2), 'utf-8');

    return cleanHome;
  } catch {
    // Fallback to real home directory if filesystem prevents symlink creation
    return realHomeDir;
  }
}

export interface AgyStreamEvent {
  type: 'init' | 'delta' | 'result' | 'ignore';
  conversationId?: string;
  textDelta?: string;
  response?: string;
  status?: string;
  usage?: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
    thinking_tokens?: number;
    cache_read_tokens?: number;
  };
}

/**
 * Parses a single NDJSON line emitted by `agy --output-format stream-json`.
 */
export function parseAgyStreamJsonLine(line: string): AgyStreamEvent {
  const trimmed = line.trim();
  if (!trimmed || !trimmed.startsWith('{')) {
    return { type: 'ignore' };
  }

  try {
    const parsed = JSON.parse(trimmed);
    if (parsed.event === 'init') {
      return {
        type: 'init',
        conversationId: parsed.conversation_id
      };
    }

    if (parsed.event === 'step_update' && parsed.step_update) {
      const su = parsed.step_update;
      if (su.step_type === 'agent_response' && typeof su.text_delta === 'string' && su.text_delta.length > 0) {
        return {
          type: 'delta',
          conversationId: su.conversation_id,
          textDelta: su.text_delta
        };
      }
      return { type: 'ignore' };
    }

    if (parsed.event === 'result' && parsed.result) {
      const r = parsed.result;
      const u = r.usage;
      return {
        type: 'result',
        conversationId: r.conversation_id,
        response: typeof r.response === 'string' ? r.response : undefined,
        status: r.status,
        usage: u
          ? {
              prompt_tokens: u.input_tokens ?? 0,
              completion_tokens: u.output_tokens ?? 0,
              total_tokens: u.total_tokens ?? ((u.input_tokens ?? 0) + (u.output_tokens ?? 0)),
              thinking_tokens: u.thinking_tokens ?? 0,
              cache_read_tokens: u.cache_read_tokens ?? 0
            }
          : undefined
      };
    }
  } catch {
    // Ignore malformed non-JSON lines
  }

  return { type: 'ignore' };
}
