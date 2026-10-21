import { execSync } from 'node:child_process';
import os from 'node:os';
import EventEmitter from 'node:events';
import fs from 'node:fs';
import {
  getProviderSettings,
  saveProviderSettings,
  logProviderJob,
  getProviderJobLogs,
  ProviderDbSettings
} from './db.js';

export interface GpuInfo {
  vendor: 'NVIDIA' | 'AMD' | 'APPLE' | 'INTEL' | 'CPU';
  model: string;
  count: number;
  vramTotalGb: number;
  vramFreeGb: number;
  temperatureC?: number;
  utilPercent?: number;
}

export interface LocalEngineModelInfo {
  name: string;
  sizeBytes?: number;
  vramUsageMb?: number;
}

export interface ProviderAgentConfig {
  serverUrl: string;
  nodeToken?: string;
  nodeName?: string;
  publicIp?: string;
  engineUrl: string;
  engineType: 'ollama' | 'vllm' | 'lemonade' | 'openai-compatible';
  pricingMode: 'market' | 'floor';
  floorPriceIn?: number;
  floorPriceOut?: number;
  pauseOnUserActive: boolean;
  maxGpuTempC: number;
  maxConcurrency: number;
  heartbeatIntervalMs?: number;
}

export interface ProviderStatusInfo {
  status: 'OFFLINE' | 'INITIALIZING' | 'ONLINE' | 'SERVING' | 'PAUSED' | 'ERROR';
  nodeId?: string;
  reputationScore: number;
  totalJobsCompleted: number;
  totalTokensServed: number;
  totalEarnedUsd: number;
  gpu: GpuInfo;
  models: string[];
  lastHeartbeatAt?: string;
  errorMessage?: string;
}

/**
 * Detects local GPU hardware across NVIDIA, AMD, Apple Silicon, or CPU fallback.
 */
