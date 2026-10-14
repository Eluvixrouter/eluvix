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
