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
  });
});