export async function detectGpuHardware(): Promise<GpuInfo> {
  const platform = os.platform();

  // 1. Try NVIDIA via nvidia-smi
  try {
    const stdout = execSync(
      'nvidia-smi --query-gpu=name,memory.total,memory.free,temperature.gpu,utilization.gpu --format=csv,noheader,nounits',
      { encoding: 'utf8', timeout: 3000, stdio: ['pipe', 'pipe', 'ignore'] }
    );
    const lines = stdout.trim().split('\n');
    if (lines.length > 0 && lines[0].trim()) {
      const parts = lines[0].split(',').map((s) => s.trim());
      const model = parts[0] || 'NVIDIA GPU';
      const totalMb = parseFloat(parts[1]) || 8192;
      const freeMb = parseFloat(parts[2]) || 6144;
      const temp = parseInt(parts[3], 10) || 45;
      const util = parseInt(parts[4], 10) || 0;

      return {
        vendor: 'NVIDIA',
        model,
        count: lines.length,
        vramTotalGb: Number((totalMb / 1024).toFixed(1)),
        vramFreeGb: Number((freeMb / 1024).toFixed(1)),
        temperatureC: temp,
        utilPercent: util,
      };
    }
  } catch {
    // nvidia-smi not available
  }

  // 2. Try AMD via ROCm (rocminfo, rocm-smi) or Linux DRM sysfs
  if (platform === 'linux') {
    try {
      let model = '';
      const rocminfoCandidates = ['rocminfo', '/opt/rocm/bin/rocminfo'];
      for (const rPath of rocminfoCandidates) {
        try {
          const out = execSync(rPath, { encoding: 'utf8', timeout: 2000, stdio: ['pipe', 'pipe', 'ignore'] });
          const m = out.match(/Marketing Name:\s+([^\n]+)/g);
          if (m && m.length > 0) {
            const graphicsEntry = m.find((s) => /Graphics|Radeon|Instinct/i.test(s));
            const selected = graphicsEntry || m[0];
            model = selected.replace(/Marketing Name:\s*/i, '').trim();
            break;
          }
        } catch {
          // continue
        }
      }

      if (!model) {
        try {
          const lspci = execSync('lspci', { encoding: 'utf8', timeout: 2000, stdio: ['pipe', 'pipe', 'ignore'] });
          const match = lspci.match(/(?:VGA|3D|Display)[^:]*:\s*(?:Advanced Micro Devices, Inc\.\s*)?\[AMD\/ATI\]\s*([^(\n]+)/i);
          if (match) {
            model = 'AMD ' + match[1].trim();
          }
        } catch {
          // ignore
        }
      }

      let totalBytes = 0;
      let usedBytes = 0;
      let tempC = 45;
      let utilPercent = 0;
      let foundAmdCard = false;

      if (fs.existsSync('/sys/class/drm')) {
        const cards = fs.readdirSync('/sys/class/drm').filter((c) => /^card\d+$/.test(c));
        for (const card of cards) {
          const driverPath = `/sys/class/drm/${card}/device/driver`;
          try {
            if (fs.existsSync(driverPath) && fs.readlinkSync(driverPath).includes('amdgpu')) {
              foundAmdCard = true;
              const devDir = `/sys/class/drm/${card}/device`;

              const vramTot = fs.existsSync(`${devDir}/mem_info_vram_total`)
                ? parseInt(fs.readFileSync(`${devDir}/mem_info_vram_total`, 'utf8').trim(), 10)
                : 0;
              const vramUsed = fs.existsSync(`${devDir}/mem_info_vram_used`)
                ? parseInt(fs.readFileSync(`${devDir}/mem_info_vram_used`, 'utf8').trim(), 10)
                : 0;
              const gttTot = fs.existsSync(`${devDir}/mem_info_gtt_total`)
                ? parseInt(fs.readFileSync(`${devDir}/mem_info_gtt_total`, 'utf8').trim(), 10)
                : 0;
              const gttUsed = fs.existsSync(`${devDir}/mem_info_gtt_used`)
                ? parseInt(fs.readFileSync(`${devDir}/mem_info_gtt_used`, 'utf8').trim(), 10)
                : 0;

              // For APU / iGPU, GTT represents the available shared host memory accessible to ROCm
              const memTotal = Math.max(vramTot, gttTot);
              const memUsed = vramTot > gttTot ? vramUsed : gttUsed;
              if (memTotal > totalBytes) {
                totalBytes = memTotal;
                usedBytes = memUsed;
              }

              if (fs.existsSync(`${devDir}/gpu_busy_percent`)) {
                utilPercent = parseInt(fs.readFileSync(`${devDir}/gpu_busy_percent`, 'utf8').trim(), 10) || 0;
              }

              const hwmonDir = `${devDir}/hwmon`;
              if (fs.existsSync(hwmonDir)) {
                const hwmons = fs.readdirSync(hwmonDir);
                for (const h of hwmons) {
                  const tempFile = `${hwmonDir}/${h}/temp1_input`;
                  if (fs.existsSync(tempFile)) {
                    tempC = Math.round(parseInt(fs.readFileSync(tempFile, 'utf8').trim(), 10) / 1000) || 45;
                    break;
                  }
                }
              }
              break;
            }
          } catch {
            // ignore
          }
        }
      }

      if (foundAmdCard || model || fs.existsSync('/sys/module/amdgpu')) {
        const vramTotalGb = totalBytes > 0 ? Number((totalBytes / (1024 * 1024 * 1024)).toFixed(1)) : 16.0;
        const vramFreeGb = totalBytes > 0 ? Math.max(0, Number(((totalBytes - usedBytes) / (1024 * 1024 * 1024)).toFixed(1))) : 12.0;

        return {
          vendor: 'AMD',
          model: model || 'AMD Radeon / Instinct Accelerator',
          count: 1,
          vramTotalGb,
          vramFreeGb,
          temperatureC: tempC,
          utilPercent,
        };
      }
    } catch {
      // ignore
    }
  }

  // 2b. Fallback rocm-smi
  try {
    const stdout = execSync('rocm-smi --showproductname --showmeminfo vram --csv', {
      encoding: 'utf8',
      timeout: 3000,
      stdio: ['pipe', 'pipe', 'ignore'],
    });
    if (stdout.includes('Card') || stdout.includes('GPU')) {
      return {
        vendor: 'AMD',
        model: 'AMD Radeon / Instinct Accelerator',
        count: 1,
        vramTotalGb: 16.0,
        vramFreeGb: 12.0,
        temperatureC: 48,
        utilPercent: 0,
      };
    }
  } catch {
    // rocm-smi not available
  }

  // 3. Try Apple Silicon on macOS
  if (platform === 'darwin') {
    try {
      const brand = execSync('sysctl -n machdep.cpu.brand_string', { encoding: 'utf8' }).trim();
      const totalMem = os.totalmem();
      const totalGb = Number((totalMem / (1024 * 1024 * 1024)).toFixed(1));

      return {
        vendor: 'APPLE',
        model: brand || 'Apple Silicon (Metal Unified Memory)',
        count: 1,
        vramTotalGb: totalGb,
        vramFreeGb: Number((totalGb * 0.75).toFixed(1)),
        temperatureC: 42,
        utilPercent: 0,
      };
    } catch {
      // ignore
    }
  }

  // 4. Default Host Hardware Profile (CPU fallback)
  const totalMem = os.totalmem();
  const freeMem = os.freemem();
  const cpus = os.cpus();
  const cpuModel = cpus.length > 0 ? cpus[0].model.trim() : 'Host CPU';

  return {
    vendor: 'CPU',
    model: `${cpuModel} (${cpus.length} vCPUs)`,
    count: cpus.length,
    vramTotalGb: Number((totalMem / (1024 * 1024 * 1024)).toFixed(1)),
    vramFreeGb: Number((freeMem / (1024 * 1024 * 1024)).toFixed(1)),
    temperatureC: 45,
    utilPercent: 0,
  };
}

/**
 * Queries local inference engine (Ollama, vLLM, Lemonade) for loaded/available models.
 */
export async function detectLocalEngineModels(
  engineUrl: string = 'http://localhost:11434',
  engineType: string = 'ollama'
): Promise<LocalEngineModelInfo[]> {
  const trimmed = engineUrl.trim().replace(/\/+$/, '');
  const candidateUrls: string[] = [];

  if (engineType === 'ollama') {
    candidateUrls.push(`${trimmed}/api/tags`, `${trimmed}/v1/models`, `${trimmed}/models`);
  } else {
    candidateUrls.push(`${trimmed}/v1/models`, `${trimmed}/models`, `${trimmed}/api/tags`);
  }

  for (const url of candidateUrls) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(2500) });
      if (!res.ok) continue;
      const data = await res.json();

      // Standard Ollama format: { models: [{ name, size }] }
      if (Array.isArray(data.models) && data.models.length > 0) {
        return data.models.map((m: any) => ({
          name: m.name || m.model || String(m),
          sizeBytes: m.size || 0,
          vramUsageMb: Math.round((m.size || 4000000000) / (1024 * 1024)),
        }));
      }

      // OpenAI format: { data: [{ id }] }
      if (Array.isArray(data.data) && data.data.length > 0) {
        return data.data.map((m: any) => ({
          name: m.id || m.name || String(m),
          sizeBytes: 0,
          vramUsageMb: 4096,
        }));
      }
    } catch {
      // Continue to next probe
    }
  }

  // Fallback defaults
  return [
    { name: 'llama3.1:8b', sizeBytes: 4800000000, vramUsageMb: 4900 },
    { name: 'qwen2.5-coder:7b', sizeBytes: 4500000000, vramUsageMb: 4600 }
  ];
}

