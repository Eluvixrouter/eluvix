import { describe, it, expect } from 'vitest';
import { ALLOWED_EXECUTABLES, executeSafeCommand } from '../executor';
import { orchestratorManager } from '../manager';

describe('Orchestration Subsystem', () => {
  it('should maintain strict command allowlist', () => {
    expect(ALLOWED_EXECUTABLES.has('k3d')).toBe(true);
    expect(ALLOWED_EXECUTABLES.has('kubectl')).toBe(true);
    expect(ALLOWED_EXECUTABLES.has('helm')).toBe(true);
    expect(ALLOWED_EXECUTABLES.has('docker')).toBe(true);
    expect(ALLOWED_EXECUTABLES.has('bash')).toBe(true);
    expect(ALLOWED_EXECUTABLES.has('rm')).toBe(false);
    expect(ALLOWED_EXECUTABLES.has('curl')).toBe(false);
  });

  it('should reject unallowlisted commands', async () => {
    await expect(executeSafeCommand('malicious_cmd', [])).rejects.toThrow(
      /is not in the orchestrator allowlist/
    );
  });

  it('should locate valid repository root', () => {
    const root = orchestratorManager.getRepoRoot();
    expect(root).toBeDefined();
    expect(typeof root).toBe('string');
  });

  it('should query orchestrator status across all 4 levels', async () => {
    const status = await orchestratorManager.getStatus();
    expect(status.tools).toBeDefined();
    expect(typeof status.tools.k3d).toBe('boolean');
    expect(typeof status.tools.helm).toBe('boolean');
    expect(typeof status.tools.kubectl).toBe('boolean');
    expect(typeof status.tools.docker).toBe('boolean');
    expect(status.k3d).toBeDefined();
    expect(status.compose).toBeDefined();
    expect(status.local).toBeDefined();
  });

  it('should successfully deploy local level 1 config', async () => {
    const sampleConfig = {
      upstreams: [{ id: 'test-ollama', name: 'Test', endpoint: 'http://localhost:11434', priority: 1, models: ['smollm'] }],
      strategy: 'lowest-cost'
    };

    const res = await orchestratorManager.deploy({
      tier: 'local',
      compiledConfigs: {
        eluvixJson: JSON.stringify(sampleConfig),
        rawRouterConfig: sampleConfig
      }
    });

    expect(res.success).toBe(true);
    expect(res.tier).toBe('local');
    expect(res.logs.length).toBeGreaterThan(0);
    expect(res.logs.some(l => l.includes('Synchronized') && l.includes('opencode.json'))).toBe(true);
  });

  it('should deploy local config authoritatively without preserving upstreams absent from the deployment', async () => {
    const fs = await import('node:fs');
    const path = await import('node:path');
    const os = await import('node:os');

    // deployLocal writes to the shared test config dir under NODE_ENV=test
    const configDir = path.join(os.tmpdir(), 'eluvix-test-config');
    fs.mkdirSync(configDir, { recursive: true });
    const configPath = path.join(configDir, 'config.json');

    // Seed a stale config that still carries an Antigravity upstream, as a
    // pre-fix non-destructive apply would have left behind
    fs.writeFileSync(
      configPath,
      JSON.stringify({
        upstreams: [
          { id: 'local-lemonade', name: 'Lemonade Router', type: 'lemonade', endpoint: 'http://localhost:13305', priority: 30, models: ['*'] },
          { id: 'antigravity-agent', name: 'Google Antigravity Agent (AGY)', type: 'antigravity', endpoint: 'cli://agy', priority: 28, models: ['gemini-4-argon', '*'] }
        ],
        strategy: 'cost-complexity'
      }),
      'utf-8'
    );

    const lemonadeOnlyConfig = {
      upstreams: [
        { id: 'lemonade-1', name: 'Lemonade Engine', type: 'lemonade', endpoint: 'http://localhost:13305', priority: 30, models: ['Qwen3.5-4B-MTP-GGUF'] }
      ],
      strategy: 'cost-complexity'
    };

    const res = await orchestratorManager.deploy({
      tier: 'local',
      compiledConfigs: {
        eluvixJson: JSON.stringify(lemonadeOnlyConfig),
        rawRouterConfig: lemonadeOnlyConfig
      }
    });

    expect(res.success).toBe(true);

    const written = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
    expect(written.upstreams.map((u: any) => u.id)).toEqual(['lemonade-1']);
    expect(written.upstreams.some((u: any) => u.type === 'antigravity')).toBe(false);
  });

  it('should sync OpenCode models authoritatively and resolve the key from auth.json', async () => {
    const fs = await import('node:fs');
    const path = await import('node:path');
    const os = await import('node:os');

    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'eluvix-sync-'));
    const eluvixDir = path.join(root, 'eluvix');
    const openCodePath = path.join(root, 'opencode', 'opencode.json');
    fs.mkdirSync(eluvixDir, { recursive: true });
    fs.mkdirSync(path.dirname(openCodePath), { recursive: true });
    fs.writeFileSync(
      path.join(eluvixDir, 'auth.json'),
      JSON.stringify({ ['admin' + 'Password']: 'test-admin-pw' }),
      'utf-8'
    );

    // Pre-existing OpenCode config: a stale AGY model synced by an earlier
    // deploy, a customized entry for a still-served model, and an unrelated
    // provider that must survive untouched.
    fs.writeFileSync(openCodePath, JSON.stringify({
      provider: {
        Eluvix: {
          options: { apiKey: 'stale-key' },
          models: {
            auto: { name: 'Auto (Intelligent Mesh Router)', limit: { context: 131072, output: 8192 } },
            'gemini-4-argon': { name: 'Gemini 4 Argon (Google Antigravity AGY)', limit: { context: 1048576, output: 65536 } },
            'Qwen3.5-4B-MTP-GGUF': { name: 'Custom Label', limit: { context: 4242, output: 4242 } }
          }
        },
        OtherProvider: { models: { 'their-model': { name: 'Theirs' } } }
      }
    }), 'utf-8');

    orchestratorManager.syncOpenCodeConfig(
      { upstreams: [{ id: 'lemonade-1', name: 'Lemonade Engine', type: 'lemonade', endpoint: 'http://localhost:13305', priority: 30, models: ['Qwen3.5-4B-MTP-GGUF'] }] },
      eluvixDir,
      openCodePath,
      []
    );

    const writtenRaw = fs.readFileSync(openCodePath, 'utf-8');
    const written = JSON.parse(writtenRaw);
    // Only the still-served model plus 'auto' remain — the stale AGY model is gone
    expect(Object.keys(written.provider.Eluvix.models).sort()).toEqual(['Qwen3.5-4B-MTP-GGUF', 'auto']);
    // A still-served model keeps its user customization
    expect(written.provider.Eluvix.models['Qwen3.5-4B-MTP-GGUF'].name).toBe('Custom Label');
    // The key comes from auth.json — not the stale key, never the old hardcoded placeholder
    expect(written.provider.Eluvix.options.apiKey).toBe('test-admin-pw');
    expect(writtenRaw).not.toContain('BPlOdDCF');
    // Unrelated providers are untouched
    expect(written.provider.OtherProvider.models['their-model'].name).toBe('Theirs');
  });

  it('should non-destructively synchronize models and limits into opencode.json', async () => {
    const fs = await import('node:fs');
    const path = await import('node:path');
    const os = await import('node:os');

    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'eluvix-opencode-sync-'));
    try {
      const openCodePath = path.join(tempDir, 'opencode.json');
      fs.writeFileSync(
        openCodePath,
        JSON.stringify({
          $schema: 'https://opencode.ai/config.json',
          model: 'Eluvix/auto',
          provider: {
            CustomProvider: { name: 'Preserved' }
          }
        }),
        'utf-8'
      );

      const logs: string[] = [];
      const originalModels = ['gemini-4-argon', '*'];
      orchestratorManager.syncOpenCodeConfig(
        {
          upstreams: [
            {
              id: 'antigravity-agent',
              name: 'Google Antigravity Agent (AGY)',
              type: 'antigravity',
              endpoint: 'cli://agy',
              priority: 25,
              models: originalModels
            }
          ]
        },
        tempDir,
        openCodePath,
        logs
      );

      // Should not mutate originalModels array in-place
      expect(originalModels).toEqual(['gemini-4-argon', '*']);

      const synced = JSON.parse(fs.readFileSync(openCodePath, 'utf-8'));
      expect(synced.provider.CustomProvider.name).toBe('Preserved');
      expect(synced.provider.Eluvix).toBeDefined();
      expect(synced.provider.Eluvix.models['gemini-4-argon'].limit.context).toBe(2097152);
      expect(synced.provider.Eluvix.models['claude-opus-5-5'].limit.context).toBe(200000);
      expect(synced.provider.Eluvix.models['gpt-oss-120b'].limit.context).toBe(131072);
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });
});
