'use client';

import { useState, useEffect, useMemo } from 'react';
import Link from 'next/link';

interface GpuInfo {
  vendor: string;
  model: string;
  count: number;
  vramTotalGb: number;
  vramFreeGb: number;
  temperatureC?: number;
  utilPercent?: number;
}

interface ProviderStatus {
  status: 'OFFLINE' | 'INITIALIZING' | 'ONLINE' | 'SERVING' | 'PAUSED' | 'ERROR';
  nodeId?: string;
  reputationScore: number;
  totalJobsCompleted: number;
  totalTokensServed: number;
  totalEarnedUsd: number;
  gpu?: GpuInfo;
  models?: string[];
  lastHeartbeatAt?: string;
  errorMessage?: string;
  rdma?: {
    available: boolean;
    driverLoaded: boolean;
    ibDevices: string[];
    hasLosslessRoce: boolean;
    pciP2pSupported: boolean;
    tuningChecklist: {
      item: string;
      status: 'pass' | 'warn' | 'fail';
      detail: string;
      remediation?: string;
    }[];
  };
}

interface JobLog {
  id: number;
  job_id: string;
  timestamp: string;
  model: string;
  prompt_tokens: number;
  completion_tokens: number;
  duration_ms: number;
  earned_usd: number;
  status: string;
  error_message?: string;
}