/**
 * Eluvix Provider Agent
 * Connects local machine to Billama Compute Grid to sell idle GPU compute time.
 */
export class EluvixProviderAgent extends EventEmitter {
  private config: ProviderAgentConfig;
  private isRunning: boolean = false;
  private isPaused: boolean = false;
  private heartbeatTimer: NodeJS.Timeout | null = null;
  private consumerPreemptionTimer: NodeJS.Timeout | null = null;
  private nodeId: string | null = null;
  private gpuInfo: GpuInfo | null = null;
  private installedModels: LocalEngineModelInfo[] = [];
  private reputationScore: number = 100.0;
  private lastErrorMessage: string | null = null;

  constructor(customConfig?: Partial<ProviderAgentConfig>) {
    super();

    const stored = getProviderSettings();
    this.config = {
      serverUrl: stored?.server_url || 'https://api.billama.dev',
      nodeToken: stored?.node_token || undefined,
      nodeName: stored?.node_name || undefined,
      engineUrl: stored?.engine_url || 'http://localhost:11434',
      engineType: (stored?.engine_type as any) || 'ollama',
      pricingMode: (stored?.pricing_mode as any) || 'market',
      floorPriceIn: stored?.floor_price_in || 0,
      floorPriceOut: stored?.floor_price_out || 0,
      pauseOnUserActive: Boolean(stored?.pause_on_user_active ?? 1),
      maxGpuTempC: stored?.max_gpu_temp_c || 82,
      maxConcurrency: stored?.max_concurrency || 1,
      heartbeatIntervalMs: 10000,
      ...customConfig,
    };

    if (stored?.node_id) {
      this.nodeId = stored.node_id;
    }
    if (stored?.reputation_score) {
      this.reputationScore = stored.reputation_score;
    }
  }

