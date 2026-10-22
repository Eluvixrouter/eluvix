'use client';

import { useState, useEffect } from 'react';
import Link from 'next/link';

import type { RouterConfig, UpstreamConfig } from '@eluvix/router-core';
import { DEFAULT_CONFIG } from '@/lib/default-config';

interface DockerService {
  name: string;
  container: string;
  port: number;
  running: boolean;
  status: 'running' | 'exited' | 'not_created';
  url: string;
}

interface DockerStatusResponse {
  installed: boolean;
  running: boolean;
  version?: string | null;
  composeVersion?: string | null;
  allRunning?: boolean;
  services?: DockerService[];
  message?: string;
  error?: string;
}

export default function Home() {
  const [config, setConfig] = useState<RouterConfig>(DEFAULT_CONFIG);
  const [saveStatus, setSaveStatus] = useState<string | null>(null);
  const [copiedSnippet, setCopiedSnippet] = useState(false);
  const [billamaKey, setBillamaKey] = useState('');
  const [detectingMap, setDetectingMap] = useState<Record<string, boolean>>({});
  const [detectResults, setDetectResults] = useState<Record<string, { count: number; message: string; isError?: boolean }>>({});
  const [isDetectingAll, setIsDetectingAll] = useState(false);
  const [baseUrl, setBaseUrl] = useState('http://localhost:3588');

  // Docker status & orchestration state
  const [dockerStatus, setDockerStatus] = useState<DockerStatusResponse | null>(null);
  const [dockerLoading, setDockerLoading] = useState(false);
  const [dockerActionMessage, setDockerActionMessage] = useState<string | null>(null);
  const [analytics, setAnalytics] = useState<any>(null);

  useEffect(() => {
    if (typeof window !== 'undefined') {
      setBaseUrl(window.location.origin);
    }
    fetch('/api/v1/config')
      .then((res) => res.json())
      .then((data: RouterConfig) => {
        if (data && Array.isArray(data.upstreams)) {
          setConfig(data);
          const billama = data.upstreams.find((u) => u.type === 'billama' || u.id === 'billama-cloud');
          if (billama && billama.apiKey) {
            setBillamaKey(billama.apiKey);
          }
        }
      })
      .catch((err) => console.warn('Could not fetch initial config, using defaults', err));

    fetchDockerStatus();
    fetchAnalytics();
  }, []);

  const handleUpdateEndpoint = (index: number, newEndpoint: string) => {
    const updated = [...config.upstreams];
    updated[index] = { ...updated[index], endpoint: newEndpoint };
    setConfig({ ...config, upstreams: updated });
  };

  const handleUpdateName = (index: number, newName: string) => {
    const updated = [...config.upstreams];
    updated[index] = { ...updated[index], name: newName };
    setConfig({ ...config, upstreams: updated });
  };

  const handleUpdateType = (index: number, newType: UpstreamConfig['type']) => {
    const updated = [...config.upstreams];
    const current = updated[index];
    updated[index] = {
      ...current,
      type: newType,
      ...(newType === 'harness'
        ? {
            endpoint: current.endpoint === 'http://localhost:11434' ? 'http://localhost:8790' : current.endpoint,
            models: current.models.length === 1 && current.models[0] === '*' ? ['harness/trueforge', 'trueforge/default'] : current.models,
            harness: current.harness || {
              kind: 'trueforge',
              agentId: 'default',
              approvals: 'auto-approve-readonly',
              sessionMode: 'per-eluvix-session',
              providerIsLocal: true
            }
          }
        : {})
    };
    setConfig({ ...config, upstreams: updated });
  };

  const handleUpdatePriority = (index: number, newPriority: number) => {
    const updated = [...config.upstreams];
    updated[index] = { ...updated[index], priority: newPriority };
    setConfig({ ...config, upstreams: updated });
  };

  const handleUpdateModels = (index: number, modelsStr: string) => {
    const updated = [...config.upstreams];
    const modelsArr = modelsStr.split(',').map((m) => m.trim()).filter(Boolean);
    updated[index] = { ...updated[index], models: modelsArr };
    setConfig({ ...config, upstreams: updated });
  };

  const handleAddUpstream = () => {
    const newUpstream: UpstreamConfig = {
      id: `custom-${Date.now()}`,
      name: 'New Custom Upstream',
      type: 'openai-compatible',
      endpoint: 'http://localhost:11434',
      priority: 10,
      models: ['*']
    };
    setConfig({
      ...config,
      upstreams: [...config.upstreams, newUpstream]
    });
  };

  const handleRemoveUpstream = (index: number) => {
    const updated = config.upstreams.filter((_, i) => i !== index);
    setConfig({ ...config, upstreams: updated });
  };

  const handleDetectModels = async (index: number) => {
    const upstream = config.upstreams[index];
    if (!upstream) return;

    setDetectingMap((prev) => ({ ...prev, [upstream.id]: true }));
    try {
      const res = await fetch('/api/v1/detect-models', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          id: upstream.id,
          name: upstream.name,
          type: upstream.type,
          endpoint: upstream.endpoint,
          apiKey: upstream.apiKey
        })
      });

      const data = await res.json();
      if (data.success && Array.isArray(data.models) && data.models.length > 0) {
        const updated = [...config.upstreams];
        updated[index] = { ...updated[index], models: data.models };
        setConfig({ ...config, upstreams: updated });
        setDetectResults((prev) => ({
          ...prev,
          [upstream.id]: {
            count: data.models.length,
            message: `Found ${data.models.length} model(s): ${data.models.join(', ')}`,
            isError: false
          }
        }));
      } else {
        setDetectResults((prev) => ({
          ...prev,
          [upstream.id]: {
            count: 0,
            message: data.message || data.error || `No models detected at ${upstream.endpoint}. Server may be offline.`,
            isError: true
          }
        }));
      }
    } catch (err: any) {
      setDetectResults((prev) => ({
        ...prev,
        [upstream.id]: {
          count: 0,
          message: `Detection failed: ${err.message || 'Network error'}`,
          isError: true
        }
      }));
    } finally {
      setDetectingMap((prev) => ({ ...prev, [upstream.id]: false }));
    }
  };

  const handleDetectAllModels = async () => {
    setIsDetectingAll(true);
    setSaveStatus('Detecting models across all active upstreams...');
    try {
      const res = await fetch('/api/v1/detect-models', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ all: true })
      });

      const data = await res.json();
      if (data.success && data.detected) {
        let totalCount = 0;
        const newDetectResults: Record<string, { count: number; message: string; isError?: boolean }> = {};
        const updated = config.upstreams.map((u) => {
          const detectedList = data.detected[u.id];
          if (detectedList && detectedList.length > 0) {
            totalCount += detectedList.length;
            newDetectResults[u.id] = {
              count: detectedList.length,
              message: `Detected ${detectedList.length} model(s)`,
              isError: false
            };
            return { ...u, models: detectedList };
          } else {
            newDetectResults[u.id] = {
              count: 0,
              message: `No models detected at ${u.endpoint}`,
              isError: true
            };
            return u;
          }
        });

        setConfig({ ...config, upstreams: updated });
        setDetectResults((prev) => ({ ...prev, ...newDetectResults }));
        setSaveStatus(`Batch detection completed! Found ${totalCount} model(s) across active endpoints.`);
        setTimeout(() => setSaveStatus(null), 4000);
      }
    } catch (err: any) {
      setSaveStatus(`Failed to batch detect models: ${err.message}`);
    } finally {
      setIsDetectingAll(false);
    }
  };

  const handleSaveConfig = async () => {
    setSaveStatus('Saving...');
    try {
      // Sync Billama key if changed
      const upstreamsWithKey = config.upstreams.map((u) => {
        if (u.type === 'billama' || u.id === 'billama-cloud') {
          return { ...u, apiKey: billamaKey };
        }
        return u;
      });

      const payload = { ...config, upstreams: upstreamsWithKey };
      const res = await fetch('/api/v1/config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });

      if (res.ok) {
        setSaveStatus('Settings saved successfully!');
        setTimeout(() => setSaveStatus(null), 3000);
      } else {
        setSaveStatus('Failed to save settings');
      }
    } catch (err) {
      console.error(err);
      setSaveStatus('Error saving settings');
    }
  };

  const handleCopySnippet = () => {
    const snippet = `export OPENAI_BASE_URL="${baseUrl}/api/v1"\nexport OPENAI_API_KEY="sk-eluvix-local"`;
    navigator.clipboard.writeText(snippet);
    setCopiedSnippet(true);
    setTimeout(() => setCopiedSnippet(false), 2000);
  };

  const fetchAnalytics = async () => {
    try {
      const res = await fetch("/api/v1/analytics");
      const data = await res.json();
      if (data.success) setAnalytics(data.data);
    } catch (err) {
      console.error("Failed to fetch analytics:", err);
    }
  };

  const fetchDockerStatus = async () => {
    setDockerLoading(true);
    try {
      const res = await fetch('/api/v1/docker/status');
      const data = await res.json();
      setDockerStatus(data);
    } catch (err) {
      console.error('Failed to fetch Docker status:', err);
    } finally {
      setDockerLoading(false);
    }
  };

  const handleDockerUp = async () => {
    setDockerLoading(true);
    setDockerActionMessage('🚀 Launching containers (switchyard, vllm-sr, ollama, vllm, agent-router, agentgateway, openviking, trueforge)...');
    try {
      const res = await fetch('/api/v1/docker/up', { method: 'POST' });
      const data = await res.json();
      if (data.success) {
        setDockerActionMessage('✓ Container stack started! Refreshing service status...');
        setTimeout(() => {
          fetchDockerStatus();
          setDockerActionMessage(null);
        }, 4000);
      } else {
        setDockerActionMessage(`Failed: ${data.error || 'Unknown error'}`);
      }
    } catch (err) {
      const e = err as Error;
      setDockerActionMessage(`Error: ${e.message}`);
    } finally {
      setDockerLoading(false);
    }
  };

  const handleDockerDown = async () => {
    setDockerLoading(true);
    setDockerActionMessage('🛑 Stopping container stack...');
    try {
      const res = await fetch('/api/v1/docker/down', { method: 'POST' });
      const data = await res.json();
      if (data.success) {
        setDockerActionMessage('✓ Container stack stopped.');
        setTimeout(() => {
          fetchDockerStatus();
          setDockerActionMessage(null);
        }, 2000);
      } else {
        setDockerActionMessage(`Failed: ${data.error || 'Unknown error'}`);
      }
    } catch (err) {
      const e = err as Error;
      setDockerActionMessage(`Error: ${e.message}`);
    } finally {
      setDockerLoading(false);
    }
  };

  return (
    <main className="flex min-h-screen flex-col items-center p-8 md:p-16 bg-slate-950 text-slate-100 font-sans">
      <div className="max-w-6xl w-full">
        {/* Header */}
        <header className="flex flex-col md:flex-row justify-between items-center pb-8 border-b border-slate-800 gap-4">
          <div>
            <div className="flex items-center gap-3">
              <span className="text-3xl">⚡</span>
              <h1 className="text-3xl font-extrabold tracking-tight text-sky-400">Eluvix Desktop</h1>
            </div>
            <p className="text-slate-400 text-sm mt-1">
              Local token routing and OpenAI-compatible proxy engine with local nodes &amp; Billama fallback.
            </p>
          </div>

          <div className="flex flex-wrap items-center gap-3">
            <button
              onClick={handleCopySnippet}
              className="bg-slate-800 hover:bg-slate-700 text-xs px-3 py-2 rounded-lg border border-slate-700 transition font-mono text-sky-300"
            >
              {copiedSnippet ? '✓ Copied Env!' : '📋 Copy OpenAI Harness Env'}
            </button>
            <Link
              href="/docs"
              className="bg-slate-800 hover:bg-slate-700 text-sky-400 font-bold text-xs px-3.5 py-2 rounded-lg border border-sky-500/30 transition flex items-center gap-1.5"
            >
              <span>📖</span> Docs ➔
            </Link>
            <Link
              href="/observability"
              className="bg-purple-600 hover:bg-purple-500 text-white font-bold text-xs px-3.5 py-2 rounded-lg shadow-lg shadow-purple-600/20 transition flex items-center gap-1.5"
            >
              <span>📊</span> Observability ➔
            </Link>
            <Link
              href="/configurator"
              className="bg-sky-600 hover:bg-sky-500 text-white font-bold text-xs px-3.5 py-2 rounded-lg shadow-lg shadow-sky-600/20 transition flex items-center gap-1.5"
            >
              <span>⚙️</span> Client Configurator ➔
            </Link>
            <Link
              href="/editor"
              className="bg-indigo-600 hover:bg-indigo-500 text-white font-bold text-xs px-3.5 py-2 rounded-lg shadow-lg shadow-indigo-600/20 transition flex items-center gap-1.5"
            >
              <span>🔀</span> Node Routing Editor ➔
            </Link>
            <Link
              href="/playground"
              className="bg-emerald-600 hover:bg-emerald-500 text-white font-bold text-xs px-3.5 py-2 rounded-lg shadow-lg shadow-emerald-600/20 transition flex items-center gap-1.5"
            >
              <span>🧪</span> Trace Playground ➔
            </Link>
            <Link
              href="/provider"
              className="bg-amber-600 hover:bg-amber-500 text-white font-bold text-xs px-3.5 py-2 rounded-lg shadow-lg shadow-amber-600/20 transition flex items-center gap-1.5"
            >
              <span>⚡</span> Sell GPU Time ➔
            </Link>
            <button
              onClick={handleSaveConfig}
              className="bg-sky-500 hover:bg-sky-400 text-slate-950 font-bold text-xs px-4 py-2 rounded-lg shadow-lg shadow-sky-500/20 transition"
            >
              Save Configuration
            </button>
          </div>
        </header>
        {/* Analytics Panel */}
        {analytics && (
          <div className="mt-8 grid grid-cols-1 md:grid-cols-3 gap-4">
            <div className="bg-slate-900 border border-slate-800 rounded-xl p-4 flex flex-col items-center justify-center shadow-lg">
              <div className="text-slate-400 text-xs font-semibold uppercase tracking-wider mb-1">Total Requests</div>
              <div className="text-3xl font-extrabold text-white">{analytics.totalRequests}</div>
            </div>
            <div className="bg-slate-900 border border-slate-800 rounded-xl p-4 flex flex-col items-center justify-center shadow-lg">
              <div className="text-slate-400 text-xs font-semibold uppercase tracking-wider mb-1">Avg Latency</div>
              <div className="text-3xl font-extrabold text-white">{analytics.avgLatency} <span className="text-lg text-slate-500">ms</span></div>
            </div>
            <div className="bg-slate-900 border border-emerald-900/30 rounded-xl p-4 flex flex-col items-center justify-center shadow-lg bg-gradient-to-br from-slate-900 to-emerald-950/20">
              <div className="text-emerald-500/70 text-xs font-semibold uppercase tracking-wider mb-1">Est. Savings</div>
              <div className="text-3xl font-extrabold text-emerald-400">${analytics.estimatedSavings}</div>
            </div>
          </div>
        )}

        {saveStatus && (
          <div className="mt-4 p-3 rounded-lg text-sm font-medium bg-sky-950 border border-sky-600 text-sky-200 flex flex-col sm:flex-row justify-between items-start sm:items-center gap-2">
            <span>✓ {saveStatus}</span>
            <Link
              href="/editor"
              className="inline-flex items-center gap-1.5 text-xs font-bold text-indigo-300 hover:text-indigo-200 bg-indigo-900/60 px-3 py-1 rounded-md border border-indigo-700 transition"
            >
              Open Node Routing Editor ➔
            </Link>
          </div>
        )}

        {/* Node Routing Editor Feature Banner */}
        <div className="mt-6 border border-indigo-500/30 rounded-xl p-5 bg-gradient-to-r from-indigo-950/60 via-slate-900 to-slate-900 flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4 shadow-xl">
          <div>
            <div className="flex items-center gap-2">
              <span className="text-xl">🔀</span>
              <h3 className="font-bold text-slate-100 text-base">Billama Visual Node Routing Editor</h3>
              <span className="bg-indigo-500/20 text-indigo-300 border border-indigo-500/40 text-[10px] font-mono px-2 py-0.5 rounded-full">
                Interactive Canvas
              </span>
            </div>
            <p className="text-xs text-slate-400 mt-1 max-w-xl">
              Visually wire together Switchyard Balancers, Semantic Guards, Task Routers, and MCP Model Gateways into an executable graph.
            </p>
          </div>
          <Link
            href="/editor"
            className="bg-indigo-600 hover:bg-indigo-500 text-white font-bold text-xs px-4 py-2.5 rounded-lg shadow-lg shadow-indigo-500/20 transition whitespace-nowrap flex items-center gap-1.5"
          >
            Launch Routing Editor ➔
          </Link>
        </div>

        {/* Sell GPU Time Provider Banner */}
        <div className="mt-6 border border-amber-500/30 rounded-xl p-5 bg-gradient-to-r from-amber-950/40 via-slate-900 to-slate-900 flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4 shadow-xl">
          <div>
            <div className="flex items-center gap-2">
              <span className="text-xl">⚡</span>
              <h3 className="font-bold text-slate-100 text-base">Earn Billama Cloud Credits &amp; USD with Your GPU</h3>
              <span className="bg-amber-500/20 text-amber-300 border border-amber-500/40 text-[10px] font-mono px-2 py-0.5 rounded-full">
                GPU Provider Mode
              </span>
            </div>
            <p className="text-xs text-slate-400 mt-1 max-w-xl">
              Turn your local machine into a Billama compute provider. Earn revenue on idle GPU capacity while local consumer requests retain 100% immediate priority.
            </p>
          </div>
          <Link
            href="/provider"
            className="bg-amber-500 hover:bg-amber-400 text-slate-950 font-bold text-xs px-4 py-2.5 rounded-lg shadow-lg shadow-amber-500/20 transition whitespace-nowrap flex items-center gap-1.5"
          >
            Open Provider Dashboard ➔
          </Link>
        </div>

        {/* Docker Container Orchestration Hub */}
        <div className="mt-6 border border-cyan-500/30 rounded-xl p-5 bg-gradient-to-r from-cyan-950/40 via-slate-900 to-slate-900 shadow-xl">
          <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4 border-b border-slate-800 pb-4 mb-4">
            <div className="flex items-center gap-3">
              <span className="text-2xl">🐳</span>
              <div>
                <div className="flex items-center gap-2">
                  <h3 className="font-bold text-slate-100 text-base">Docker Infrastructure Engine</h3>
                  {dockerStatus?.installed ? (
                    <span className="bg-emerald-500/20 text-emerald-300 border border-emerald-500/40 text-[10px] font-mono px-2 py-0.5 rounded-full flex items-center gap-1">
                      <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse"></span>
                      Docker Installed ({dockerStatus.version ? dockerStatus.version.split(',')[0].replace('Docker version ', 'v') : 'Active'})
                    </span>
                  ) : (
                    <span className="bg-amber-500/20 text-amber-300 border border-amber-500/40 text-[10px] font-mono px-2 py-0.5 rounded-full">
                      Docker Not Detected
                    </span>
                  )}
                  {dockerStatus?.running && (
                    <span className="bg-sky-500/20 text-sky-300 border border-sky-500/40 text-[10px] font-mono px-2 py-0.5 rounded-full">
                      Daemon Connected
                    </span>
                  )}
                </div>
                <p className="text-xs text-slate-400 mt-1">
                  Automated containerized stack: Switchyard, vLLM-sr, Ollama, vLLM, Agent Router, Agent Gateway, OpenViking, and TrueForge.
                </p>
              </div>
            </div>

            <div className="flex items-center gap-2">
              <button
                onClick={fetchDockerStatus}
                disabled={dockerLoading}
                className="bg-slate-800 hover:bg-slate-700 text-slate-200 text-xs px-3 py-1.5 rounded-lg border border-slate-700 transition disabled:opacity-50"
              >
                🔄 Refresh
              </button>
              {dockerStatus?.running && (
                <>
                  <button
                    onClick={handleDockerUp}
                    disabled={dockerLoading}
                    className="bg-emerald-600 hover:bg-emerald-500 text-white font-bold text-xs px-3.5 py-1.5 rounded-lg shadow-lg shadow-emerald-600/20 transition flex items-center gap-1.5 disabled:opacity-50"
                  >
                    <span>{dockerLoading ? '⏳ Launching...' : '🚀 Spin Up Containers'}</span>
                  </button>
                  <button
                    onClick={handleDockerDown}
                    disabled={dockerLoading}
                    className="bg-red-900/60 hover:bg-red-800 text-red-200 text-xs px-3 py-1.5 rounded-lg border border-red-700/60 transition disabled:opacity-50"
                  >
                    🛑 Stop
                  </button>
                </>
              )}
            </div>
          </div>

          {dockerActionMessage && (
            <div className="mb-4 text-xs font-mono px-3 py-2 rounded bg-slate-950 border border-cyan-500/40 text-cyan-300">
              {dockerActionMessage}
            </div>
          )}

          {/* Grid of the 8 services */}
          {dockerStatus?.services && dockerStatus.services.length > 0 ? (
            <div className="grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-8 gap-2.5">
              {dockerStatus.services.map((srv) => (
                <div
                  key={srv.name}
                  className={`p-3 rounded-lg border flex flex-col justify-between ${
                    srv.running
                      ? 'bg-emerald-950/30 border-emerald-500/40 text-emerald-200'
                      : 'bg-slate-950/60 border-slate-800 text-slate-400'
                  }`}
                >
                  <div>
                    <div className="flex items-center justify-between">
                      <span className="text-xs font-bold font-mono text-slate-200">{srv.name}</span>
                      <span
                        className={`w-2 h-2 rounded-full ${
                          srv.running ? 'bg-emerald-400 shadow-sm shadow-emerald-400' : 'bg-slate-600'
                        }`}
                      ></span>
                    </div>
                    <span className="text-[10px] font-mono text-slate-400 mt-1 block">:{srv.port}</span>
                  </div>
                  <div className="mt-2 text-[10px]">
                    <span
                      className={`px-1.5 py-0.5 rounded font-mono ${
                        srv.running
                          ? 'bg-emerald-500/20 text-emerald-300'
                          : srv.status === 'exited'
                          ? 'bg-amber-500/20 text-amber-300'
                          : 'bg-slate-800 text-slate-400'
                      }`}
                    >
                      {srv.status}
                    </span>
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <div className="text-xs text-slate-400 italic">
              {dockerStatus?.message || 'Probing Docker environment...'}
            </div>
          )}
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-3 gap-8 mt-6">
          {/* Left Column: Billama Card */}
          <div className="lg:col-span-1 flex flex-col gap-6">
            <div className="border border-blue-500/50 rounded-xl p-6 bg-gradient-to-br from-blue-950/80 via-indigo-950/40 to-slate-900 shadow-xl relative overflow-hidden">
              <span className="absolute top-4 right-4 bg-blue-500 text-white text-[10px] font-bold px-2 py-0.5 rounded-full uppercase tracking-wider">
                Recommended
              </span>
              <h2 className="text-xl font-bold text-blue-200 mb-2">🌟 Billama Cloud</h2>
              <p className="text-xs text-blue-300/80 mb-6 leading-relaxed">
                Connect your desktop router to the Billama high-speed cloud mesh for enterprise caching, instant fallbacks, and intelligent cross-provider orchestration.
              </p>

              <div className="flex flex-col gap-3">
                <label className="text-xs font-semibold text-blue-200 uppercase tracking-wider">
                  Billama API Key
                </label>
                <input
                  type="password"
                  value={billamaKey}
                  onChange={(e) => setBillamaKey(e.target.value)}
                  placeholder="sk-bl-..."
                  className="w-full px-3 py-2 bg-slate-950/90 border border-blue-500/40 rounded-lg text-sm text-slate-100 placeholder-slate-500 focus:outline-none focus:border-blue-400 transition"
                />
                <button
                  onClick={handleSaveConfig}
                  className="mt-2 bg-blue-600 hover:bg-blue-500 text-white font-semibold text-xs py-2 px-4 rounded-lg transition"
                >
                  Update Billama Key
                </button>
                <span className="text-[11px] text-blue-400/60 mt-1">
                  Keys are stored exclusively on your local desktop.
                </span>
              </div>
            </div>

            {/* OpenViking & Context Memory Engine Card */}
            <div className="border border-fuchsia-500/40 rounded-xl p-6 bg-gradient-to-br from-fuchsia-950/50 via-slate-900 to-slate-900 shadow-xl">
              <div className="flex items-center justify-between mb-2">
                <h2 className="text-lg font-bold text-fuchsia-200 flex items-center gap-2">
                  <span>🧠</span> OpenViking &amp; Context Memory
                </h2>
                <label className="flex items-center gap-1.5 text-xs text-fuchsia-300 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={Boolean(config.memory?.enabled)}
                    onChange={(e) =>
                      setConfig({
                        ...config,
                        memory: {
                          enabled: e.target.checked,
                          provider: config.memory?.provider || 'openviking',
                          endpoint: config.memory?.endpoint || 'http://localhost:1933',
                          recallBudgetTokens: config.memory?.recallBudgetTokens ?? 600,
                          writeBack: config.memory?.writeBack !== false,
                          allowCloudEgress: Boolean(config.memory?.allowCloudEgress),
                          cloudMode: config.memory?.cloudMode || 'filter',
                          openviking: config.memory?.openviking || { readingLevel: 'L1' }
                        }
                      })
                    }
                    className="rounded border-fuchsia-500 bg-slate-950 text-fuchsia-500"
                  />
                  <span className="font-semibold">{config.memory?.enabled ? 'Active' : 'Disabled'}</span>
                </label>
              </div>
              <p className="text-xs text-slate-400 mb-4 leading-relaxed">
                Pre-routing context recall &amp; post-routing session commit across all models and harnesses.
              </p>

              <div className="flex flex-col gap-3">
                <div className="grid grid-cols-2 gap-2">
                  <div>
                    <label className="text-[10px] font-semibold text-fuchsia-300 uppercase tracking-wider block mb-1">
                      Provider
                    </label>
                    <select
                      value={config.memory?.provider || 'openviking'}
                      onChange={(e) => {
                        const nextProvider = e.target.value as 'builtin' | 'openviking' | 'mem0';
                        const defaultEndpoint =
                          nextProvider === 'openviking'
                            ? 'http://localhost:1933'
                            : nextProvider === 'mem0'
                            ? 'http://localhost:8888'
                            : '';
                        setConfig({
                          ...config,
                          memory: {
                            ...config.memory,
                            enabled: config.memory?.enabled ?? true,
                            provider: nextProvider,
                            endpoint: defaultEndpoint
                          }
                        });
                      }}
                      className="w-full px-2.5 py-1.5 bg-slate-950 border border-fuchsia-500/40 rounded-lg text-xs text-slate-100 focus:outline-none focus:border-fuchsia-400"
                    >
                      <option value="openviking">OpenViking (:1933)</option>
                      <option value="builtin">Built-in SQLite FTS5</option>
                      <option value="mem0">Mem0 (:8888)</option>
                    </select>
                  </div>
                  <div>
                    <label className="text-[10px] font-semibold text-fuchsia-300 uppercase tracking-wider block mb-1">
                      Reading Level
                    </label>
                    <select
                      value={config.memory?.openviking?.readingLevel || 'L1'}
                      onChange={(e) =>
                        setConfig({
                          ...config,
                          memory: {
                            ...config.memory,
                            provider: config.memory?.provider || 'openviking',
                            openviking: {
                              ...config.memory?.openviking,
                              readingLevel: e.target.value as 'L0' | 'L1' | 'L2'
                            }
                          }
                        })
                      }
                      className="w-full px-2.5 py-1.5 bg-slate-950 border border-fuchsia-500/40 rounded-lg text-xs text-slate-100 focus:outline-none focus:border-fuchsia-400"
                    >
                      <option value="L0">L0 (Abstract ~100t)</option>
                      <option value="L1">L1 (Overview ~500t)</option>
                      <option value="L2">L2 (Full Detail)</option>
                    </select>
                  </div>
                </div>

                {(config.memory?.provider || 'openviking') !== 'builtin' && (
                  <div>
                    <label className="text-[10px] font-semibold text-fuchsia-300 uppercase tracking-wider block mb-1">
                      Memory Server Endpoint
                    </label>
                    <input
                      type="text"
                      value={config.memory?.endpoint || 'http://localhost:1933'}
                      onChange={(e) =>
                        setConfig({
                          ...config,
                          memory: {
                            ...config.memory,
                            provider: config.memory?.provider || 'openviking',
                            endpoint: e.target.value
                          }
                        })
                      }
                      placeholder="http://localhost:1933"
                      className="w-full px-3 py-1.5 bg-slate-950 border border-fuchsia-500/40 rounded-lg text-xs font-mono text-fuchsia-200 focus:outline-none focus:border-fuchsia-400"
                    />
                  </div>
                )}

                <button
                  onClick={handleSaveConfig}
                  className="mt-1 bg-fuchsia-600 hover:bg-fuchsia-500 text-white font-semibold text-xs py-2 px-4 rounded-lg transition"
                >
                  Save Memory Settings
                </button>
              </div>
            </div>

            {/* Quickstart info */}
            <div className="border border-slate-800 rounded-xl p-6 bg-slate-900/60">
              <h3 className="text-sm font-semibold text-slate-200 mb-2">OpenCode &amp; Cursor Setup</h3>
              <p className="text-xs text-slate-400 mb-3">
                Point your favorite coding agent or CLI tool to your local router endpoint:
              </p>
              <pre className="bg-slate-950 p-3 rounded-lg border border-slate-800 text-[11px] font-mono text-sky-400 overflow-x-auto">
{`OPENAI_BASE_URL="${baseUrl}/api/v1"
OPENAI_API_KEY="sk-eluvix-local"`}
              </pre>
            </div>
          </div>

          {/* Right Column: Local & Custom Upstreams (Editable) */}
          <div className="lg:col-span-2 flex flex-col gap-6">
            <div className="border border-slate-800 rounded-xl p-6 bg-slate-900 shadow-xl">
              <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4 mb-6">
                <div>
                  <h2 className="text-xl font-bold text-slate-100">Local &amp; Custom Upstreams</h2>
                  <p className="text-xs text-slate-400 mt-1">
                    Configure local nodes (vLLM, vLLM-sr, Ollama, Lemonade, Switchyard, TrueForge) or upstream providers. Edit any endpoint URL below.
                  </p>
                </div>
                <div className="flex items-center gap-2">
                  <button
                    onClick={handleDetectAllModels}
                    disabled={isDetectingAll}
                    className="bg-indigo-600/30 hover:bg-indigo-600/50 border border-indigo-500/50 text-indigo-200 font-semibold text-xs px-3 py-2 rounded-lg transition flex items-center gap-1.5 disabled:opacity-50"
                  >
                    <span>{isDetectingAll ? '⏳ Probing Nodes...' : '🔍 Detect All Models'}</span>
                  </button>
                  <button
                    onClick={handleAddUpstream}
                    className="bg-slate-800 hover:bg-slate-700 text-sky-400 border border-slate-700 font-semibold text-xs px-3 py-2 rounded-lg transition flex items-center gap-1.5"
                  >
                    <span>+</span> Add Upstream
                  </button>
                </div>
              </div>

              {/* Upstream list */}
              <div className="flex flex-col gap-4">
                {config.upstreams.map((upstream, index) => (
                  <div
                    key={upstream.id || index}
                    className="p-4 rounded-xl bg-slate-950 border border-slate-800 flex flex-col gap-3 hover:border-slate-700 transition"
                  >
                    <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-800/80 pb-3">
                      <div className="flex items-center gap-3 flex-1 min-w-[200px]">
                        <input
                          type="text"
                          value={upstream.name}
                          onChange={(e) => handleUpdateName(index, e.target.value)}
                          className="bg-transparent font-semibold text-sm text-slate-200 border-b border-transparent hover:border-slate-600 focus:border-sky-400 focus:outline-none transition py-0.5 px-1"
                          title="Click to rename upstream"
                        />
                        <select
                          value={upstream.type}
                          onChange={(e) => handleUpdateType(index, e.target.value as UpstreamConfig['type'])}
                          className="bg-slate-900 text-xs text-sky-400 border border-slate-700 rounded px-2 py-1 focus:outline-none"
                        >
                          <option value="vllm">vLLM</option>
                          <option value="vllm-sr">vLLM-sr</option>
                          <option value="ollama">Ollama</option>
                          <option value="lemonade">Lemonade</option>
                          <option value="switchyard">Switchyard</option>
                          <option value="harness">TrueForge / Agent Harness</option>
                          <option value="openai-compatible">OpenAI-compatible</option>
                          <option value="anthropic">Anthropic</option>
                          <option value="billama">Billama</option>
                          <option value="antigravity">Antigravity (AGY)</option>
                        </select>
                      </div>

                      <div className="flex items-center gap-3">
                        <div className="flex items-center gap-1.5 text-xs text-slate-400">
                          <span>Priority:</span>
                          <input
                            type="number"
                            value={upstream.priority}
                            onChange={(e) => handleUpdatePriority(index, parseInt(e.target.value) || 0)}
                            className="w-14 bg-slate-900 border border-slate-700 rounded px-2 py-0.5 text-center text-xs text-slate-200 focus:outline-none focus:border-sky-400"
                          />
                        </div>
                        <button
                          onClick={() => handleRemoveUpstream(index)}
                          className="text-slate-500 hover:text-red-400 text-xs px-2 py-1 rounded transition"
                          title="Remove upstream"
                        >
                          ✕
                        </button>
                      </div>
                    </div>

                    {/* EDITABLE ENDPOINT URL FIELD */}
                    <div className="flex flex-col gap-1.5">
                      <label className="text-[11px] font-semibold text-slate-400 uppercase tracking-wider flex items-center justify-between">
                        <span>Endpoint URL (Click to edit)</span>
                        <span className="text-[10px] text-sky-400 font-normal lowercase font-mono">
                          target host for token routing
                        </span>
                      </label>
                      <div className="relative flex items-center">
                        <input
                          type="text"
                          value={upstream.endpoint}
                          onChange={(e) => handleUpdateEndpoint(index, e.target.value)}
                          placeholder="http://localhost:8000"
                          className="w-full bg-slate-900 border border-slate-700 focus:border-sky-400 text-sky-300 font-mono text-xs px-3 py-2 rounded-lg focus:outline-none shadow-inner transition"
                        />
                      </div>
                    </div>

                    {upstream.type === 'harness' && (
                      <div className="grid grid-cols-1 sm:grid-cols-3 gap-2 p-2.5 rounded-lg bg-amber-950/20 border border-amber-500/30">
                        <div>
                          <label className="text-[10px] font-semibold text-amber-300 uppercase tracking-wider block mb-1">
                            Harness Runtime
                          </label>
                          <select
                            value={upstream.harness?.kind || 'trueforge'}
                            onChange={(e) => {
                              const nextKind = e.target.value as 'trueforge' | 'opencode' | 'acp' | 'hermes';
                              const updated = [...config.upstreams];
                              updated[index] = {
                                ...upstream,
                                harness: {
                                  ...upstream.harness,
                                  kind: nextKind
                                }
                              };
                              setConfig({ ...config, upstreams: updated });
                            }}
                            className="w-full bg-slate-900 border border-amber-500/40 rounded px-2 py-1 text-xs text-amber-200 focus:outline-none"
                          >
                            <option value="trueforge">TrueForge (:8790)</option>
                            <option value="opencode">OpenCode (:4096)</option>
                            <option value="acp">ACP Agent (stdio)</option>
                            <option value="hermes">Hermes (:8642)</option>
                          </select>
                        </div>
                        <div>
                          <label className="text-[10px] font-semibold text-amber-300 uppercase tracking-wider block mb-1">
                            Agent Profile ID
                          </label>
                          <input
                            type="text"
                            value={upstream.harness?.agentId || 'default'}
                            onChange={(e) => {
                              const updated = [...config.upstreams];
                              updated[index] = {
                                ...upstream,
                                harness: {
                                  kind: upstream.harness?.kind || 'trueforge',
                                  ...upstream.harness,
                                  agentId: e.target.value
                                }
                              };
                              setConfig({ ...config, upstreams: updated });
                            }}
                            className="w-full bg-slate-900 border border-amber-500/40 rounded px-2 py-1 text-xs font-mono text-amber-200 focus:outline-none"
                          />
                        </div>
                        <div>
                          <label className="text-[10px] font-semibold text-amber-300 uppercase tracking-wider block mb-1">
                            Tool Approvals
                          </label>
                          <select
                            value={upstream.harness?.approvals || 'auto-approve-readonly'}
                            onChange={(e) => {
                              const updated = [...config.upstreams];
                              updated[index] = {
                                ...upstream,
                                harness: {
                                  kind: upstream.harness?.kind || 'trueforge',
                                  ...upstream.harness,
                                  approvals: e.target.value as 'auto-approve-readonly' | 'read-only' | 'surface' | 'auto-deny'
                                }
                              };
                              setConfig({ ...config, upstreams: updated });
                            }}
                            className="w-full bg-slate-900 border border-amber-500/40 rounded px-2 py-1 text-xs text-amber-200 focus:outline-none"
                          >
                            <option value="auto-approve-readonly">Auto-Approve Read-Only</option>
                            <option value="read-only">Read-Only Tools</option>
                            <option value="surface">Surface to Client</option>
                            <option value="auto-deny">Auto-Deny Mutating</option>
                          </select>
                        </div>
                      </div>
                    )}

                    {/* MODELS INPUT & DETECTION */}
                    <div className="flex flex-col gap-1.5">
                      <div className="flex items-center justify-between">
                        <label className="text-[11px] font-semibold text-slate-400 uppercase tracking-wider">
                          Assigned Models (comma-separated, or * for all)
                        </label>
                        <button
                          type="button"
                          onClick={() => handleDetectModels(index)}
                          disabled={detectingMap[upstream.id]}
                          className="text-[11px] px-2.5 py-0.5 rounded bg-sky-950 border border-sky-600/50 hover:border-sky-400 text-sky-300 font-medium transition flex items-center gap-1 disabled:opacity-50"
                        >
                          <span>{detectingMap[upstream.id] ? '⏳ Detecting...' : '🔍 Detect Models'}</span>
                        </button>
                      </div>
                      <input
                        type="text"
                        value={upstream.models.join(', ')}
                        onChange={(e) => handleUpdateModels(index, e.target.value)}
                        placeholder="meta-llama/Llama-3-8b, *"
                        className="w-full bg-slate-900 border border-slate-700 focus:border-sky-400 text-slate-200 font-mono text-xs px-3 py-1.5 rounded-lg focus:outline-none transition"
                      />

                      {/* Detection Feedback */}
                      {detectResults[upstream.id] && (
                        <div
                          className={`text-[11px] px-2.5 py-1 rounded flex items-center justify-between ${
                            detectResults[upstream.id].isError
                              ? 'bg-amber-950/40 border border-amber-800/60 text-amber-300'
                              : 'bg-emerald-950/40 border border-emerald-800/60 text-emerald-300'
                          }`}
                        >
                          <span className="truncate mr-2">{detectResults[upstream.id].message}</span>
                          {detectResults[upstream.id].count > 0 && (
                            <span className="font-mono text-[10px] bg-emerald-900/60 px-1.5 py-0.2 rounded text-emerald-200 shrink-0">
                              {detectResults[upstream.id].count} active
                            </span>
                          )}
                        </div>
                      )}
                    </div>
                  </div>
                ))}
              </div>

              <div className="mt-6 flex justify-end">
                <button
                  onClick={handleSaveConfig}
                  className="bg-sky-500 hover:bg-sky-400 text-slate-950 font-bold text-xs px-5 py-2.5 rounded-lg shadow-lg shadow-sky-500/20 transition"
                >
                  Save All Changes
                </button>
              </div>
            </div>
          </div>
        </div>
      </div>
    </main>
  );
}
