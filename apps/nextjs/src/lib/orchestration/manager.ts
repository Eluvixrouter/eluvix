import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { executeSafeCommand } from './executor';
import { getCachedAntigravityModels, inferModelMetadata, getAppPaths, createNamedApiKey, listNamedApiKeys, resolveBearerToken, revokeNamedApiKey } from '@eluvix/router-core';
import { getConfigPath, redactConfigForApi, saveConfig, validateConfig } from '@/lib/router';
import {
  DOCKER_SERVICE_CATALOG,
  getComposeServiceCatalog,
  getComposeServicesForConfig,
  getServicesByCategory
} from '@/lib/docker-catalog';

export type DeploymentTier = 'local' | 'docker' | 'compose' | 'k3d';

export interface DeploymentRequest {
  tier: DeploymentTier;
  compiledConfigs: {
    eluvixJson?: string;
    bifrostYaml?: string;
    agentRouterJson?: string;
    agentGatewayJson?: string;
    rawRouterConfig?: any;
    [key: string]: any;
  };
}

export interface DeploymentResponse {
  success: boolean;
  tier: DeploymentTier;
  message: string;
  logs: string[];
  durationMs: number;
}

export class OrchestrationManager {
  private repoRoot: string;
  public runCommand = executeSafeCommand;

  constructor() {
    // Determine repo root (eluvix root directory)
    this.repoRoot = path.resolve(process.cwd(), '..', '..');
    // If running inside root already:
    if (fs.existsSync(path.join(process.cwd(), 'helm', 'eluvix'))) {
      this.repoRoot = process.cwd();
    } else if (fs.existsSync(path.join(process.cwd(), '..', 'helm', 'eluvix'))) {
      this.repoRoot = path.resolve(process.cwd(), '..');
    }
  }

  public getRepoRoot(): string {
    return this.repoRoot;
  }

  /**
   * Retrieves status across all 4 deployment levels
   */
  public async getStatus() {
    // 1. Check CLI Toolchains
    const tools = {
      docker: false,
      k3d: false,
      kubectl: false,
      helm: false
    };

    try {
      const d = await executeSafeCommand('docker', ['--version'], { timeoutMs: 3000 });
      tools.docker = d.success;
    } catch {}

    try {
      const k = await executeSafeCommand('k3d', ['version'], { timeoutMs: 3000 });
      tools.k3d = k.success;
    } catch {}

    try {
      const kc = await executeSafeCommand('kubectl', ['version', '--client', '-o', 'json'], { timeoutMs: 3000 });
      tools.kubectl = kc.success;
    } catch {}

    try {
      const h = await executeSafeCommand('helm', ['version', '--short'], { timeoutMs: 3000 });
      tools.helm = h.success;
    } catch {}

    // 2. Check k3d cluster
    const k3dStatus = {
      exists: false,
      running: false,
      clusterName: 'eluvix-local',
      context: 'k3d-eluvix-local',
      nodesCount: 0,
      releaseStatus: 'not_installed',
      pods: [] as any[]
    };

    if (tools.k3d) {
      try {
        const list = await executeSafeCommand('k3d', ['cluster', 'list', '--no-headers'], { timeoutMs: 5000 });
        if (list.stdout.includes('eluvix-local')) {
          k3dStatus.exists = true;
          if (tools.kubectl) {
            const clusterInfo = await executeSafeCommand('kubectl', ['cluster-info', '--context', 'k3d-eluvix-local'], { timeoutMs: 5000 });
            k3dStatus.running = clusterInfo.success;

            if (k3dStatus.running) {
              const nodesOut = await executeSafeCommand('kubectl', ['get', 'nodes', '--context', 'k3d-eluvix-local', '-o', 'json'], { timeoutMs: 5000 });
              if (nodesOut.success) {
                const nodesJson = JSON.parse(nodesOut.stdout || '{}');
                k3dStatus.nodesCount = nodesJson.items?.length || 0;
              }

              const podsOut = await executeSafeCommand('kubectl', ['get', 'pods', '-n', 'eluvix', '--context', 'k3d-eluvix-local', '-o', 'json'], { timeoutMs: 5000 });
              if (podsOut.success) {
                const podsJson = JSON.parse(podsOut.stdout || '{}');
                k3dStatus.pods = (podsJson.items || []).map((p: any) => ({
                  name: p.metadata?.name,
                  phase: p.status?.phase,
                  ready: p.status?.containerStatuses?.[0]?.ready ?? false,
                  restarts: p.status?.containerStatuses?.[0]?.restartCount ?? 0,
                  component: p.metadata?.labels?.['app.kubernetes.io/component'] || 'service'
                }));
              }

              if (tools.helm) {
                const helmOut = await executeSafeCommand('helm', ['status', 'eluvix', '-n', 'eluvix', '--kube-context', 'k3d-eluvix-local'], { timeoutMs: 5000 });
                if (helmOut.success) {
                  k3dStatus.releaseStatus = 'deployed';
                }
              }
            }
          }
        }
      } catch (e) {
        console.warn('Error reading k3d status:', e);
      }
    }

    // 3. Check Docker Compose
    const composeCatalog = getComposeServiceCatalog();
    const composeStatus = {
      running: false,
      activeServices: 0,
      totalServices: composeCatalog.length,
      services: [] as any[]
    };

    if (tools.docker) {
      try {
        const psOut = await executeSafeCommand('docker', ['ps', '--format', '{{.Names}}'], { timeoutMs: 4000 });
        const runningNames = psOut.stdout.split('\n').map(s => s.trim()).filter(Boolean);

        composeStatus.services = composeCatalog.map(entry => {
          const isRunning = runningNames.includes(entry.container);
          return {
            name: entry.container,
            service: entry.name,
            category: entry.category,
            running: isRunning,
            status: isRunning ? 'running' : 'stopped'
          };
        });

        composeStatus.activeServices = composeStatus.services.filter(s => s.running).length;
        composeStatus.running = composeStatus.activeServices > 0;
      } catch (e) {
        console.warn('Error reading compose status:', e);
      }
    }

    // 4. Check Local Host config
    const isTest = process.env.NODE_ENV === 'test' || Boolean(process.env.VITEST);
    const localConfigPath = isTest
      ? path.join(os.tmpdir(), 'eluvix-test-config', 'config.json')
      : getConfigPath();
    const localStatus = {
      configExists: fs.existsSync(localConfigPath),
      configPath: localConfigPath,
      lastModified: fs.existsSync(localConfigPath) ? fs.statSync(localConfigPath).mtime.toISOString() : null
    };

    return {
      tools,
      k3d: k3dStatus,
      compose: composeStatus,
      local: localStatus
    };
  }