  public getConfig(): ProviderAgentConfig {
    return { ...this.config };
  }

  public updateConfig(updates: Partial<ProviderAgentConfig>) {
    this.config = { ...this.config, ...updates };
    saveProviderSettings({
      server_url: this.config.serverUrl,
      node_token: this.config.nodeToken,
      node_name: this.config.nodeName,
      engine_url: this.config.engineUrl,
      engine_type: this.config.engineType,
      pricing_mode: this.config.pricingMode,
      floor_price_in: this.config.floorPriceIn,
      floor_price_out: this.config.floorPriceOut,
      pause_on_user_active: this.config.pauseOnUserActive ? 1 : 0,
      max_gpu_temp_c: this.config.maxGpuTempC,
      max_concurrency: this.config.maxConcurrency,
    });
    this.emit('config-updated', this.config);
  }

  public async detectHardware(): Promise<GpuInfo> {
    return await detectGpuHardware();
  }

  public async getStatus(): Promise<ProviderStatusInfo> {
    if (!this.gpuInfo) {
      this.gpuInfo = await this.detectHardware();
    }
    const stored = getProviderSettings();

    let status: ProviderStatusInfo['status'] = 'OFFLINE';
    if (this.isRunning) {
      if (this.isPaused) {
        status = 'PAUSED';
      } else {
        status = 'ONLINE';
      }
    }

    return {
      status,
      nodeId: this.nodeId || stored?.node_id || undefined,
      reputationScore: stored?.reputation_score ?? this.reputationScore,
      totalJobsCompleted: stored?.total_jobs_completed ?? 0,
      totalTokensServed: stored?.total_tokens_served ?? 0,
      totalEarnedUsd: stored?.total_earned_usd ?? 0.0,
      gpu: this.gpuInfo,
      models: this.installedModels.map((m) => m.name),
      lastHeartbeatAt: stored?.last_heartbeat_at,
      errorMessage: this.lastErrorMessage || undefined,
    };
  }

  public async start(): Promise<void> {
    if (this.isRunning) return;

    try {
      this.lastErrorMessage = null;
      console.log('[Eluvix Provider] 🚀 Initializing GPU Provider Agent...');

      // 1. Detect hardware
      this.gpuInfo = await this.detectHardware();
      console.log(`[Eluvix Provider] 🎮 Hardware: ${this.gpuInfo.count}x ${this.gpuInfo.model} (${this.gpuInfo.vramTotalGb}GB VRAM)`);

      // 2. Discover local models
      this.installedModels = await detectLocalEngineModels(this.config.engineUrl, this.config.engineType);
      console.log(`[Eluvix Provider] 📦 Local Models: ${this.installedModels.map((m) => m.name).join(', ')}`);

      // 3. Register with Billama
      await this.registerNode();

      this.isRunning = true;
      this.isPaused = false;
      saveProviderSettings({ enabled: 1 });

      // 4. Start heartbeat loop
      if (this.heartbeatTimer) {
        clearInterval(this.heartbeatTimer);
        this.heartbeatTimer = null;
      }
      this.heartbeatTimer = setInterval(() => {
        this.sendHeartbeat().catch((err) => {
          this.lastErrorMessage = err.message;
          this.emit('error', err);
        });
      }, this.config.heartbeatIntervalMs);

      this.emit('started');
      this.emit('status-changed', { status: 'ONLINE', isRunning: true, isPaused: false });
    } catch (err: any) {
      this.lastErrorMessage = err.message;
      this.isRunning = false;
      this.emit('error', err);
      throw err;
    }
  }

  public async stop(): Promise<void> {
    this.isRunning = false;
    this.isPaused = false;
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
    if (this.consumerPreemptionTimer) {
      clearTimeout(this.consumerPreemptionTimer);
      this.consumerPreemptionTimer = null;
    }

    saveProviderSettings({ enabled: 0 });
    console.log('[Eluvix Provider] 🛑 GPU Provider Agent stopped.');
    this.emit('stopped');
    this.emit('status-changed', { status: 'OFFLINE', isRunning: false, isPaused: false });
  }

