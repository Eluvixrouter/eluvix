import { Eluvix, RouterConfig, getAppPaths } from '@eluvix/router-core';
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

const DEFAULT_CONFIG: RouterConfig = {
  strategy: 'cost-complexity',
  fallbackStrategy: 'priority',
  upstreams: [
    {
      id: 'local-lemonade',
      name: 'Lemonade Router',
      type: 'lemonade',
      endpoint: 'http://localhost:13305',
      priority: 30,
      models: ['llama3.2-1b-FLM', 'Qwen3.5-4B-MTP-GGUF', 'LMX-Omni-5.5B-Lite', '*'],
      tier: 'tier-1',
      costPer1kTokens: 0.0,
      maxComplexityScore: 3
    },
    {
      id: 'local-vllm',
      name: 'Local vLLM',
      type: 'vllm',
      endpoint: 'http://localhost:8000',
      priority: 10,
      models: ['meta-llama/Llama-3-8b', 'meta-llama/Llama-3-70b', 'mistralai/Mistral-7B-Instruct-v0.3'],
      tier: 'tier-1',
      costPer1kTokens: 0.0,
      maxComplexityScore: 3
    },
    {
      id: 'local-ollama',
      name: 'Local Ollama',
      type: 'ollama',
      endpoint: 'http://localhost:11434',
      priority: 22,
      models: ['llama3', 'llama3.1', 'qwen2.5-coder', 'mistral', '*'],
      tier: 'tier-2',
      costPer1kTokens: 0.0,
      maxComplexityScore: 3
    },
    {
      id: 'local-vllm-sr',
      name: 'Local vLLM-sr',
      type: 'vllm-sr',
      endpoint: 'http://localhost:8001',
      priority: 20,
      models: ['meta-llama/Llama-3-8b-instruct'],
      tier: 'tier-2',
      costPer1kTokens: 0.0,
      maxComplexityScore: 3
    },
    {
      id: 'local-switchyard',
      name: 'Local Switchyard Node',
      type: 'switchyard',
      endpoint: 'http://localhost:8080',
      priority: 18,
      models: ['deepseek-ai/deepseek-coder-6.7b'],
      tier: 'tier-2',
      costPer1kTokens: 0.0,
      maxComplexityScore: 3
    },
    {
      id: 'billama-cloud',
      name: 'Billama Cloud (Recommended)',
      type: 'billama',
      endpoint: 'https://api.billama.dev',
      apiKey: '',
      priority: 16,
      models: ['*'],
      tier: 'tier-3',
      costPer1kTokens: 0.001,
      maxComplexityScore: 4
    },
    {
      id: 'openai-direct',
      name: 'OpenAI Direct',
      type: 'openai-compatible',
      endpoint: 'https://api.openai.com',
      apiKey: '',
      priority: 12,
      models: ['gpt-4o', 'gpt-4o-mini', '*'],
      tier: 'tier-3',
      costPer1kTokens: 0.005,
      maxComplexityScore: 4
    },
    {
      id: 'antigravity-agent',
      name: 'Google Antigravity Agent (AGY)',
      type: 'antigravity',
      endpoint: 'cli://agy',
      priority: 28,
      models: ['gemini-4-argon', 'gemini-3.8-flash', 'claude-opus-5-5', 'claude-sonnet-5-5', 'gpt-oss-120b', '*'],
      tier: 'tier-3',
      costPer1kTokens: 0.0,
      maxComplexityScore: 4,
      antigravity: {
        model: 'gemini-4-argon',
        effort: 'auto',
        cleanHeadless: true,
        executionMode: 'cli',
        cliPath: 'agy',
        sandbox: 'standard',
        behavior: 'autonomous'
      }
    },
    {
      id: 'claude-code-agent',
      name: 'Claude Code Agent',
      type: 'openai-compatible',
      endpoint: 'http://localhost:8082/v1',
      priority: 10,
      models: ['claude-3-7-sonnet', '*'],
      tier: 'tier-4',
      costPer1kTokens: 0.003,
      maxComplexityScore: 4
    }
  ]
};

function loadConfig(): RouterConfig {
  try {
    const configFile = getConfigPath();
    if (fs.existsSync(configFile)) {
      const data = fs.readFileSync(configFile, 'utf-8');
      const loaded: RouterConfig = JSON.parse(data);

      // Auto-migrate stale placeholder models (lemonade-general, lemonade-code)
      let modified = false;
      const lemonadeUpstream = loaded.upstreams?.find(u => u.type === 'lemonade' || u.id === 'local-lemonade');
      if (lemonadeUpstream && Array.isArray(lemonadeUpstream.models)) {
        if (lemonadeUpstream.models.includes('lemonade-general') || lemonadeUpstream.models.includes('lemonade-code')) {
          console.log('[Eluvix] Migrating stale placeholder models in Lemonade config to real models...');
          lemonadeUpstream.models = ['llama3.2-1b-FLM', 'Qwen3.5-4B-MTP-GGUF', '*'];
          modified = true;
        }
      }
      if (modified) {
        try {
          atomicWriteFile(configFile, JSON.stringify(loaded, null, 2));
        } catch {}
      }
      return loaded;
    }
  } catch (err) {
    console.warn('[Eluvix] Failed to read config file, using defaults:', err);
  }
  return DEFAULT_CONFIG;
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
  for (const upstream of config.upstreams) {
    if (!upstream.id || typeof upstream.id !== 'string') {
      throw new ConfigValidationError('Invalid upstream: "id" string is required');
    }
    if (!upstream.name || typeof upstream.name !== 'string') {
      throw new ConfigValidationError(`Invalid upstream ${upstream.id}: "name" string is required`);
    }
    if (!upstream.type || typeof upstream.type !== 'string') {
      throw new ConfigValidationError(`Invalid upstream ${upstream.id}: "type" string is required`);
    }
    if (!upstream.endpoint || typeof upstream.endpoint !== 'string') {
      throw new ConfigValidationError(`Invalid upstream ${upstream.id}: "endpoint" string is required`);
    }
    if (!Array.isArray(upstream.models)) {
      throw new ConfigValidationError(`Invalid upstream ${upstream.id}: "models" array is required`);
    }
    // Restrict cliPath on antigravity
    if (upstream.antigravity?.cliPath && !isValidCliPath(upstream.antigravity.cliPath)) {
      throw new ConfigValidationError(`Invalid upstream ${upstream.id}: unauthorized or unsafe cliPath "${upstream.antigravity.cliPath}"`);
    }
  }
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
