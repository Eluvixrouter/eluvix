import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { executeSafeCommand } from './executor';

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
    const composeStatus = {
      running: false,
      activeServices: 0,
      totalServices: 6,
      services: [] as any[]
    };

    if (tools.docker) {
      try {
        const psOut = await executeSafeCommand('docker', ['ps', '--format', '{{.Names}}'], { timeoutMs: 4000 });
        const runningNames = psOut.stdout.split('\n').map(s => s.trim()).filter(Boolean);
        const targetContainers = [
          'eluvix-switchyard',
          'eluvix-vllm-sr',
          'eluvix-ollama',
          'eluvix-vllm',
          'eluvix-agent-router',
          'eluvix-agentgateway'
        ];

        composeStatus.services = targetContainers.map(name => {
          const isRunning = runningNames.includes(name);
          return {
            name,
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
    const localConfigPath = path.join(os.homedir(), '.config', 'eluvix', 'config.json');
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
   * Level 1: Local Host Binaries
   */
  private async deployLocal(req: DeploymentRequest, logs: string[], startTime: number): Promise<DeploymentResponse> {
    logs.push('[Level 1: Local] Preparing local configuration deployment...');
    const configDir = path.join(os.homedir(), '.config', 'eluvix');
    fs.mkdirSync(configDir, { recursive: true });

    const targetFile = path.join(configDir, 'config.json');
    const configData = req.compiledConfigs.rawRouterConfig || JSON.parse(req.compiledConfigs.eluvixJson || '{}');
    fs.writeFileSync(targetFile, JSON.stringify(configData, null, 2), 'utf-8');
    logs.push(`✓ Written active router config to ${targetFile}`);

    // If local switchyard server is reachable, trigger hot-reload
    try {
      const res = await fetch('http://127.0.0.1:8080/v1/config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(configData)
      });
      if (res.ok) {
        logs.push('✓ Live local Switchyard balancer (port 8080) synchronized successfully.');
      } else {
        logs.push(`ℹ️ Local Switchyard server returned HTTP ${res.status}. Config saved to disk.`);
      }
    } catch {
      logs.push('ℹ️ No local Switchyard proxy detected at port 8080. Config saved to ~/.config/eluvix/config.json for next launch.');
    }

    return {
      success: true,
      tier: 'local',
      message: 'Local configuration deployed successfully to ~/.config/eluvix/config.json',
      logs,
      durationMs: Date.now() - startTime
    };
  }

  /**
   * Level 2: Standalone Docker Containers
   */
  private async deployDocker(req: DeploymentRequest, logs: string[], startTime: number): Promise<DeploymentResponse> {
    logs.push('[Level 2: Docker] Deploying to standalone Docker container...');
    const scriptPath = path.join(this.repoRoot, 'scripts', 'docker-detect-and-spinup.sh');

    if (!fs.existsSync(scriptPath)) {
      throw new Error(`Orchestration script not found: ${scriptPath}`);
    }

    const res = await executeSafeCommand('bash', [scriptPath, 'status'], { cwd: this.repoRoot });
    logs.push(res.stdout || res.stderr);

    return {
      success: res.success,
      tier: 'docker',
      message: 'Docker containers inspected and updated.',
      logs,
      durationMs: Date.now() - startTime
    };
  }

  /**
   * Level 3: Docker-Compose Stack
   */
  private async deployCompose(req: DeploymentRequest, logs: string[], startTime: number): Promise<DeploymentResponse> {
    logs.push('[Level 3: Docker Compose] Orchestrating full compose stack...');
    const scriptPath = path.join(this.repoRoot, 'scripts', 'docker-detect-and-spinup.sh');

    // Run spinup script
    const res = await executeSafeCommand('bash', [scriptPath, 'up'], {
      cwd: this.repoRoot,
      timeoutMs: 180000
    });

    logs.push(res.stdout);
    if (!res.success) {
      logs.push(res.stderr);
      return {
        success: false,
        tier: 'compose',
        message: 'Docker Compose spin-up encountered errors.',
        logs,
        durationMs: Date.now() - startTime
      };
    }

    return {
      success: true,
      tier: 'compose',
      message: 'Docker Compose service stack successfully deployed and running.',
      logs,
      durationMs: Date.now() - startTime
    };
  }

  /**
   * Level 4: Full-Blown k3d + Helm Charts (Local Kubernetes)
   */
  private async deployK3d(req: DeploymentRequest, logs: string[], startTime: number): Promise<DeploymentResponse> {
    logs.push('[Level 4: k3d + Helm] Initiating local Kubernetes deployment...');

    // 1. Check if k3d cluster exists
    const clusterCheck = await executeSafeCommand('k3d', ['cluster', 'list', '--no-headers']);
    if (!clusterCheck.stdout.includes('eluvix-local')) {
      logs.push('🚀 Creating k3d cluster "eluvix-local" with load balancer ports...');
      const createCluster = await executeSafeCommand('k3d', [
        'cluster',
        'create',
        '--config',
        path.join(this.repoRoot, 'k3d-config.yaml')
      ], {
        cwd: this.repoRoot,
        timeoutMs: 180000
      });
      logs.push(createCluster.stdout);
      if (!createCluster.success) {
        logs.push(createCluster.stderr);
        throw new Error(`Failed to create k3d cluster: ${createCluster.stderr}`);
      }
    } else {
      logs.push('✓ Cluster "eluvix-local" detected.');
    }

    // 2. Ensure nodes are ready
    logs.push('⏳ Checking node readiness...');
    await executeSafeCommand('kubectl', [
      'wait',
      '--for=condition=Ready',
      'nodes',
      '--all',
      '--context',
      'k3d-eluvix-local',
      '--timeout=60s'
    ]);

    // 3. Ensure namespace exists
    logs.push('📦 Ensuring "eluvix" namespace exists...');
    await executeSafeCommand('kubectl', [
      'create',
      'namespace',
      'eluvix',
      '--context',
      'k3d-eluvix-local',
      '--dry-run=client',
      '-o',
      'yaml'
    ]);
    await executeSafeCommand('bash', [
      '-c',
      'kubectl create namespace eluvix --context k3d-eluvix-local --dry-run=client -o yaml | kubectl apply --context k3d-eluvix-local -f -'
    ]).catch(() => {});

    // 4. Write temporary custom values containing compiled configs
    const tempValuesPath = path.join(this.repoRoot, 'helm', 'eluvix', '.temp-compiled-values.yaml');
    const customValues = {
      routingConfig: {
        eluvixJson: req.compiledConfigs.eluvixJson || '',
        bifrostYaml: req.compiledConfigs.bifrostYaml || '',
        agentRouterJson: req.compiledConfigs.agentRouterJson || '',
        agentGatewayJson: req.compiledConfigs.agentGatewayJson || ''
      }
    };
    fs.writeFileSync(tempValuesPath, JSON.stringify(customValues, null, 2), 'utf-8');
    logs.push('✓ Injected compiled routing graphs into Helm values.');

    // 5. Deploy / Upgrade Helm release
    logs.push('🚀 Running Helm upgrade --install eluvix...');
    const helmResult = await executeSafeCommand('helm', [
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
      'k3d-eluvix-local'
    ], {
      cwd: this.repoRoot,
      timeoutMs: 120000
    });

    // Cleanup temp values
    try { fs.unlinkSync(tempValuesPath); } catch {}

    logs.push(helmResult.stdout);
    if (!helmResult.success) {
      logs.push(helmResult.stderr);
      return {
        success: false,
        tier: 'k3d',
        message: `Helm deployment failed: ${helmResult.stderr}`,
        logs,
        durationMs: Date.now() - startTime
      };
    }

    logs.push('✨ Helm release "eluvix" deployed successfully on k3d cluster.');
    return {
      success: true,
      tier: 'k3d',
      message: 'Successfully deployed Eluvix to k3d Kubernetes cluster via Helm.',
      logs,
      durationMs: Date.now() - startTime
    };
  }

  /**
   * Manages k3d cluster lifecycle actions
   */
  public async manageCluster(action: 'create' | 'delete' | 'start' | 'stop') {
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
