import { describe, it, expect, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ALLOWED_EXECUTABLES, executeSafeCommand, type CommandExecutionResult } from '../executor';
import { orchestratorManager } from '../manager';
import { getComposeServicesForConfig } from '@/lib/docker-catalog';

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

  // getStatus() shells out to docker/k3d/kubectl/helm with per-probe
  // timeouts of 3-5s each, so its wall-clock time is environment-dependent:
  // instant where the tools are absent, several seconds on a CI runner
  // where they exist. The default 5s test timeout is too tight there.
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
  }, 60_000);

  it('should successfully deploy local level 1 config', async () => {
    const sampleConfig = {
      upstreams: [{ id: 'test-ollama', name: 'Test', type: 'ollama', endpoint: 'http://localhost:11434', priority: 1, models: ['smollm'] }],
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

  it('should sync OpenCode models authoritatively and mint a scoped key, never the admin password', async () => {
    const fs = await import('node:fs');
    const path = await import('node:path');
    const os = await import('node:os');

    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'eluvix-sync-'));
    const eluvixDir = path.join(root, 'eluvix');
    const openCodePath = path.join(root, 'opencode', 'opencode.json');
    fs.mkdirSync(eluvixDir, { recursive: true });
    fs.mkdirSync(path.dirname(openCodePath), { recursive: true });
    const { listNamedApiKeys } = await import('@eluvix/router-core');
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
    // Hunt-3 C-M3: the key is a scoped `configurator:opencode` named key —
    // never the admin password from auth.json, and never the stale key.
    const writtenKey = written.provider.Eluvix.options.apiKey as string;
    expect(writtenKey).toMatch(/^elx_[A-Za-z]{24,64}$/);
    expect(writtenKey).not.toBe('test-admin-pw');
    expect(writtenRaw).not.toContain('test-admin-pw');
    expect(writtenRaw).not.toContain('BPlOdDCF');
    // A second sync reuses the still-valid scoped key instead of minting
    // another one — exactly one live configurator:opencode key exists.
    const scopedAfterFirst = listNamedApiKeys().filter((k) => k.label === 'configurator:opencode');
    expect(scopedAfterFirst.length).toBe(1);
    expect(scopedAfterFirst[0].keyPrefix).toBe(writtenKey.slice(0, 8));
    orchestratorManager.syncOpenCodeConfig(
      { upstreams: [{ id: 'lemonade-1', name: 'Lemonade Engine', type: 'lemonade', endpoint: 'http://localhost:13305', priority: 30, models: ['Qwen3.5-4B-MTP-GGUF'] }] },
      eluvixDir,
      openCodePath,
      []
    );
    const rewritten = JSON.parse(fs.readFileSync(openCodePath, 'utf-8'));
    expect(rewritten.provider.Eluvix.options.apiKey).toBe(writtenKey);
    expect(listNamedApiKeys().filter((k) => k.label === 'configurator:opencode').length).toBe(1);
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

  // Hunt-2 M-C3: LOCAL deploy must validate before writing, keep a backup,
  // and report failure — never destroy the live config while claiming
  // success. deployLocal writes to the shared test config dir under
  // NODE_ENV=test, so these tests live in this file (sequential) rather
  // than racing it from another worker.
  describe('deployLocal validation and backup (hunt2 M-C3)', () => {
    const configDir = path.join(os.tmpdir(), 'eluvix-test-config');

    function seedValidConfig() {
      fs.mkdirSync(configDir, { recursive: true });
      const valid = {
        upstreams: [
          { id: 'seed-lemonade', name: 'Seed', type: 'lemonade', endpoint: 'http://localhost:13305', models: ['*'] }
        ],
        strategy: 'cost-complexity'
      };
      fs.writeFileSync(path.join(configDir, 'config.json'), JSON.stringify(valid), 'utf-8');
      return valid;
    }

    function readDeployed() {
      return JSON.parse(fs.readFileSync(path.join(configDir, 'config.json'), 'utf-8'));
    }

    it('refuses an invalid config and leaves the previous config untouched', async () => {
      const seeded = seedValidConfig();
      const res = await orchestratorManager.deploy({
        tier: 'local',
        compiledConfigs: {
          eluvixJson: JSON.stringify({ upstreams: 'not-an-array' }),
          rawRouterConfig: { upstreams: 'not-an-array' }
        }
      });
      expect(res.success).toBe(false);
      expect(readDeployed()).toEqual(seeded);
    });

    it('refuses an empty upstream graph and leaves the previous config untouched', async () => {
      const seeded = seedValidConfig();
      const res = await orchestratorManager.deploy({
        tier: 'local',
        compiledConfigs: {
          eluvixJson: JSON.stringify({ upstreams: [] }),
          rawRouterConfig: { upstreams: [] }
        }
      });
      expect(res.success).toBe(false);
      expect(readDeployed()).toEqual(seeded);
    });

    it('backs up the previous config on a valid deploy', async () => {
      const seeded = seedValidConfig();
      const next = {
        upstreams: [
          { id: 'next-lemonade', name: 'Next', type: 'lemonade', endpoint: 'http://localhost:13305', models: ['*'] }
        ],
        strategy: 'cost-complexity'
      };
      const res = await orchestratorManager.deploy({
        tier: 'local',
        compiledConfigs: { eluvixJson: JSON.stringify(next), rawRouterConfig: next }
      });
      expect(res.success).toBe(true);
      expect(readDeployed().upstreams.map((u: any) => u.id)).toEqual(['next-lemonade']);
      const backupPath = path.join(configDir, 'config.json.bak');
      expect(fs.existsSync(backupPath)).toBe(true);
      expect(JSON.parse(fs.readFileSync(backupPath, 'utf-8'))).toEqual(seeded);
      // The backup holds the same credentials as config.json: it must be
      // 0600, never the umask default (audit H-11 class).
      expect(fs.statSync(backupPath).mode & 0o777).toBe(0o600);
    });
  });

  describe('multi-tier deployments (docker, compose, k3d) & runtime config sync', () => {
    const origRuntimeDir = process.env.ELUVIX_RUNTIME_CONFIG_DIR;
    const origSwToken = process.env.SWITCHYARD_AUTH_TOKEN;
    const origXdgConfig = process.env.XDG_CONFIG_HOME;
    const origXdgData = process.env.XDG_DATA_HOME;
    let tempDirs: string[] = [];

    function makeTempDir(prefix: string): string {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
      tempDirs.push(dir);
      return dir;
    }

    function okCmd(command: string, args: string[], stdout = ''): CommandExecutionResult {
      return { command, args, exitCode: 0, stdout, stderr: '', success: true, durationMs: 5 };
    }

    afterEach(() => {
      vi.restoreAllMocks();
      if (origRuntimeDir === undefined) delete process.env.ELUVIX_RUNTIME_CONFIG_DIR;
      else process.env.ELUVIX_RUNTIME_CONFIG_DIR = origRuntimeDir;
      if (origSwToken === undefined) delete process.env.SWITCHYARD_AUTH_TOKEN;
      else process.env.SWITCHYARD_AUTH_TOKEN = origSwToken;
      if (origXdgConfig === undefined) delete process.env.XDG_CONFIG_HOME;
      else process.env.XDG_CONFIG_HOME = origXdgConfig;
      if (origXdgData === undefined) delete process.env.XDG_DATA_HOME;
      else process.env.XDG_DATA_HOME = origXdgData;
      for (const dir of tempDirs) {
        fs.rmSync(dir, { recursive: true, force: true });
      }
      tempDirs = [];
    });

    it('getComposeServicesForConfig excludes non-compose host engines (ramalama, comfyui) and includes opencode', () => {
      const svcs = getComposeServicesForConfig({
        strategy: 'cost-complexity',
        upstreams: [
          { id: 'r1', name: 'RamaLama', type: 'ramalama', endpoint: 'http://127.0.0.1:8085/v1', models: ['*'] },
          { id: 'c1', name: 'ComfyUI', type: 'comfyui', endpoint: 'http://127.0.0.1:8188', models: ['flux'] },
          { id: 'o1', name: 'Ollama', type: 'ollama', endpoint: 'http://127.0.0.1:11434/v1', models: ['llama3.2'] },
          {
            id: 'h1',
            name: 'OpenCode',
            type: 'harness',
            endpoint: 'http://127.0.0.1:4096',
            models: ['*'],
            harness: { kind: 'opencode' }
          }
        ]
      } as any);
      expect(svcs).toContain('ollama');
      expect(svcs).toContain('opencode');
      expect(svcs).not.toContain('ramalama');
      expect(svcs).not.toContain('comfyui');
      expect(svcs).not.toContain('sglang');
    });

    it('docker tier writes secret-redacted runtime bundle, deploys only minimal topology containers, and sends auth header to Switchyard', async () => {
      const runtimeDir = makeTempDir('eluvix-runtime-docker-');
      process.env.ELUVIX_RUNTIME_CONFIG_DIR = runtimeDir;
      process.env.SWITCHYARD_AUTH_TOKEN = 'test-sw-token-123';

      const commands: Array<{ cmd: string; args: string[] }> = [];
      vi.spyOn(orchestratorManager, 'runCommand').mockImplementation(async (cmd, args) => {
        commands.push({ cmd, args });
        if (cmd === 'docker' && args[0] === 'info') return okCmd(cmd, args, '27.0.0');
        if (cmd === 'bash' && args.includes('detect')) return okCmd(cmd, args, '{"vendor":"amd","model":"Radeon"}');
        if (cmd === 'docker' && args[0] === 'compose') return okCmd(cmd, args, 'Container eluvix-switchyard Recreated');
        return okCmd(cmd, args);
      });

      const fetchCalls: Array<{ url: string; headers?: any }> = [];
      vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
        const url = String(input);
        fetchCalls.push({ url, headers: init?.headers });
        return new Response(JSON.stringify({ status: 'ok', success: true }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' }
        });
      });

      const sampleConfig = {
        strategy: 'cost-complexity',
        upstreams: [
          {
            id: 'ollama-1',
            name: 'Local Ollama',
            type: 'ollama',
            endpoint: 'http://127.0.0.1:11434/v1',
            apiKey: 'sk-super-secret-must-not-leak',
            models: ['llama3.2']
          }
        ]
      };

      const res = await orchestratorManager.deploy({
        tier: 'docker',
        compiledConfigs: {
          rawRouterConfig: sampleConfig,
          eluvixJson: JSON.stringify(sampleConfig),
          bifrostYaml: 'routing_strategy: cost-complexity\n',
          agentRouterJson: JSON.stringify({ preference: 'speed' }),
          agentGatewayJson: JSON.stringify({ accessPolicy: 'restrictive' })
        }
      });

      expect(res.success).toBe(true);
      expect(res.tier).toBe('docker');

      // Runtime bundle written with zero raw API keys
      const mountedEluvix = fs.readFileSync(path.join(runtimeDir, 'eluvix.json'), 'utf-8');
      expect(mountedEluvix).not.toContain('sk-super-secret-must-not-leak');
      expect(JSON.parse(mountedEluvix).upstreams[0].apiKeyConfigured).toBe(true);
      expect(fs.readFileSync(path.join(runtimeDir, 'bifrost.yaml'), 'utf-8')).toContain('cost-complexity');
      expect(JSON.parse(fs.readFileSync(path.join(runtimeDir, 'routing.json'), 'utf-8')).preference).toBe('speed');
      expect(JSON.parse(fs.readFileSync(path.join(runtimeDir, 'gateway.json'), 'utf-8')).accessPolicy).toBe('restrictive');

      // Only topology containers + switchyard were launched (no sglang!)
      const composeCall = commands.find((c) => c.cmd === 'docker' && c.args[0] === 'compose');
      expect(composeCall).toBeDefined();
      expect(composeCall!.args).toContain('switchyard');
      expect(composeCall!.args).toContain('ollama');
      expect(composeCall!.args).toContain('--force-recreate');
      expect(composeCall!.args).not.toContain('sglang');

      // Switchyard live sync included Bearer token
      const swPush = fetchCalls.find((c) => c.url.includes(':8080/v1/config'));
      expect(swPush).toBeDefined();
      expect((swPush!.headers as Record<string, string>)['Authorization']).toBe('Bearer test-sw-token-123');
    });

    it('compose tier syncs core + topology + already-running containers without pulling unused sglang', async () => {
      const runtimeDir = makeTempDir('eluvix-runtime-compose-');
      process.env.ELUVIX_RUNTIME_CONFIG_DIR = runtimeDir;

      const commands: Array<{ cmd: string; args: string[] }> = [];
      vi.spyOn(orchestratorManager, 'runCommand').mockImplementation(async (cmd, args) => {
        commands.push({ cmd, args });
        if (cmd === 'docker' && args[0] === 'info') return okCmd(cmd, args, '27.0.0');
        if (cmd === 'bash' && args.includes('detect')) return okCmd(cmd, args, '{"vendor":"amd","model":"Radeon"}');
        if (cmd === 'docker' && args[0] === 'ps') {
          return okCmd(cmd, args, 'eluvix-switchyard\neluvix-openviking\neluvix-ollama\n');
        }
        if (cmd === 'docker' && args[0] === 'compose') return okCmd(cmd, args, 'Stack updated');
        return okCmd(cmd, args);
      });

      vi.spyOn(globalThis, 'fetch').mockResolvedValue(
        new Response(JSON.stringify({ status: 'ok' }), { status: 200, headers: { 'Content-Type': 'application/json' } })
      );

      const sampleConfig = {
        strategy: 'lowest-latency',
        upstreams: [
          { id: 'vllm-1', name: 'vLLM', type: 'vllm', endpoint: 'http://127.0.0.1:8000/v1', models: ['qwen'] }
        ]
      };

      const res = await orchestratorManager.deploy({
        tier: 'compose',
        compiledConfigs: {
          rawRouterConfig: sampleConfig,
          eluvixJson: JSON.stringify(sampleConfig),
          bifrostYaml: 'routing_strategy: lowest-latency\n'
        }
      });

      expect(res.success).toBe(true);
      expect(res.tier).toBe('compose');
      expect(fs.existsSync(path.join(runtimeDir, 'eluvix.json'))).toBe(true);

      const composeCall = commands.find((c) => c.cmd === 'docker' && c.args[0] === 'compose');
      expect(composeCall).toBeDefined();
      // Core + topology (vllm) + running (openviking, ollama) included; unused sglang excluded
      for (const expectedSvc of ['switchyard', 'vllm-sr', 'agent-router', 'agentgateway', 'vllm', 'openviking', 'ollama']) {
        expect(composeCall!.args).toContain(expectedSvc);
      }
      expect(composeCall!.args).not.toContain('sglang');
    });

    it('k3d tier validates config, starts stopped cluster or imports images on create, and deploys redacted Helm values', async () => {
      // 1. Refuses empty upstream graph BEFORE shelling out
      const runSpy = vi.spyOn(orchestratorManager, 'runCommand');
      const invalidRes = await orchestratorManager.deploy({
        tier: 'k3d',
        compiledConfigs: { rawRouterConfig: { upstreams: [] }, eluvixJson: '{"upstreams":[]}' }
      });
      expect(invalidRes.success).toBe(false);
      expect(runSpy).not.toHaveBeenCalled();

      // 2. Existing stopped cluster -> starts cluster, creates missing namespace, runs helm upgrade --wait
      const commands: Array<{ cmd: string; args: string[] }> = [];
      let capturedTempValuesContent = '';
      runSpy.mockImplementation(async (cmd, args) => {
        commands.push({ cmd, args });
        if (cmd === 'k3d' && args[0] === 'cluster' && args[1] === 'list') {
          return okCmd(cmd, args, 'eluvix-local   0/1   0/2   true\n');
        }
        if (cmd === 'kubectl' && args[0] === 'cluster-info') {
          return { command: cmd, args, exitCode: 1, stdout: '', stderr: 'connection refused', success: false, durationMs: 5 };
        }
        if (cmd === 'kubectl' && args[0] === 'get' && args[1] === 'namespace') {
          return { command: cmd, args, exitCode: 1, stdout: '', stderr: 'NotFound', success: false, durationMs: 5 };
        }
        if (cmd === 'helm' && args[0] === 'upgrade') {
          const tempIdx = args.lastIndexOf('-f');
          if (tempIdx >= 0 && args[tempIdx + 1] && fs.existsSync(args[tempIdx + 1])) {
            capturedTempValuesContent = fs.readFileSync(args[tempIdx + 1], 'utf-8');
          }
          return okCmd(cmd, args, 'Release "eluvix" has been upgraded.');
        }
        return okCmd(cmd, args, 'ok');
      });

      const validCfg = {
        strategy: 'cost-complexity',
        upstreams: [
          {
            id: 'openai-1',
            name: 'OpenAI',
            type: 'openai',
            endpoint: 'https://api.openai.com/v1',
            apiKey: 'sk-live-secret-k3d-never-in-configmap',
            models: ['gpt-4o']
          }
        ]
      };

      const res = await orchestratorManager.deploy({
        tier: 'k3d',
        compiledConfigs: {
          rawRouterConfig: validCfg,
          eluvixJson: JSON.stringify(validCfg),
          bifrostYaml: 'routing_strategy: cost-complexity\n',
          agentRouterJson: '{"preference":"balanced"}',
          agentGatewayJson: '{"accessPolicy":"restrictive"}'
        }
      });

      expect(res.success).toBe(true);
      expect(res.tier).toBe('k3d');
      expect(commands.some((c) => c.cmd === 'k3d' && c.args[0] === 'cluster' && c.args[1] === 'start')).toBe(true);
      expect(commands.some((c) => c.cmd === 'kubectl' && c.args[0] === 'create' && c.args[1] === 'namespace')).toBe(true);
      expect(commands.some((c) => c.cmd === 'bash')).toBe(false);
      const helmCmd = commands.find((c) => c.cmd === 'helm' && c.args[0] === 'upgrade');
      expect(helmCmd).toBeDefined();
      expect(helmCmd!.args).toContain('--wait');
      // Redacted values injected into Helm ConfigMap — zero raw API keys
      expect(capturedTempValuesContent).toContain('openai-1');
      expect(capturedTempValuesContent).not.toContain('sk-live-secret-k3d-never-in-configmap');
    });

    it('POST /api/v1/config?authoritative=1 drops removed optional blocks while preserving egressPolicy and POST /api/orchestrator/deploy blocks readonly callers', async () => {
      const xdgCfg = makeTempDir('eluvix-cfg-auth-');
      const xdgData = makeTempDir('eluvix-data-auth-');
      process.env.XDG_CONFIG_HOME = xdgCfg;
      process.env.XDG_DATA_HOME = xdgData;
      process.env.ADMIN_PASSWORD = 'orch-test-admin-pw';

      const configRoute = await import('@/app/api/v1/config/route');
      const deployRoute = await import('@/app/api/orchestrator/deploy/route');
      const core = await import('@eluvix/router-core');

      // Seed config with egressPolicy + memory
      const seedRes = await configRoute.POST(
        new Request('http://127.0.0.1:3588/api/v1/config', {
          method: 'POST',
          headers: {
            Authorization: 'Bearer orch-test-admin-pw',
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({
            upstreams: [
              { id: 'u1', name: 'Ollama', type: 'ollama', endpoint: 'http://127.0.0.1:11434/v1', models: ['m1'] }
            ],
            egressPolicy: 'local-only',
            memory: { enabled: true, provider: 'openviking' }
          })
        })
      );
      expect(seedRes.status).toBe(200);

      // Authoritative editor apply WITHOUT memory removes memory while preserving egressPolicy
      const authRes = await configRoute.POST(
        new Request('http://127.0.0.1:3588/api/v1/config?authoritative=1', {
          method: 'POST',
          headers: {
            Authorization: 'Bearer orch-test-admin-pw',
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({
            upstreams: [
              { id: 'u2', name: 'Ollama 2', type: 'ollama', endpoint: 'http://127.0.0.1:11434/v1', models: ['m2'] }
            ]
          })
        })
      );
      expect(authRes.status).toBe(200);
      const authJson = await authRes.json();
      expect(authJson.config.upstreams.map((u: any) => u.id)).toEqual(['u2']);
      expect(authJson.config.memory).toBeUndefined();
      expect(authJson.config.egressPolicy).toBe('local-only');

      // Readonly key cannot deploy via /api/orchestrator/deploy
      const roKey = core.createNamedApiKey({
        label: 'readonly-deploy-check',
        userId: 'ro-user',
        role: 'readonly'
      }).key;
      const blockedDeploy = await deployRoute.POST(
        new Request('http://127.0.0.1:3588/api/orchestrator/deploy', {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${roKey}`,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({ tier: 'local', compiledConfigs: {} })
        })
      );
      expect(blockedDeploy.status).toBe(403);
    });
  });
});