  /**
   * Dispatches deployment across chosen tier
   */
  public async deploy(req: DeploymentRequest): Promise<DeploymentResponse> {
    const startTime = Date.now();
    const logs: string[] = [];

    switch (req.tier) {
      case 'local':
        return await this.deployLocal(req, logs, startTime);
      case 'docker':
        return await this.deployDocker(req, logs, startTime);
      case 'compose':
        return await this.deployCompose(req, logs, startTime);
      case 'k3d':
        return await this.deployK3d(req, logs, startTime);
      default:
        throw new Error(`Unsupported deployment tier: ${(req as any).tier}`);
    }
  }

  /**
   * Parses and validates the compiled RouterConfig from a DeploymentRequest
   * before any disk, container, or Kubernetes state is mutated.
   */
  private resolveAndValidateConfig(
    req: DeploymentRequest,
    logs: string[]
  ): { ok: true; config: any } | { ok: false; error: string } {
    let configData: any;
    try {
      configData =
        req.compiledConfigs?.rawRouterConfig ||
        JSON.parse(req.compiledConfigs?.eluvixJson || '{}');
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logs.push(`✗ Failed to parse compiled router config JSON: ${message}`);
      return { ok: false, error: `Invalid compiled JSON: ${message}` };
    }

    // An empty graph is a total routing outage — refuse it as a failed deploy
    // rather than reporting success with zero upstreams. Checked before
    // validateConfig so the deploy keeps its own message (validateConfig
    // refuses empty upstreams too, covering the config-POST/Apply path).
    if (Array.isArray(configData.upstreams) && configData.upstreams.length === 0) {
      logs.push('✗ Refusing to deploy an empty upstream graph (zero upstreams would leave the router unable to route)');
      return { ok: false, error: 'upstreams must contain at least one upstream' };
    }

    try {
      validateConfig(configData);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logs.push(`✗ Refusing to deploy invalid configuration: ${message}`);
      return { ok: false, error: message };
    }

    return { ok: true, config: configData };
  }