  /**
   * Toggles provider agent running state.
   */
  public async setEnabled(enabled: boolean): Promise<ProviderStatusInfo> {
    if (enabled) {
      await this.start();
    } else {
      await this.stop();
    }
    return this.getStatus();
  }

  /**
   * Runs a local benchmark test job to verify GPU inference and record compute telemetry.
   */
  public async runBenchmark(model?: string): Promise<any> {
    const targetModel = model || (this.installedModels[0]?.name) || 'llama3.1:8b';
    const testPrompt = [
      { role: 'user', content: 'Generate a short 2-sentence confirmation that this local GPU is functioning.' }
    ];

    return await this.executeJob({
      jobId: `bench-${Date.now()}`,
      model: targetModel,
      messages: testPrompt,
      maxTokens: 60,
      pricePerMTok: 0.50
    });
  }

  /**
   * Preempts provider activity whenever the local desktop user sends inference queries.
   * Ensures zero lag for the consumer!
   */
  public notifyConsumerActive(holdDurationMs: number = 30000) {
    if (!this.config.pauseOnUserActive || !this.isRunning) return;

    this.isPaused = true;
    this.emit('preempted', { holdDurationMs });
    this.emit('status-changed', { status: 'STANDBY', reason: 'consumer_active' });

    if (this.consumerPreemptionTimer) {
      clearTimeout(this.consumerPreemptionTimer);
    }

    this.consumerPreemptionTimer = setTimeout(() => {
      this.isPaused = false;
      this.consumerPreemptionTimer = null;
      this.emit('resumed');
      this.emit('status-changed', { status: 'ONLINE', isRunning: true, isPaused: false });
    }, holdDurationMs);
  }