export default function ProviderPage() {
  const [status, setStatus] = useState<ProviderStatus | null>(null);
  const [recentJobs, setRecentJobs] = useState<JobLog[]>([]);
  const [loading, setLoading] = useState(true);
  const [actionLoading, setActionLoading] = useState(false);
  const [benchmarkLoading, setBenchmarkLoading] = useState(false);
  const [saveMessage, setSaveMessage] = useState<string | null>(null);

  // Form states
  const [serverUrl, setServerUrl] = useState('https://api.billama.dev');
  const [nodeToken, setNodeToken] = useState('');
  const [nodeName, setNodeName] = useState('');
  const [engineUrl, setEngineUrl] = useState('http://localhost:11434');
  const [engineType, setEngineType] = useState('ollama');
  const [pricingMode, setPricingMode] = useState('market');
  const [floorPriceIn, setFloorPriceIn] = useState(0.25);
  const [floorPriceOut, setFloorPriceOut] = useState(0.50);
  const [pauseOnUserActive, setPauseOnUserActive] = useState(true);
  const [maxGpuTempC, setMaxGpuTempC] = useState(82);

  // RDMA & Roofline Simulator state
  const [simModel, setSimModel] = useState<'llama-3.3-70b' | 'deepseek-v3' | 'llama-3.1-8b' | 'qwen-2.5-72b'>('llama-3.3-70b');
  const [simPrecision, setSimPrecision] = useState<'fp8' | 'bf16'>('fp8');
  const [simBandwidthGbps, setSimBandwidthGbps] = useState<100 | 200 | 400 | 800>(400);
  const [simTokens, setSimTokens] = useState<number>(4096);
  const [copiedCmd, setCopiedCmd] = useState<string | null>(null);

  const copyToClipboard = (cmd: string) => {
    navigator.clipboard.writeText(cmd);
    setCopiedCmd(cmd);
    setTimeout(() => setCopiedCmd(null), 2500);
  };

  const simResult = useMemo(() => {
    const bytesPerElement = simPrecision === 'fp8' ? 1 : 2;
    let bytesPerToken = 0;
    let layers = 80;
    let activeParamsB = 70;
    let archType = 'GQA (8 kv heads)';

    if (simModel === 'llama-3.3-70b') {
      layers = 80;
      activeParamsB = 70;
      bytesPerToken = 2 * 80 * 8 * 128 * bytesPerElement; // 163,840 bytes for fp8 = 160 KiB
      archType = 'GQA (8 kv heads)';
    } else if (simModel === 'deepseek-v3') {
      layers = 61;
      activeParamsB = 37; // active in MoE
      bytesPerToken = 61 * (512 + 64) * bytesPerElement; // 35,136 bytes for fp8 = 34.3 KiB
      archType = 'MLA (Latent Compression)';
    } else if (simModel === 'llama-3.1-8b') {
      layers = 32;
      activeParamsB = 8;
      bytesPerToken = 2 * 32 * 8 * 128 * bytesPerElement; // 65,536 bytes for fp8 = 64 KiB
      archType = 'GQA (8 kv heads)';
    } else if (simModel === 'qwen-2.5-72b') {
      layers = 80;
      activeParamsB = 72;
      bytesPerToken = 2 * 80 * 8 * 128 * bytesPerElement;
      archType = 'GQA (8 kv heads)';
    }

    const totalBytes = bytesPerToken * simTokens;
    const totalMb = totalBytes / (1024 * 1024);
    const wireBps = (simBandwidthGbps * 1e9) / 8; // B/s in decimal
    const rawWireTimeMs = (totalBytes / wireBps) * 1000;

    // H100 SXM5 FP8 dense roofline: 989.4 TFLOPS, 3.35 TB/s HBM3 -> Ridge: 295.3 FLOPs/B
    const prefillFlops = 2 * activeParamsB * 1e9 * simTokens;
    const effectiveTflops = 989.4 * 0.60 * 1e12; // 60% MFU on H100
    const prefillComputeTimeMs = (prefillFlops / effectiveTflops) * 1000;

    // Layer-pipelined overlap (NIXL / Mooncake RDMA)
    const singleLayerWireTimeMs = rawWireTimeMs / layers;
    const exposedLatencyMs = Number((singleLayerWireTimeMs + 0.005).toFixed(2));
    const overlapPct = Math.min(99.2, Number((((rawWireTimeMs - singleLayerWireTimeMs) / Math.max(1, rawWireTimeMs)) * 100).toFixed(1)));

    return {
      bytesPerTokenKb: (bytesPerToken / 1024).toFixed(1),
      totalMb: totalMb.toFixed(2),
      rawWireTimeMs: rawWireTimeMs.toFixed(1),
      prefillComputeTimeMs: prefillComputeTimeMs.toFixed(1),
      exposedLatencyMs,
      overlapPct,
      archType,
      layers,
      ridgePoint: 295.3,
    };
  }, [simModel, simPrecision, simBandwidthGbps, simTokens]);

  const fetchStatus = async () => {
    try {
      const res = await fetch('/api/v1/provider/status');
      const data = await res.json();
      if (data.success) {
        setStatus(data.status);
        if (data.settings) {
          setServerUrl(data.settings.server_url || 'https://api.billama.dev');
          setNodeToken(data.settings.node_token || '');
          setNodeName(data.settings.node_name || '');
          setEngineUrl(data.settings.engine_url || 'http://localhost:11434');
          setEngineType(data.settings.engine_type || 'ollama');
          setPricingMode(data.settings.pricing_mode || 'market');
          setFloorPriceIn(data.settings.floor_price_in || 0.25);
          setFloorPriceOut(data.settings.floor_price_out || 0.50);
          setPauseOnUserActive(Boolean(data.settings.pause_on_user_active ?? 1));
          setMaxGpuTempC(data.settings.max_gpu_temp_c || 82);
        }
        if (Array.isArray(data.recentJobs)) {
          setRecentJobs(data.recentJobs);
        }
      }
    } catch (err) {
      console.error('Failed to fetch provider status:', err);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchStatus();
    const interval = setInterval(fetchStatus, 4000);
    return () => clearInterval(interval);
  }, []);

  const handleToggle = async () => {
    setActionLoading(true);
    const newEnabled = status?.status === 'OFFLINE' || status?.status === 'ERROR';
    try {
      const res = await fetch('/api/v1/provider/toggle', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled: newEnabled })
      });
      const data = await res.json();
      if (data.success && data.status) {
        setStatus(data.status);
      }
    } catch (err) {
      console.error('Failed to toggle provider:', err);
    } finally {
      setActionLoading(false);
    }
  };

  const handleSaveConfig = async (e: React.FormEvent) => {
    e.preventDefault();
    setActionLoading(true);
    setSaveMessage('Saving settings...');
    try {
      const res = await fetch('/api/v1/provider/config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          serverUrl,
          nodeToken,
          nodeName,
          engineUrl,
          engineType,
          pricingMode,
          floorPriceIn,
          floorPriceOut,
          pauseOnUserActive,
          maxGpuTempC
        })
      });
      const data = await res.json();
      if (data.success) {
        setSaveMessage('✓ Configuration saved successfully!');
        if (data.status) setStatus(data.status);
        setTimeout(() => setSaveMessage(null), 3000);
      } else {
        setSaveMessage(`Failed: ${data.error}`);
      }
    } catch (err: any) {
      setSaveMessage(`Error: ${err.message}`);
    } finally {
      setActionLoading(false);
    }
  };

  const handleRunBenchmark = async () => {
    setBenchmarkLoading(true);
    try {
      const res = await fetch('/api/v1/provider/benchmark', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: status?.models?.[0] || 'llama3.1:8b'
        })
      });
      const data = await res.json();
      if (data.success) {
        alert('✓ Benchmark completed successfully! Output verified and earnings recorded.');
        fetchStatus();
      } else {
        alert(`Benchmark failed: ${data.error}`);
      }
    } catch (err: any) {
      alert(`Benchmark error: ${err.message}`);
    } finally {
      setBenchmarkLoading(false);
    }
  };

  const isOnline = status?.status === 'ONLINE' || status?.status === 'SERVING';
  const isPaused = status?.status === 'PAUSED';

  return (
    <div className="min-h-screen bg-slate-950 text-slate-100 p-6 md:p-12 font-sans">
      <div className="max-w-6xl mx-auto space-y-8">
        {/* Header */}
        <header className="flex flex-col md:flex-row justify-between items-start md:items-center pb-6 border-b border-slate-800 gap-4">
          <div>
            <div className="flex items-center gap-3">
              <Link
                href="/"
                className="text-xs font-semibold text-slate-400 hover:text-sky-400 bg-slate-900 border border-slate-800 px-3 py-1.5 rounded-lg transition"
              >
                ← Consumer Router
              </Link>
              <Link
                href="/docs"
                className="text-xs font-semibold text-sky-400 hover:text-sky-300 bg-slate-900 border border-sky-500/30 px-3 py-1.5 rounded-lg transition flex items-center gap-1"
              >
                <span>📖</span> Docs
              </Link>
              <div className="h-4 w-px bg-slate-800" />
              <h1 className="text-2xl font-black text-amber-400 flex items-center gap-2">
                <span>⚡</span> Sell GPU Time with Billama
              </h1>
            </div>
            <p className="text-slate-400 text-xs mt-1">
              Monetize your desktop or workstation GPU during idle periods. Consumer queries are always given instant priority.
            </p>
          </div>

          <div className="flex items-center gap-3">
            <button
              onClick={handleRunBenchmark}
              disabled={benchmarkLoading}
              className="bg-slate-900 hover:bg-slate-800 border border-slate-700 text-slate-200 text-xs px-3.5 py-2 rounded-lg font-medium transition disabled:opacity-50"
            >
              {benchmarkLoading ? 'Running Test...' : '🧪 Run Local Benchmark'}
            </button>
            <button
              onClick={handleToggle}
              disabled={actionLoading}
              className={`text-xs font-bold px-5 py-2 rounded-lg shadow-lg transition flex items-center gap-2 disabled:opacity-50 ${
                isOnline || isPaused
                  ? 'bg-rose-600 hover:bg-rose-500 text-white shadow-rose-600/20'
                  : 'bg-emerald-500 hover:bg-emerald-400 text-slate-950 shadow-emerald-500/20'
              }`}
            >
              <span>{isOnline || isPaused ? '⏹ Stop Sharing' : '▶ Start Sharing GPU'}</span>
            </button>
          </div>
        </header>

        {/* Live Status Hero Banner */}
        <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
          <div className="bg-slate-900/80 border border-slate-800 rounded-xl p-5 shadow-lg relative overflow-hidden">
            <div className="text-[11px] font-semibold uppercase tracking-wider text-slate-400 mb-1">Node Status</div>
            <div className="flex items-center gap-2">
              <span
                className={`w-3 h-3 rounded-full ${
                  loading
                    ? 'bg-slate-500 animate-pulse'
                    : isOnline
                    ? 'bg-emerald-400 animate-pulse'
                    : isPaused
                    ? 'bg-amber-400'
                    : 'bg-slate-600'
                }`}
              />
              <span className="text-lg font-bold text-slate-100">
                {loading ? 'CONNECTING...' : status?.status || 'OFFLINE'}
              </span>
            </div>
            <div className="text-[11px] text-slate-500 mt-2 font-mono truncate">
              ID: {status?.nodeId || 'Unregistered'}
            </div>
          </div>

          <div className="bg-slate-900/80 border border-slate-800 rounded-xl p-5 shadow-lg">
            <div className="text-[11px] font-semibold uppercase tracking-wider text-slate-400 mb-1">Total Earned</div>
            <div className="text-2xl font-black text-emerald-400">
              ${(status?.totalEarnedUsd || 0).toFixed(4)}
            </div>
            <div className="text-[11px] text-slate-500 mt-1">
              {status?.reputationScore || 100}% Network Reputation
            </div>
          </div>

          <div className="bg-slate-900/80 border border-slate-800 rounded-xl p-5 shadow-lg">
            <div className="text-[11px] font-semibold uppercase tracking-wider text-slate-400 mb-1">Tokens Served</div>
            <div className="text-2xl font-black text-sky-400">
              {(status?.totalTokensServed || 0).toLocaleString()}
            </div>
            <div className="text-[11px] text-slate-500 mt-1">
              Across {status?.totalJobsCompleted || 0} completed jobs
            </div>
          </div>

          <div className="bg-slate-900/80 border border-slate-800 rounded-xl p-5 shadow-lg">
            <div className="text-[11px] font-semibold uppercase tracking-wider text-slate-400 mb-1">Detected GPU</div>
            <div className="text-sm font-bold text-slate-200 truncate">
              {status?.gpu?.model || 'Detecting GPU...'}
            </div>
            <div className="text-[11px] text-slate-400 mt-1 flex items-center justify-between">
              <span>{status?.gpu?.vramTotalGb || 0} GB VRAM</span>
              <span>{status?.gpu?.temperatureC || 45}°C</span>
            </div>
          </div>
        </div>

        {/* Priority & Preemption Safeguard Note */}
        <div className="p-4 rounded-xl border border-sky-900/60 bg-sky-950/20 flex items-start gap-3 text-xs text-sky-300">
          <span className="text-base mt-0.5">🛡️</span>
          <div>
            <strong className="text-sky-200">Consumer Zero-Lag Guarantee:</strong> Whenever you send a request via your local Eluvix proxy, provider compute jobs automatically yield and pause immediately. Your local applications, coding harnesses (OpenCode, Cursor), and games retain 100% GPU priority.
          </div>
        </div>

        {/* Configuration & Settings Grid */}
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-8">
          {/* Settings Form */}
          <div className="lg:col-span-2 bg-slate-900/70 border border-slate-800 rounded-xl p-6 shadow-xl">
            <h2 className="text-base font-bold text-slate-200 mb-4 flex items-center gap-2">
              <span>⚙️</span> Provider Settings &amp; Safeguards
            </h2>

            <form onSubmit={handleSaveConfig} className="space-y-4 text-xs">
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div>
                  <label className="block text-slate-400 font-medium mb-1">Billama Gateway URL</label>
                  <input
                    type="text"
                    value={serverUrl}
                    onChange={(e) => setServerUrl(e.target.value)}
                    placeholder="https://api.billama.dev"
                    className="w-full bg-slate-950 border border-slate-800 rounded-lg px-3 py-2 text-slate-200 font-mono focus:border-amber-400 outline-none"
                  />
                </div>
                <div>
                  <label className="block text-slate-400 font-medium mb-1">Node Token (from Billama dashboard)</label>
                  <input
                    type="password"
                    value={nodeToken}
                    onChange={(e) => setNodeToken(e.target.value)}
                    placeholder="blm_node_... (optional for local/test)"
                    className="w-full bg-slate-950 border border-slate-800 rounded-lg px-3 py-2 text-slate-200 font-mono focus:border-amber-400 outline-none"
                  />
                </div>
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div>
                  <label className="block text-slate-400 font-medium mb-1">Local Inference Engine</label>
                  <select
                    value={engineType}
                    onChange={(e) => setEngineType(e.target.value)}
                    className="w-full bg-slate-950 border border-slate-800 rounded-lg px-3 py-2 text-slate-200 focus:border-amber-400 outline-none"
                  >
                    <option value="ollama">Ollama (Default :11434)</option>
                    <option value="vllm">vLLM (:8000)</option>
                    <option value="lemonade">Lemonade Router (:13305)</option>
                    <option value="openai-compatible">Custom OpenAI Compatible</option>
                  </select>
                </div>
                <div>
                  <label className="block text-slate-400 font-medium mb-1">Engine Endpoint</label>
                  <input
                    type="text"
                    value={engineUrl}
                    onChange={(e) => setEngineUrl(e.target.value)}
                    placeholder="http://localhost:11434"
                    className="w-full bg-slate-950 border border-slate-800 rounded-lg px-3 py-2 text-slate-200 font-mono focus:border-amber-400 outline-none"
                  />
                </div>
              </div>

              <div className="border-t border-slate-800 pt-4 grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div>
                  <label className="block text-slate-400 font-medium mb-1">Pricing Strategy</label>
                  <select
                    value={pricingMode}
                    onChange={(e) => setPricingMode(e.target.value)}
                    className="w-full bg-slate-950 border border-slate-800 rounded-lg px-3 py-2 text-slate-200 focus:border-amber-400 outline-none"
                  >
                    <option value="market">Market Dynamic (Recommended)</option>
                    <option value="floor">Strict Floor Price</option>
                  </select>
                </div>
                {pricingMode === 'floor' && (
                  <div className="flex gap-2">
                    <div className="flex-1">
                      <label className="block text-slate-400 font-medium mb-1">Floor ($/1M Prompt)</label>
                      <input
                        type="number"
                        step="0.01"
                        value={floorPriceIn}
                        onChange={(e) => setFloorPriceIn(parseFloat(e.target.value) || 0)}
                        className="w-full bg-slate-950 border border-slate-800 rounded-lg px-3 py-2 text-slate-200 font-mono focus:border-amber-400 outline-none"
                      />
                    </div>
                    <div className="flex-1">
                      <label className="block text-slate-400 font-medium mb-1">Floor ($/1M Completion)</label>
                      <input
                        type="number"
                        step="0.01"
                        value={floorPriceOut}
                        onChange={(e) => setFloorPriceOut(parseFloat(e.target.value) || 0)}
                        className="w-full bg-slate-950 border border-slate-800 rounded-lg px-3 py-2 text-slate-200 font-mono focus:border-amber-400 outline-none"
                      />
                    </div>
                  </div>
                )}
              </div>

              <div className="border-t border-slate-800 pt-4 space-y-3">
                <label className="flex items-center gap-2 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={pauseOnUserActive}
                    onChange={(e) => setPauseOnUserActive(e.target.checked)}
                    className="rounded bg-slate-950 border-slate-700 text-amber-500 focus:ring-0"
                  />
                  <span className="text-slate-200 font-medium">
                    Automatically pause provider when local desktop user queries Eluvix
                  </span>
                </label>

                <div>
                  <div className="flex justify-between text-slate-400 font-medium mb-1">
                    <span>Max GPU Temperature Threshold</span>
                    <span className="text-amber-400 font-mono">{maxGpuTempC}°C</span>
                  </div>
                  <input
                    type="range"
                    min="60"
                    max="90"
                    value={maxGpuTempC}
                    onChange={(e) => setMaxGpuTempC(parseInt(e.target.value, 10))}
                    className="w-full accent-amber-500"
                  />
                  <span className="text-[11px] text-slate-500">
                    If GPU exceeds this temperature, the agent will pause jobs until cooling.
                  </span>
                </div>
              </div>

              {saveMessage && (
                <div className="p-2.5 rounded bg-slate-800 text-sky-300 font-medium text-xs">
                  {saveMessage}
                </div>
              )}

              <div className="pt-2 flex justify-end">
                <button
                  type="submit"
                  disabled={actionLoading}
                  className="bg-amber-500 hover:bg-amber-400 text-slate-950 font-bold px-4 py-2 rounded-lg transition disabled:opacity-50"
                >
                  Save Settings
                </button>
              </div>
            </form>
          </div>

          {/* Right Column: Models & Payout Info */}
          <div className="space-y-6">
            <div className="bg-slate-900/70 border border-slate-800 rounded-xl p-5 shadow-xl space-y-3">
              <h3 className="text-sm font-bold text-slate-200">📦 Discovered Local Models</h3>
              <p className="text-[11px] text-slate-400">
                Models available to serve incoming Billama Grid token traffic:
              </p>
              <div className="flex flex-wrap gap-1.5 max-h-48 overflow-y-auto">
                {status?.models && status.models.length > 0 ? (
                  status.models.map((m) => (
                    <span
                      key={m}
                      className="text-[10px] bg-slate-950 border border-slate-800 text-slate-300 px-2 py-1 rounded font-mono"
                    >
                      {m}
                    </span>
                  ))
                ) : (
                  <span className="text-xs text-slate-500 italic">No models currently loaded</span>
                )}
              </div>
            </div>

            <div className="bg-slate-900/70 border border-slate-800 rounded-xl p-5 shadow-xl space-y-3">
              <h3 className="text-sm font-bold text-slate-200">💳 Payout &amp; Settlement</h3>
              <p className="text-[11px] text-slate-400 leading-relaxed">
                Earnings accrue automatically in USD. Providers can redeem earned balances for Billama cloud compute credits, or request monthly payouts via Stripe Connect or crypto settlement.
              </p>
              <div className="p-3 bg-slate-950 rounded-lg border border-slate-800 text-xs flex justify-between items-center">
                <span className="text-slate-400">Redemption Status:</span>
                <span className="text-emerald-400 font-bold">Active</span>
              </div>
            </div>
          </div>
        </div>

        {/* RoCEv2 & GPUDirect RDMA Readiness Checklist */}
        <div className="bg-slate-900/70 border border-slate-800 rounded-xl p-6 shadow-xl space-y-4">
          <div className="flex flex-col md:flex-row justify-between items-start md:items-center pb-3 border-b border-slate-800 gap-2">
            <div>
              <div className="flex items-center gap-2">
                <span className="text-xs font-bold text-sky-400 uppercase tracking-wider">Hardware Fabric Probe</span>
                <span className={`text-[10px] px-2 py-0.5 rounded font-mono font-semibold border ${
                  status?.rdma?.available
                    ? 'bg-emerald-950 text-emerald-300 border-emerald-800'
                    : 'bg-slate-850 text-slate-400 border-slate-700'
                }`}>
                  {status?.rdma?.available ? 'RDMA / RoCEv2 Capable' : 'Standard Host Network (TCP/IP)'}
                </span>
              </div>
              <h2 className="text-base font-bold text-slate-100 mt-1">
                RoCEv2 &amp; GPUDirect RDMA Fabric Readiness
              </h2>
            </div>
            <div className="text-[11px] text-slate-400">
              Mellanox ConnectX / InfiniBand &bull; nvidia-peermem &bull; PFC / ECN
            </div>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
            <div className="bg-slate-950/80 border border-slate-800 rounded-lg p-3">
              <span className="text-[11px] text-slate-400">Kernel Driver (nvidia-peermem)</span>
              <div className="mt-1 font-mono text-xs font-bold flex items-center gap-1.5">
                <span className={`w-2 h-2 rounded-full ${status?.rdma?.driverLoaded ? 'bg-emerald-400' : 'bg-amber-400'}`} />
                <span className={status?.rdma?.driverLoaded ? 'text-emerald-300' : 'text-amber-300'}>
                  {status?.rdma?.driverLoaded ? 'Loaded' : 'Not Detected'}
                </span>
              </div>
            </div>

            <div className="bg-slate-950/80 border border-slate-800 rounded-lg p-3">
              <span className="text-[11px] text-slate-400">InfiniBand / RoCE Devices</span>
              <div className="mt-1 font-mono text-xs font-bold text-slate-200 truncate">
                {status?.rdma?.ibDevices && status.rdma.ibDevices.length > 0
                  ? status.rdma.ibDevices.join(', ')
                  : 'None detected'}
              </div>
            </div>

            <div className="bg-slate-950/80 border border-slate-800 rounded-lg p-3">
              <span className="text-[11px] text-slate-400">Lossless RoCE (PFC / ECN)</span>
              <div className="mt-1 font-mono text-xs font-bold flex items-center gap-1.5">
                <span className={`w-2 h-2 rounded-full ${status?.rdma?.hasLosslessRoce ? 'bg-emerald-400' : 'bg-slate-500'}`} />
                <span className={status?.rdma?.hasLosslessRoce ? 'text-emerald-300' : 'text-slate-400'}>
                  {status?.rdma?.hasLosslessRoce ? 'Configured' : 'DSCP Default'}
                </span>
              </div>
            </div>

            <div className="bg-slate-950/80 border border-slate-800 rounded-lg p-3">
              <span className="text-[11px] text-slate-400">PCIe P2P Direct DMA</span>
              <div className="mt-1 font-mono text-xs font-bold flex items-center gap-1.5">
                <span className={`w-2 h-2 rounded-full ${status?.rdma?.pciP2pSupported ? 'bg-emerald-400' : 'bg-slate-500'}`} />
                <span className={status?.rdma?.pciP2pSupported ? 'text-emerald-300' : 'text-slate-400'}>
                  {status?.rdma?.pciP2pSupported ? 'Supported' : 'Check IOMMU/ACS'}
                </span>
              </div>
            </div>
          </div>

          {/* Tuning Checklist Table */}
          {status?.rdma?.tuningChecklist && status.rdma.tuningChecklist.length > 0 && (
            <div className="border border-slate-800 rounded-lg overflow-hidden bg-slate-950/60 mt-3">
              <table className="w-full text-left text-xs font-sans">
                <thead className="bg-slate-900/90 text-slate-400 font-semibold border-b border-slate-800">
                  <tr>
                    <th className="p-2.5 w-16">Status</th>
                    <th className="p-2.5 w-48">Check Item</th>
                    <th className="p-2.5">Details &amp; Tuning Recommendation</th>
                    <th className="p-2.5 w-24 text-right">Action</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-850">
                  {status.rdma.tuningChecklist.map((check, idx) => (
                    <tr key={idx} className="hover:bg-slate-900/40">
                      <td className="p-2.5">
                        <span className={`text-[10px] font-bold px-1.5 py-0.5 rounded font-mono ${
                          check.status === 'pass'
                            ? 'bg-emerald-950 text-emerald-400 border border-emerald-800'
                            : check.status === 'warn'
                            ? 'bg-amber-950 text-amber-400 border border-amber-800'
                            : 'bg-rose-950 text-rose-400 border border-rose-800'
                        }`}>
                          {check.status.toUpperCase()}
                        </span>
                      </td>
                      <td className="p-2.5 font-semibold text-slate-200">{check.item}</td>
                      <td className="p-2.5 text-slate-400 text-[11px] leading-relaxed">
                        {check.detail}
                      </td>
                      <td className="p-2.5 text-right">
                        {check.remediation ? (
                          <button
                            type="button"
                            onClick={() => copyToClipboard(check.remediation!)}
                            className="bg-slate-800 hover:bg-slate-700 text-sky-300 text-[11px] font-mono px-2 py-1 rounded border border-slate-700 transition"
                            title={check.remediation}
                          >
                            {copiedCmd === check.remediation ? 'Copied!' : 'Copy Fix'}
                          </button>
                        ) : (
                          <span className="text-slate-600 text-[11px]">-</span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>

        {/* Interactive Roofline & Disaggregated KV-Transfer Simulator */}
        <div className="bg-slate-900/70 border border-slate-800 rounded-xl p-6 shadow-xl space-y-5">
          <div className="flex flex-col md:flex-row justify-between items-start md:items-center pb-3 border-b border-slate-800 gap-2">
            <div>
              <div className="flex items-center gap-2">
                <span className="text-xs font-bold text-indigo-400 uppercase tracking-wider">Roofline &amp; Network Lab</span>
                <span className="bg-indigo-950 text-indigo-300 text-[10px] px-2 py-0.5 rounded border border-indigo-800 font-mono font-semibold">
                  Disaggregation Simulator
                </span>
              </div>
              <h2 className="text-base font-bold text-slate-100 mt-1">
                Prefill-Decode KV Transfer &amp; Arithmetic Intensity Modeling
              </h2>
            </div>
            <div className="text-[11px] text-slate-400">
              Simulates GQA vs. DeepSeek MLA across 100G/200G/400G/800G RDMA fabrics
            </div>
          </div>

          {/* Interactive Controls */}
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4 text-xs">
            {/* Model Architecture */}
            <div>
              <label className="block text-slate-400 font-medium mb-1">Target Model Architecture</label>
              <select
                value={simModel}
                onChange={(e) => setSimModel(e.target.value as any)}
                className="w-full bg-slate-950 border border-slate-800 rounded-lg px-3 py-2 text-slate-200 focus:border-indigo-400 outline-none"
              >
                <option value="llama-3.3-70b">Llama-3.3-70B (80 layers, GQA-8)</option>
                <option value="deepseek-v3">DeepSeek-V3 / R1 (61 layers, MLA)</option>
                <option value="llama-3.1-8b">Llama-3.1-8B (32 layers, GQA-8)</option>
                <option value="qwen-2.5-72b">Qwen-2.5-72B (80 layers, GQA-8)</option>
              </select>
            </div>

            {/* Precision */}
            <div>
              <label className="block text-slate-400 font-medium mb-1">KV Cache Precision</label>
              <div className="flex gap-2">
                {(['fp8', 'bf16'] as const).map((p) => (
                  <button
                    key={p}
                    type="button"
                    onClick={() => setSimPrecision(p)}
                    className={`flex-1 py-2 px-3 rounded-lg border text-xs font-mono uppercase transition ${
                      simPrecision === p
                        ? 'bg-indigo-600 border-indigo-500 text-white font-bold'
                        : 'bg-slate-950 border-slate-800 text-slate-400 hover:text-slate-200'
                    }`}
                  >
                    {p} ({p === 'fp8' ? '1 byte' : '2 bytes'})
                  </button>
                ))}
              </div>
            </div>

            {/* Network Fabric Bandwidth */}
            <div>
              <label className="block text-slate-400 font-medium mb-1">RDMA Fabric Bandwidth</label>
              <div className="grid grid-cols-4 gap-1">
                {([100, 200, 400, 800] as const).map((bw) => (
                  <button
                    key={bw}
                    type="button"
                    onClick={() => setSimBandwidthGbps(bw)}
                    className={`py-2 px-1 text-center rounded-lg border text-[11px] font-mono transition ${
                      simBandwidthGbps === bw
                        ? 'bg-sky-600 border-sky-500 text-white font-bold'
                        : 'bg-slate-950 border-slate-800 text-slate-400 hover:text-slate-200'
                    }`}
                  >
                    {bw}G
                  </button>
                ))}
              </div>
            </div>

            {/* Prompt Length */}
            <div>
              <div className="flex justify-between text-slate-400 font-medium mb-1">
                <span>Prompt Context</span>
                <span className="text-sky-400 font-mono">{simTokens.toLocaleString()} tokens</span>
              </div>
              <input
                type="range"
                min="512"
                max="65536"
                step="512"
                value={simTokens}
                onChange={(e) => setSimTokens(parseInt(e.target.value, 10))}
                className="w-full accent-sky-500"
              />
            </div>
          </div>

          {/* Simulation Output Cards */}
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4 pt-2">
            {/* KV Cache Footprint */}
            <div className="bg-slate-950/80 border border-slate-800 rounded-lg p-4">
              <div className="flex justify-between items-center text-xs text-slate-400">
                <span>KV Footprint</span>
                <span className="text-[10px] bg-slate-900 border border-slate-800 text-slate-300 px-1.5 py-0.5 rounded font-mono">
                  {simResult.archType}
                </span>
              </div>
              <div className="mt-2 text-2xl font-bold text-amber-400 font-mono">
                {simResult.totalMb} <span className="text-xs text-slate-400 font-normal">MB</span>
              </div>
              <div className="text-[11px] text-slate-400 mt-1 font-mono">
                Unit rate: <span className="text-slate-200 font-semibold">{simResult.bytesPerTokenKb} KiB/token</span>
              </div>
            </div>

            {/* Wire Transfer vs Prefill Compute */}
            <div className="bg-slate-950/80 border border-slate-800 rounded-lg p-4">
              <div className="flex justify-between items-center text-xs text-slate-400">
                <span>Raw Wire Transfer</span>
                <span className="text-[10px] text-sky-400 font-mono">{simBandwidthGbps} Gbps</span>
              </div>
              <div className="mt-2 text-2xl font-bold text-sky-400 font-mono">
                {simResult.rawWireTimeMs} <span className="text-xs text-slate-400 font-normal">ms</span>
              </div>
              <div className="text-[11px] text-slate-400 mt-1 font-mono">
                Compute duration: <span className="text-slate-200 font-semibold">{simResult.prefillComputeTimeMs} ms</span>
              </div>
            </div>

            {/* Layer-Pipelined Overlap */}
            <div className="bg-slate-950/80 border border-slate-800 rounded-lg p-4">
              <div className="flex justify-between items-center text-xs text-slate-400">
                <span>Pipelined RDMA Overlap</span>
                <span className="text-[10px] bg-emerald-950 border border-emerald-800 text-emerald-300 px-1.5 py-0.5 rounded font-mono">
                  NIXL / Mooncake
                </span>
              </div>
              <div className="mt-2 text-2xl font-bold text-emerald-400 font-mono">
                {simResult.overlapPct}%
              </div>
              <div className="text-[11px] text-slate-400 mt-1 font-mono">
                Exposed TTFT overhead: <span className="text-emerald-300 font-semibold">~{simResult.exposedLatencyMs} ms</span>
              </div>
            </div>

            {/* Roofline Operational Regime */}
            <div className="bg-slate-950/80 border border-slate-800 rounded-lg p-4">
              <div className="flex justify-between items-center text-xs text-slate-400">
                <span>Roofline Ridge Point</span>
                <span className="text-[10px] text-indigo-400 font-mono">H100 FP8</span>
              </div>
              <div className="mt-2 text-2xl font-bold text-indigo-400 font-mono">
                {simResult.ridgePoint} <span className="text-xs text-slate-400 font-normal">FLOPs/B</span>
              </div>
              <div className="text-[11px] text-slate-400 mt-1">
                Prefill: <span className="text-purple-300 font-mono font-semibold">Compute-Bound</span> &bull; Decode: <span className="text-amber-300 font-mono font-semibold">Memory-Bound</span>
              </div>
            </div>
          </div>
        </div>

        {/* Live Job Feed */}
        <div className="bg-slate-900/70 border border-slate-800 rounded-xl p-6 shadow-xl">
          <h2 className="text-base font-bold text-slate-200 mb-4 flex items-center justify-between">
            <span className="flex items-center gap-2">
              <span>📋</span> Recent Provider Compute Jobs
            </span>
            <span className="text-xs font-normal text-slate-400">
              {recentJobs.length} logged events
            </span>
          </h2>

          <div className="overflow-x-auto">
            <table className="w-full text-left text-xs font-mono">
              <thead>
                <tr className="border-b border-slate-800 text-slate-400 font-semibold">
                  <th className="pb-2">Job ID</th>
                  <th className="pb-2">Model</th>
                  <th className="pb-2">Tokens</th>
                  <th className="pb-2">Duration</th>
                  <th className="pb-2">Earned</th>
                  <th className="pb-2">Status</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-800/60">
                {recentJobs.length > 0 ? (
                  recentJobs.map((job) => (
                    <tr key={job.id} className="hover:bg-slate-800/30 transition">
                      <td className="py-2.5 text-slate-400">{job.job_id.slice(0, 14)}...</td>
                      <td className="py-2.5 text-slate-200">{job.model}</td>
                      <td className="py-2.5 text-slate-300">
                        {job.prompt_tokens + job.completion_tokens}
                      </td>
                      <td className="py-2.5 text-slate-400">{job.duration_ms}ms</td>
                      <td className="py-2.5 text-emerald-400 font-bold">
                        +${job.earned_usd.toFixed(5)}
                      </td>
                      <td className="py-2.5">
                        <span
                          className={`text-[10px] px-2 py-0.5 rounded font-semibold ${
                            job.status === 'SUCCESS'
                              ? 'bg-emerald-950 text-emerald-300 border border-emerald-800'
                              : 'bg-rose-950 text-rose-300 border border-rose-800'
                          }`}
                        >
                          {job.status}
                        </span>
                      </td>
                    </tr>
                  ))
                ) : (
                  <tr>
                    <td colSpan={6} className="py-6 text-center text-slate-500 italic">
                      No jobs executed yet. Start sharing GPU to begin receiving incoming requests!
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </div>
      </div>
    </div>
  );
}