  /**
   * Authoritatively persists the validated RouterConfig to the host config
   * file (with 0o600 .bak backup & rollback), reloads the in-memory router,
   * and synchronizes OpenCode's provider model catalog.
   */
  private persistAuthoritativeLocalConfig(
    mergedConfig: any,
    logs: string[]
  ): { ok: true; targetFile: string; configDir: string } | { ok: false; error: string } {
    const isTest = process.env.NODE_ENV === 'test' || Boolean(process.env.VITEST);
    const targetFile = isTest
      ? path.join(os.tmpdir(), 'eluvix-test-config', 'config.json')
      : getConfigPath();
    const configDir = path.dirname(targetFile);
    fs.mkdirSync(configDir, { recursive: true });

    // Back up the previous config before overwriting (same .bak precedent
    // as configurator/apply), so a failed deploy never destroys it.
    let backupFile: string | null = null;
    if (fs.existsSync(targetFile)) {
      backupFile = `${targetFile}.bak`;
      try {
        fs.copyFileSync(targetFile, backupFile);
        // copyFileSync does not preserve the source mode: the backup holds
        // the same credentials as config.json, so it must be 0600, not the
        // umask default (audit H-11 class — backups at default modes).
        fs.chmodSync(backupFile, 0o600);
        logs.push(`✓ Backed up previous router config to ${backupFile}`);
      } catch {
        backupFile = null;
      }
    }

    fs.writeFileSync(targetFile, JSON.stringify(mergedConfig, null, 2), { encoding: 'utf-8', mode: 0o600 });
    logs.push(`✓ Written active router config to ${targetFile}`);

    try {
      if (!isTest) {
        saveConfig(mergedConfig);
        logs.push(`✓ Saved and reloaded active router configuration`);
      }
    } catch (err) {
      // The on-disk file must never hold a config the router refused:
      // restore the backup and report failure, not success.
      if (backupFile && fs.existsSync(backupFile)) {
        try {
          fs.copyFileSync(backupFile, targetFile);
          logs.push('↩ Restored previous router config from backup after validation failure');
        } catch {}
      }
      const message = err instanceof Error ? err.message : String(err);
      logs.push(`✗ Failed to save and reload active router configuration: ${message}`);
      return { ok: false, error: message };
    }

    // Synchronize active Eluvix models & auth into OpenCode config (~/.config/opencode/opencode.json)
    try {
      const openCodeTarget = isTest
        ? path.join(configDir, 'opencode.json')
        : path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), 'opencode', 'opencode.json');
      this.syncOpenCodeConfig(mergedConfig, configDir, openCodeTarget, logs);
    } catch (syncErr) {
      console.warn('Could not sync OpenCode config:', syncErr);
    }

    return { ok: true, targetFile, configDir };
  }

  /**
   * Resolves the directory where secret-redacted runtime artifacts for Docker
   * Compose containers (eluvix.json, bifrost.yaml, routing.json, gateway.json)
   * are written and mounted read-only into /config.
   */
  public getRuntimeConfigDir(): string {
    if (process.env.ELUVIX_RUNTIME_CONFIG_DIR) {
      return process.env.ELUVIX_RUNTIME_CONFIG_DIR;
    }
    const isTest = process.env.NODE_ENV === 'test' || Boolean(process.env.VITEST);
    if (isTest) {
      return path.join(os.tmpdir(), 'eluvix-test-runtime-config');
    }
    return path.join(this.repoRoot, 'docker', 'runtime-config');
  }

  /**
   * Writes secret-redacted runtime config artifacts for mounted Docker
   * containers (switchyard, agent-router, agentgateway). Raw API keys and
   * HMAC literals are stripped via redactConfigForApi so mounted files carry
   * zero raw credentials while containers run as unprivileged `node`.
   * Hunt-3 C-M4: bifrost.yaml is written 0600, not 0644 — even though its
   * api_key entries are now env-var references (see
   * bifrostApiKeyReference in compiler.ts), a mounted group-readable file
   * must not be the place a credential-adjacent value lives.
   */
  public writeDockerRuntimeConfigs(
    req: DeploymentRequest,
    validatedConfig: any,
    logs: string[]
  ): string {
    const runtimeDir = this.getRuntimeConfigDir();
    fs.mkdirSync(runtimeDir, { recursive: true });

    const redactedRouter = redactConfigForApi(validatedConfig);
    const written: string[] = [];

    const writeArtifact = (filename: string, content: string, mode = 0o644) => {
      const fullPath = path.join(runtimeDir, filename);
      fs.writeFileSync(fullPath, content, { encoding: 'utf-8', mode });
      // writeFileSync's mode is creation-only: tighten a pre-existing
      // loose file the same way (hunt-3 C-M4 / C-L19 class).
      try {
        fs.chmodSync(fullPath, mode);
      } catch {}
      written.push(filename);
    };

    writeArtifact('eluvix.json', JSON.stringify(redactedRouter, null, 2));
    if (typeof req.compiledConfigs?.bifrostYaml === 'string' && req.compiledConfigs.bifrostYaml.trim()) {
      writeArtifact('bifrost.yaml', req.compiledConfigs.bifrostYaml, 0o600);
    }
    writeArtifact(
      'routing.json',
      typeof req.compiledConfigs?.agentRouterJson === 'string' && req.compiledConfigs.agentRouterJson.trim()
        ? req.compiledConfigs.agentRouterJson
        : '{}'
    );
    writeArtifact(
      'gateway.json',
      typeof req.compiledConfigs?.agentGatewayJson === 'string' && req.compiledConfigs.agentGatewayJson.trim()
        ? req.compiledConfigs.agentGatewayJson
        : '{}'
    );

    logs.push(`✓ Written mounted container runtime configs (${written.join(', ')}) to ${runtimeDir}`);
    return runtimeDir;
  }

  /**
   * Best-effort live push to the local Switchyard proxy (port 8080) with
   * Bearer auth when configured and a bounded 3s timeout.
   */
  private async syncLiveSwitchyard(validatedConfig: any, logs: string[]): Promise<void> {
    const swPort = process.env.SWITCHYARD_PORT || '8080';
    const token = (process.env.SWITCHYARD_AUTH_TOKEN || process.env.ADMIN_PASSWORD || '').trim();
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (token) {
      headers['Authorization'] = `Bearer ${token}`;
    }

    try {
      const res = await fetch(`http://127.0.0.1:${swPort}/v1/config`, {
        method: 'POST',
        headers,
        body: JSON.stringify(redactConfigForApi(validatedConfig)),
        signal: AbortSignal.timeout(3000)
      });
      if (res.ok) {
        logs.push(`✓ Live local Switchyard balancer (port ${swPort}) synchronized successfully.`);
      } else if (res.status === 503) {
        logs.push(
          `ℹ️ Local Switchyard (port ${swPort}) config API disabled (no SWITCHYARD_AUTH_TOKEN set); mounted /config/eluvix.json reloads automatically.`
        );
      } else {
        logs.push(
          `ℹ️ Local Switchyard server (port ${swPort}) returned HTTP ${res.status}. Mounted /config/eluvix.json and host config remain authoritative.`
        );
      }
    } catch {
      logs.push(
        `ℹ️ No local Switchyard HTTP endpoint detected on port ${swPort}. Config saved to disk for next launch.`
      );
    }
  }

  /**
   * Polls health endpoints for deployed compose services with a bounded
   * timeout so deployment reports genuine container readiness.
   */
  private async waitForComposeServicesHealth(
    services: string[],
    logs: string[],
    timeoutMs = 45000
  ): Promise<{ healthy: string[]; unhealthy: string[] }> {
    const catalogByName = new Map(DOCKER_SERVICE_CATALOG.map((s) => [s.name, s]));
    const checkable = services
      .map((name) => catalogByName.get(name))
      .filter((entry): entry is NonNullable<typeof entry> => Boolean(entry && entry.name !== 'sglang'));

    const pending = new Set(checkable.map((e) => e.name));
    const healthy: string[] = [];
    const deadline = Date.now() + timeoutMs;

    while (pending.size > 0 && Date.now() < deadline) {
      for (const name of Array.from(pending)) {
        const entry = catalogByName.get(name)!;
        const probeUrl =
          name === 'ollama'
            ? `http://127.0.0.1:${entry.port}/api/tags`
            : `http://127.0.0.1:${entry.port}/health`;
        try {
          const res = await fetch(probeUrl, { signal: AbortSignal.timeout(2000) });
          if (res.ok) {
            pending.delete(name);
            healthy.push(name);
          }
        } catch {
          // still starting
        }
      }
      if (pending.size > 0 && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 1500));
      }
    }

    const unhealthy = Array.from(pending);
    if (healthy.length > 0) {
      logs.push(`✓ Verified healthy containers: ${healthy.join(', ')}`);
    }
    if (unhealthy.length > 0) {
      logs.push(`⚠️ Containers still starting or unhealthy after ${Math.round(timeoutMs / 1000)}s: ${unhealthy.join(', ')}`);
    }
    return { healthy, unhealthy };
  }

  /**
   * Runs GPU hardware detection (NVIDIA CUDA / AMD ROCm / CPU) non-fatally so
   * docker-compose.override.yml matches the host before spinning up containers.
   */
  private async detectHostGpuForDocker(logs: string[]): Promise<void> {
    const scriptPath = path.join(this.repoRoot, 'scripts', 'docker-detect-and-spinup.sh');
    if (!fs.existsSync(scriptPath)) return;
    try {
      const detect = await this.runCommand('bash', [scriptPath, 'detect', '--json'], {
        cwd: this.repoRoot,
        timeoutMs: 15000
      });
      if (detect.success && detect.stdout.trim()) {
        try {
          const hw = JSON.parse(detect.stdout.trim());
          logs.push(`✓ Hardware acceleration profile: ${hw.vendor || 'cpu'} (${hw.model || 'CPU'})`);
        } catch {
          logs.push(`✓ Hardware detection completed.`);
        }
      }
    } catch {
      logs.push('ℹ️ Hardware detection skipped (non-fatal).');
    }
  }

  /**
   * Level 1: Local Host Binaries
   */
  private async deployLocal(req: DeploymentRequest, logs: string[], startTime: number): Promise<DeploymentResponse> {
    logs.push('[Level 1: Local] Preparing local configuration deployment...');
    const validated = this.resolveAndValidateConfig(req, logs);
    if (!validated.ok) {
      return {
        success: false,
        tier: 'local',
        message: `Local deployment refused: ${validated.error}`,
        logs,
        durationMs: Date.now() - startTime
      };
    }

    const persisted = this.persistAuthoritativeLocalConfig(validated.config, logs);
    if (!persisted.ok) {
      return {
        success: false,
        tier: 'local',
        message: `Local deployment failed: ${persisted.error}`,
        logs,
        durationMs: Date.now() - startTime
      };
    }

    // Keep mounted container configs fresh too if runtime-config is already active
    const existingRuntimeEluvix = path.join(this.getRuntimeConfigDir(), 'eluvix.json');
    if (fs.existsSync(existingRuntimeEluvix)) {
      this.writeDockerRuntimeConfigs(req, validated.config, logs);
    }

    await this.syncLiveSwitchyard(validated.config, logs);

    return {
      success: true,
      tier: 'local',
      message: `Local configuration deployed successfully to ${persisted.targetFile}`,
      logs,
      durationMs: Date.now() - startTime
    };
  }

  /**
   * Synchronizes active Eluvix upstreams, models, context limits, and auth token
   * into OpenCode's configuration file (~/.config/opencode/opencode.json).
   * The Eluvix provider's model map is authoritative — it mirrors the current
   * router config exactly, so models of removed upstreams disappear instead of
   * lingering in OpenCode forever. Everything else in the file (other
   * providers, user settings) is preserved.
   */
  public syncOpenCodeConfig(
    routerConfig: any,
    eluvixConfigDir: string,
    openCodePath: string,
    logs: string[] = []
  ): void {
    let existingOpenCode: any = {
      $schema: 'https://opencode.ai/config.json',
      autoupdate: false,
      model: 'Eluvix/auto',
      small_model: 'Eluvix/auto',
      provider: {}
    };

    if (fs.existsSync(openCodePath)) {
      try {
        existingOpenCode = JSON.parse(fs.readFileSync(openCodePath, 'utf-8'));
      } catch {}
    }

    // Hunt-3 C-M3: the OpenCode provider authenticates with a scoped
    // `configurator:opencode` named key — the same key configurator/apply
    // mints — NEVER the admin password. The old code resolved apiKey from
    // auth.json.adminPassword and overwrote the scoped key on every deploy,
    // re-installing the master password into a client config (audit
    // H-10/H-11). Reuse the key already in opencode.json while it still
    // resolves; otherwise mint a fresh scoped key and revoke stale ones
    // with the same label once the new config is safely on disk.
    const opencodeKeyLabel = 'configurator:opencode';
    let apiKey: string | undefined;
    let staleOpencodeKeyIds: string[] = [];
    const existingKey = existingOpenCode?.provider?.Eluvix?.options?.apiKey;
    if (typeof existingKey === 'string' && existingKey.startsWith('elx_')) {
      try {
        if (resolveBearerToken(existingKey).valid) apiKey = existingKey;
      } catch {}
    }
    if (!apiKey) {
      try {
        staleOpencodeKeyIds = listNamedApiKeys()
          .filter((k) => k.label === opencodeKeyLabel)
          .map((k) => k.id);
        apiKey = createNamedApiKey({ label: opencodeKeyLabel, origin: 'client', userId: 'client-opencode' }).key;
      } catch {
        apiKey = undefined;
      }
    }

    if (!existingOpenCode.provider || typeof existingOpenCode.provider !== 'object') {
      existingOpenCode.provider = {};
    }

    const existingEluvix = existingOpenCode.provider.Eluvix || {};
    const existingModels: Record<string, any> = {
      ...(existingEluvix.models || {})
    };

    // The Eluvix provider's model map is authoritative: it is rebuilt from
    // the current router config on every sync, so a model whose upstream was
    // removed from the router disappears from OpenCode instead of lingering
    // (previously only a hardcoded list of retired Gemini models was ever
    // purged, so e.g. gemini-4-argon survived removal of the AGY upstream).
    // Entries for models that are still served keep user customizations.
    const syncedModels: Record<string, any> = {
      auto: existingModels['auto'] || {
        name: 'Auto (Intelligent Mesh Router)',
        limit: { context: 131072, output: 8192 }
      }
    };

    const upstreams = Array.isArray(routerConfig?.upstreams) ? routerConfig.upstreams : [];
    const agyCatalog = getCachedAntigravityModels();

    for (const upstream of upstreams) {
      const upstreamModels: string[] = Array.isArray(upstream.models) ? [...upstream.models] : [];
      if (upstream.type === 'antigravity') {
        for (const agyEntry of agyCatalog) {
          if (!upstreamModels.includes(agyEntry.baseId)) {
            upstreamModels.push(agyEntry.baseId);
          }
        }
      }

      for (const modelId of upstreamModels) {
        if (!modelId || modelId === '*' || modelId === 'auto') continue;
        if (syncedModels[modelId]) continue;
        if (existingModels[modelId]) {
          syncedModels[modelId] = existingModels[modelId];
          continue;
        }

        const agyMatch = agyCatalog.find(a => a.baseId.toLowerCase() === modelId.toLowerCase());
        if (agyMatch) {
          syncedModels[modelId] = {
            name: `${agyMatch.displayName} (Google Antigravity AGY)`,
            limit: {
              context: agyMatch.contextLimit,
              output: agyMatch.outputLimit
            }
          };
        } else {
          const meta = inferModelMetadata(modelId);
          syncedModels[modelId] = {
            name: `${modelId} (${upstream.name || upstream.type || 'Eluvix'})`,
            limit: {
              context: meta.contextLimit,
              output: meta.outputLimit
            }
          };
        }
      }
    }

    existingOpenCode.provider.Eluvix = {
      ...existingEluvix,
      name: existingEluvix.name || 'Eluvix Router (local)',
      npm: existingEluvix.npm || '@ai-sdk/openai-compatible',
      options: {
        ...(existingEluvix.options || {}),
        ...(apiKey ? { apiKey } : {}),
        baseURL: existingEluvix?.options?.baseURL || 'http://127.0.0.1:3580/api/v1'
      },
      models: syncedModels
    };

    fs.mkdirSync(path.dirname(openCodePath), { recursive: true });
    fs.writeFileSync(openCodePath, JSON.stringify(existingOpenCode, null, 2), { encoding: 'utf-8', mode: 0o600 });
    // The new config is on disk: the freshly minted scoped key is live, so
    // stale configurator:opencode keys can be revoked (mirrors the
    // commit/rollback discipline of configurator/apply's mintClientKey).
    for (const id of staleOpencodeKeyIds) {
      try {
        revokeNamedApiKey(id);
      } catch {}
    }
    logs.push(`✓ Synchronized ${Object.keys(syncedModels).length} models to ${openCodePath}`);
  }

  /**
   * Level 2: Standalone Docker Containers (minimal topology-required services)
   */
  private async deployDocker(req: DeploymentRequest, logs: string[], startTime: number): Promise<DeploymentResponse> {
    logs.push('[Level 2: Docker] Preparing topology-scoped Docker container deployment...');
    const validated = this.resolveAndValidateConfig(req, logs);
    if (!validated.ok) {
      return {
        success: false,
        tier: 'docker',
        message: `Docker deployment refused: ${validated.error}`,
        logs,
        durationMs: Date.now() - startTime
      };
    }

    const persisted = this.persistAuthoritativeLocalConfig(validated.config, logs);
    if (!persisted.ok) {
      return {
        success: false,
        tier: 'docker',
        message: `Docker deployment failed: ${persisted.error}`,
        logs,
        durationMs: Date.now() - startTime
      };
    }

    this.writeDockerRuntimeConfigs(req, validated.config, logs);

    const dockerCheck = await this.runCommand('docker', ['info', '--format', '{{.ServerVersion}}'], {
      cwd: this.repoRoot,
      timeoutMs: 5000
    });
    if (!dockerCheck.success) {
      logs.push(`✗ Docker daemon is unavailable: ${dockerCheck.stderr || dockerCheck.stdout}`);
      return {
        success: false,
        tier: 'docker',
        message: 'Docker daemon is not running or inaccessible. Host config was still saved.',
        logs,
        durationMs: Date.now() - startTime
      };
    }

    await this.detectHostGpuForDocker(logs);

    // Deploy only the minimal compose services required by this graph (plus switchyard)
    const targetSet = new Set<string>(['switchyard', ...getComposeServicesForConfig(validated.config)]);
    const targetServices = Array.from(targetSet);
    logs.push(`🚀 Building & starting topology containers: ${targetServices.join(', ')}`);

    const res = await this.runCommand(
      'docker',
      ['compose', '--profile', 'all', 'up', '-d', '--build', '--force-recreate', ...targetServices],
      { cwd: this.repoRoot, timeoutMs: 180000 }
    );
    if (res.stdout.trim()) logs.push(res.stdout.trim());
    if (!res.success) {
      if (res.stderr.trim()) logs.push(res.stderr.trim());
      return {
        success: false,
        tier: 'docker',
        message: `Docker deployment failed for [${targetServices.join(', ')}].`,
        logs,
        durationMs: Date.now() - startTime
      };
    }

    const health = await this.waitForComposeServicesHealth(targetServices, logs, 35000);
    await this.syncLiveSwitchyard(validated.config, logs);

    const allHealthy = health.unhealthy.length === 0;
    return {
      success: allHealthy,
      tier: 'docker',
      message: allHealthy
        ? `Deployed ${targetServices.length} topology Docker container(s) (${targetServices.join(', ')}) with live runtime config.`
        : `Containers started, but health checks timed out for: ${health.unhealthy.join(', ')}.`,
      logs,
      durationMs: Date.now() - startTime
    };
  }

  /**
   * Level 3: Docker-Compose Stack
   */
  private async deployCompose(req: DeploymentRequest, logs: string[], startTime: number): Promise<DeploymentResponse> {
    logs.push('[Level 3: Docker Compose] Preparing compiled config sync & compose stack deployment...');
    const validated = this.resolveAndValidateConfig(req, logs);
    if (!validated.ok) {
      return {
        success: false,
        tier: 'compose',
        message: `Docker Compose deployment refused: ${validated.error}`,
        logs,
        durationMs: Date.now() - startTime
      };
    }

    const persisted = this.persistAuthoritativeLocalConfig(validated.config, logs);
    if (!persisted.ok) {
      return {
        success: false,
        tier: 'compose',
        message: `Docker Compose deployment failed: ${persisted.error}`,
        logs,
        durationMs: Date.now() - startTime
      };
    }

    this.writeDockerRuntimeConfigs(req, validated.config, logs);

    const dockerCheck = await this.runCommand('docker', ['info', '--format', '{{.ServerVersion}}'], {
      cwd: this.repoRoot,
      timeoutMs: 5000
    });
    if (!dockerCheck.success) {
      logs.push(`✗ Docker daemon is unavailable: ${dockerCheck.stderr || dockerCheck.stdout}`);
      return {
        success: false,
        tier: 'compose',
        message: 'Docker daemon is not running or inaccessible. Host config was still saved.',
        logs,
        durationMs: Date.now() - startTime
      };
    }

    await this.detectHostGpuForDocker(logs);

    // Build target service list: core control plane + topology-required services
    // + any already-running Eluvix compose services. This updates the active
    // stack without pulling unused heavy images (like CUDA-only sglang) unless
    // explicitly present in the topology or already running.
    const composeCatalog = getComposeServiceCatalog();
    const containerToService = new Map(composeCatalog.map((s) => [s.container, s.name]));
    const targetSet = new Set<string>([
      ...getServicesByCategory('core'),
      ...getComposeServicesForConfig(validated.config)
    ]);

    try {
      const psOut = await this.runCommand('docker', ['ps', '--format', '{{.Names}}'], {
        cwd: this.repoRoot,
        timeoutMs: 5000
      });
      if (psOut.success) {
        for (const containerName of psOut.stdout.split('\n').map((s) => s.trim()).filter(Boolean)) {
          const svc = containerToService.get(containerName);
          if (svc) targetSet.add(svc);
        }
      }
    } catch {
      // Non-fatal; core + topology services still deploy
    }

    const targetServices = Array.from(targetSet);
    logs.push(`🚀 Applying compiled runtime config & updating Compose stack: ${targetServices.join(', ')}`);

    const res = await this.runCommand(
      'docker',
      ['compose', '--profile', 'all', 'up', '-d', '--build', '--force-recreate', ...targetServices],
      {
        cwd: this.repoRoot,
        timeoutMs: 180000
      }
    );

    if (res.stdout.trim()) logs.push(res.stdout.trim());
    if (!res.success) {
      if (res.stderr.trim()) logs.push(res.stderr.trim());
      return {
        success: false,
        tier: 'compose',
        message: `Docker Compose deployment encountered errors while updating [${targetServices.join(', ')}].`,
        logs,
        durationMs: Date.now() - startTime
      };
    }

    const health = await this.waitForComposeServicesHealth(targetServices, logs, 45000);
    await this.syncLiveSwitchyard(validated.config, logs);

    const allHealthy = health.unhealthy.length === 0;
    return {
      success: allHealthy,
      tier: 'compose',
      message: allHealthy
        ? `Docker Compose stack synced and running (${targetServices.join(', ')}).`
        : `Docker Compose updated, but health checks timed out for: ${health.unhealthy.join(', ')}.`,
      logs,
      durationMs: Date.now() - startTime
    };
  }

  /**
   * Level 4: Full-Blown k3d + Helm Charts (Local Kubernetes)
   */
  private async deployK3d(req: DeploymentRequest, logs: string[], startTime: number): Promise<DeploymentResponse> {
    logs.push('[Level 4: k3d + Helm] Initiating local Kubernetes deployment...');

    const validated = this.resolveAndValidateConfig(req, logs);
    if (!validated.ok) {
      return {
        success: false,
        tier: 'k3d',
        message: `k3d deployment refused: ${validated.error}`,
        logs,
        durationMs: Date.now() - startTime
      };
    }

    // 0. Verify required CLI toolchains
    for (const [cmd, args] of [
      ['docker', ['info', '--format', '{{.ServerVersion}}']],
      ['k3d', ['version']],
      ['kubectl', ['version', '--client', '-o', 'json']],
      ['helm', ['version', '--short']]
    ] as const) {
      const check = await this.runCommand(cmd, [...args], { cwd: this.repoRoot, timeoutMs: 5000 });
      if (!check.success) {
        const errText = check.stderr || check.stdout || `${cmd} is unavailable`;
        logs.push(`✗ Prerequisite failed (${cmd}): ${errText}`);
        return {
          success: false,
          tier: 'k3d',
          message: `k3d deployment prerequisite missing or stopped: ${cmd}`,
          logs,
          durationMs: Date.now() - startTime
        };
      }
    }

    // 1. Check if k3d cluster exists (and start it if stopped, or create + import images if missing)
    const clusterCheck = await this.runCommand('k3d', ['cluster', 'list', '--no-headers'], {
      cwd: this.repoRoot,
      timeoutMs: 10000
    });
    const clusterExists = clusterCheck.stdout
      .split('\n')
      .some((line) => line.trim().startsWith('eluvix-local'));

    if (!clusterExists) {
      logs.push('🚀 Creating k3d cluster "eluvix-local" with load balancer ports...');
      const createCluster = await this.runCommand(
        'k3d',
        ['cluster', 'create', '--config', path.join(this.repoRoot, 'k3d-config.yaml')],
        { cwd: this.repoRoot, timeoutMs: 180000 }
      );
      if (createCluster.stdout.trim()) logs.push(createCluster.stdout.trim());
      if (!createCluster.success) {
        if (createCluster.stderr.trim()) logs.push(createCluster.stderr.trim());
        return {
          success: false,
          tier: 'k3d',
          message: `Failed to create k3d cluster: ${createCluster.stderr || createCluster.stdout}`,
          logs,
          durationMs: Date.now() - startTime
        };
      }

      // Build and import local images so pods never stall in ImagePullBackOff
      const k3dImages: Array<{ tag: string; args: string[] }> = [
        { tag: 'eluvix-nextjs:latest', args: ['build', '-t', 'eluvix-nextjs:latest', '-f', 'apps/nextjs/Dockerfile', '.'] },
        { tag: 'eluvix-switchyard:latest', args: ['build', '-t', 'eluvix-switchyard:latest', 'docker/switchyard'] },
        { tag: 'eluvix-agent-router:latest', args: ['build', '-t', 'eluvix-agent-router:latest', 'docker/agent-router'] },
        { tag: 'eluvix-agentgateway:latest', args: ['build', '-t', 'eluvix-agentgateway:latest', 'docker/agentgateway'] }
      ];
      for (const img of k3dImages) {
        logs.push(`🔨 Building image ${img.tag}...`);
        const buildRes = await this.runCommand('docker', img.args, { cwd: this.repoRoot, timeoutMs: 300000 });
        if (!buildRes.success) {
          if (buildRes.stderr.trim()) logs.push(buildRes.stderr.trim());
          return {
            success: false,
            tier: 'k3d',
            message: `Failed to build Docker image ${img.tag} for k3d cluster.`,
            logs,
            durationMs: Date.now() - startTime
          };
        }
      }
      logs.push('📥 Importing local Eluvix images into k3d cluster "eluvix-local"...');
      const importRes = await this.runCommand(
        'k3d',
        ['image', 'import', ...k3dImages.map((i) => i.tag), '--cluster', 'eluvix-local'],
        { cwd: this.repoRoot, timeoutMs: 180000 }
      );
      if (!importRes.success) {
        if (importRes.stderr.trim()) logs.push(importRes.stderr.trim());
        return {
          success: false,
          tier: 'k3d',
          message: `Failed to import images into k3d cluster: ${importRes.stderr || importRes.stdout}`,
          logs,
          durationMs: Date.now() - startTime
        };
      }
    } else {
      const infoCheck = await this.runCommand('kubectl', ['cluster-info', '--context', 'k3d-eluvix-local'], {
        cwd: this.repoRoot,
        timeoutMs: 8000
      });
      if (!infoCheck.success) {
        logs.push('▶️ Cluster "eluvix-local" is stopped; starting cluster...');
        const startRes = await this.runCommand('k3d', ['cluster', 'start', 'eluvix-local'], {
          cwd: this.repoRoot,
          timeoutMs: 120000
        });
        if (!startRes.success) {
          if (startRes.stderr.trim()) logs.push(startRes.stderr.trim());
          return {
            success: false,
            tier: 'k3d',
            message: `Failed to start stopped k3d cluster: ${startRes.stderr || startRes.stdout}`,
            logs,
            durationMs: Date.now() - startTime
          };
        }
      }
      logs.push('✓ Cluster "eluvix-local" is active.');
    }

    // 2. Ensure nodes are ready
    logs.push('⏳ Checking node readiness...');
    const waitNodes = await this.runCommand(
      'kubectl',
      ['wait', '--for=condition=Ready', 'nodes', '--all', '--context', 'k3d-eluvix-local', '--timeout=90s'],
      { cwd: this.repoRoot, timeoutMs: 95000 }
    );
    if (!waitNodes.success) {
      if (waitNodes.stderr.trim()) logs.push(waitNodes.stderr.trim());
      return {
        success: false,
        tier: 'k3d',
        message: 'k3d cluster nodes did not become Ready in time.',
        logs,
        durationMs: Date.now() - startTime
      };
    }

    // 3. Ensure namespace exists cleanly without shell piping
    logs.push('📦 Ensuring "eluvix" namespace exists...');
    const nsCheck = await this.runCommand(
      'kubectl',
      ['get', 'namespace', 'eluvix', '--context', 'k3d-eluvix-local'],
      { cwd: this.repoRoot, timeoutMs: 10000 }
    );
    if (!nsCheck.success) {
      const nsCreate = await this.runCommand(
        'kubectl',
        ['create', 'namespace', 'eluvix', '--context', 'k3d-eluvix-local'],
        { cwd: this.repoRoot, timeoutMs: 10000 }
      );
      if (!nsCreate.success) {
        if (nsCreate.stderr.trim()) logs.push(nsCreate.stderr.trim());
        return {
          success: false,
          tier: 'k3d',
          message: `Failed to create namespace "eluvix": ${nsCreate.stderr || nsCreate.stdout}`,
          logs,
          durationMs: Date.now() - startTime
        };
      }
    }

    // 4. Write temporary custom values containing secret-redacted compiled configs
    const tempValuesPath = path.join(
      os.tmpdir(),
      `eluvix-helm-values-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.yaml`
    );
    try {
      const redactedJson = JSON.stringify(redactConfigForApi(validated.config), null, 2);
      const customValues = {
        routingConfig: {
          eluvixJson: redactedJson,
          bifrostYaml: req.compiledConfigs.bifrostYaml || '',
          agentRouterJson: req.compiledConfigs.agentRouterJson || '{}',
          agentGatewayJson: req.compiledConfigs.agentGatewayJson || '{}'
        }
      };
      fs.writeFileSync(tempValuesPath, JSON.stringify(customValues, null, 2), { encoding: 'utf-8', mode: 0o600 });
      logs.push('✓ Injected secret-redacted compiled routing graphs into Helm values (ConfigMap rollout enabled).');

      // 5. Deploy / Upgrade Helm release (checksum/config annotations trigger pod rollouts automatically)
      logs.push('🚀 Running Helm upgrade --install eluvix --wait...');
      const helmResult = await this.runCommand(
        'helm',
        [
          'upgrade',
          '--install',
          'eluvix',
          path.join(this.repoRoot, 'helm', 'eluvix'),
          '-f',
          path.join(this.repoRoot, 'helm', 'eluvix', 'values-local.yaml'),
          '-f',
          tempValuesPath,
          '--namespace',
          'eluvix',
          '--kube-context',
          'k3d-eluvix-local',
          '--wait',
          '--timeout',
          '180s'
        ],
        {
          cwd: this.repoRoot,
          timeoutMs: 210000
        }
      );

      if (helmResult.stdout.trim()) logs.push(helmResult.stdout.trim());
      if (!helmResult.success) {
        if (helmResult.stderr.trim()) logs.push(helmResult.stderr.trim());
        return {
          success: false,
          tier: 'k3d',
          message: `Helm deployment failed: ${helmResult.stderr || helmResult.stdout}`,
          logs,
          durationMs: Date.now() - startTime
        };
      }

      logs.push('✨ Helm release "eluvix" deployed and rolled out cleanly on k3d cluster.');
      return {
        success: true,
        tier: 'k3d',
        message: 'Successfully deployed Eluvix to k3d Kubernetes cluster via Helm.',
        logs,
        durationMs: Date.now() - startTime
      };
    } finally {
      // Guaranteed cleanup of temp values
      try {
        if (fs.existsSync(tempValuesPath)) {
          fs.unlinkSync(tempValuesPath);
        }
      } catch {}
    }
  }

  /**
   * Manages k3d cluster lifecycle actions
   */
  public async manageCluster(action: 'create' | 'delete' | 'start' | 'stop' | 'status') {
    const scriptPath = path.join(this.repoRoot, 'scripts', 'k3d-cluster.sh');
    let scriptArg = 'status';
    if (action === 'create' || action === 'start') scriptArg = 'up';
    if (action === 'delete' || action === 'stop') scriptArg = 'down';

    return await executeSafeCommand('bash', [scriptPath, scriptArg], {
      cwd: this.repoRoot,
      timeoutMs: 180000
    });
  }
}

export const orchestratorManager = new OrchestrationManager();