  /**
   * Registers this node with Billama Edge Marketplace.
   */
  private async registerNode(): Promise<void> {
    const registerUrl = `${this.config.serverUrl.replace(/\/+$/, '')}/api/nodes/register`;
    const payload = {
      name: this.config.nodeName || `${os.hostname()} (Eluvix GPU Node)`,
      nodeToken: this.config.nodeToken,
      hostname: os.hostname(),
      publicIp: this.config.publicIp || undefined,
      gpuModel: this.gpuInfo?.model || 'Host Inference Accelerator',
      gpuVendor: this.gpuInfo?.vendor || 'CPU',
      gpuCount: this.gpuInfo?.count || 1,
      vramTotalGb: this.gpuInfo?.vramTotalGb || 16.0,
      vramFreeGb: this.gpuInfo?.vramFreeGb || 12.0,
      region: 'us-east',
      models: this.installedModels.map((m) => ({
        modelName: m.name,
        vramUsageMb: m.vramUsageMb || 4096,
      })),
    };

    try {
      const res = await fetch(registerUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });

      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.error || 'Failed to register GPU node with Billama Edge');
      }

      this.nodeId = data.node.id;
      if (data.node.reputationScore) {
        this.reputationScore = data.node.reputationScore;
      }

      saveProviderSettings({
        node_id: this.nodeId || undefined,
        node_token: data.rawToken || this.config.nodeToken,
        reputation_score: this.reputationScore,
      });

      console.log(`[Eluvix Provider] ✅ Registered successfully with Billama! Node ID: ${this.nodeId}`);
    } catch (err: any) {
      console.warn(`[Eluvix Provider] Note: Running in local provider mode (${err.message}).`);
      // Keep mock node ID if offline or local testing
      if (!this.nodeId) {
        this.nodeId = `eluvix-node-${Date.now().toString(36)}`;
        saveProviderSettings({ node_id: this.nodeId });
      }
    }
  }

  /**
   * Heartbeat telemetry loop to Billama Edge.
   */
  private async sendHeartbeat(): Promise<void> {
    if (!this.nodeId || !this.isRunning) return;

    // Refresh dynamic metrics
    this.gpuInfo = await this.detectHardware();

    // Check thermal threshold
    if (this.gpuInfo.temperatureC && this.gpuInfo.temperatureC > this.config.maxGpuTempC) {
      if (!this.isPaused) {
        console.warn(`[Eluvix Provider] ⚠️ GPU temperature (${this.gpuInfo.temperatureC}°C) exceeds max limit (${this.config.maxGpuTempC}°C). Pausing jobs.`);
        this.isPaused = true;
        this.emit('preempted', { reason: 'thermal_throttle' });
        this.emit('status-changed', { status: 'STANDBY', reason: 'thermal_throttle', temperatureC: this.gpuInfo.temperatureC });
      }
    } else if (this.isPaused && !this.consumerPreemptionTimer && (!this.gpuInfo.temperatureC || this.gpuInfo.temperatureC <= this.config.maxGpuTempC)) {
      console.info(`[Eluvix Provider] ✅ GPU temperature (${this.gpuInfo.temperatureC}°C) returned to safe levels. Resuming jobs.`);
      this.isPaused = false;
      this.emit('resumed');
      this.emit('status-changed', { status: 'ONLINE', temperatureC: this.gpuInfo.temperatureC });
    }

    const heartbeatUrl = `${this.config.serverUrl.replace(/\/+$/, '')}/api/nodes/heartbeat`;
    const payload = {
      nodeId: this.nodeId,
      nodeToken: this.config.nodeToken || 'local-eluvix-token',
      status: this.isPaused ? 'STANDBY' : 'ONLINE',
      vramFreeGb: this.gpuInfo?.vramFreeGb || 16.0,
      temperatureC: this.gpuInfo?.temperatureC || 45,
    };

    try {
      const res = await fetch(heartbeatUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });

      const nowIso = new Date().toISOString();
      saveProviderSettings({ last_heartbeat_at: nowIso });

      if (res.ok) {
        const data = await res.json();
        if (data.reputationScore) {
          this.reputationScore = data.reputationScore;
        }
        if (data.commands && Array.isArray(data.commands)) {
          for (const cmd of data.commands) {
            await this.handleCommand(cmd);
          }
        }
      }
    } catch (err: any) {
      // Offline fallback: update local heartbeat timestamp
      saveProviderSettings({ last_heartbeat_at: new Date().toISOString() });
    }
  }

  /**
   * Handles commands received from Billama Edge (e.g. unload model, pull model).
   */
  private async handleCommand(cmd: any): Promise<void> {
    console.log(`[Eluvix Provider] 📩 Processing command: ${cmd.type}`);
    if (cmd.type === 'CONFIG_APPLY') {
      const { targetModel, configPayload } = cmd.payload || {};
      if (this.config.engineType === 'ollama' && targetModel && configPayload) {
        try {
          await fetch(`${this.config.engineUrl}/api/create`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name: targetModel, modelfile: configPayload }),
          });
        } catch (e: any) {
          console.warn('[Eluvix Provider] Failed to apply Modelfile:', e.message);
        }
      }
    }
  }

  /**
   * Executes an incoming inference job from Billama Compute Grid.
   */
  public async executeJob(job: {
    jobId: string;
    model: string;
    messages: any[];
    maxTokens?: number;
    pricePerMTok?: number;
  }): Promise<any> {
    if (this.isPaused) {
      throw new Error('Provider is currently paused for local consumer activity or thermal limit.');
    }

    const startTime = Date.now();
    const promptTokens = JSON.stringify(job.messages).length / 4; // rough estimate
    const url = `${this.config.engineUrl.replace(/\/+$/, '')}/v1/chat/completions`;

    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: job.model,
          messages: job.messages,
          max_tokens: job.maxTokens,
          stream: false,
        }),
      });

      if (!res.ok) {
        throw new Error(`Engine returned ${res.status}: ${await res.text()}`);
      }

      const data = await res.json();
      const completionTokens = data.usage?.completion_tokens || 100;
      const totalTokens = (data.usage?.prompt_tokens || promptTokens) + completionTokens;
      const durationMs = Date.now() - startTime;

      // Calculate earnings: default ~$0.50 per 1M tokens or user floor
      const ratePerToken = (job.pricePerMTok || 0.50) / 1_000_000;
      const earnedUsd = totalTokens * ratePerToken;

      logProviderJob({
        job_id: job.jobId,
        model: job.model,
        prompt_tokens: data.usage?.prompt_tokens || promptTokens,
        completion_tokens: completionTokens,
        duration_ms: durationMs,
        earned_usd: earnedUsd,
        status: 'SUCCESS',
      });

      this.emit('job-completed', {
        jobId: job.jobId,
        totalTokens,
        earnedUsd,
        durationMs,
      });

      return data;
    } catch (err: any) {
      logProviderJob({
        job_id: job.jobId,
        model: job.model,
        status: 'ERROR',
        error_message: err.message,
      });
      throw err;
    }
  }
}
