'use client';

import { useState, useEffect, useMemo, useCallback } from 'react';
import Link from 'next/link';

interface RequestLog {
  id: number;
  timestamp: string;
  model: string;
  upstream_id: string;
  status: number;
  duration_ms: number;
  prompt_tokens?: number;
  completion_tokens?: number;
}

interface UpstreamHealth {
  id: string;
  name: string;
  type: string;
  endpoint: string;
  status: 'online' | 'offline' | 'degraded';
  latencyMs: number;
  modelsCount: number;
  models: string[];
}

interface ObservabilityData {
  summary: {
    totalRequests: number;
    successCount: number;
    errorCount: number;
    successRate: number;
    avgLatencyMs: number;
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
    estimatedSavings: string;
    activeUpstreamsCount: number;
    totalUpstreamsCount: number;
  };
  modelDistribution: Record<string, number>;
  upstreamDistribution: Record<string, number>;
  upstreams: UpstreamHealth[];
  logs: RequestLog[];
}

export default function ObservabilityPage() {
  const [data, setData] = useState<ObservabilityData | null>(null);
  const [loading, setLoading] = useState(true);
  const [isLive, setIsLive] = useState(true);
  const [statusFilter, setStatusFilter] = useState<'all' | 'success' | 'error'>('all');
  const [searchQuery, setSearchQuery] = useState('');
  const [selectedLog, setSelectedLog] = useState<RequestLog | null>(null);
  const [testPingLoading, setTestPingLoading] = useState(false);
  const [actionNotice, setActionNotice] = useState<{ message: string; error?: boolean } | null>(null);

  const fetchObservability = useCallback(async (showSpinner = false) => {
    if (showSpinner) setLoading(true);
    try {
      const res = await fetch(`/api/v1/observability?status=${statusFilter}`);
      const json = await res.json();
      if (json.success && json.data) {
        setData(json.data);
      }
    } catch (err: any) {
      console.error('Failed to fetch observability data:', err);
    } finally {
      if (showSpinner) setLoading(false);
    }
  }, [statusFilter]);

  // Initial fetch
  useEffect(() => {
    fetchObservability(true);
  }, [fetchObservability]);

  // Live polling interval (every 3 seconds when isLive is active)
  useEffect(() => {
    if (!isLive) return;
    const interval = setInterval(() => {
      fetchObservability(false);
    }, 3000);
    return () => clearInterval(interval);
  }, [isLive, fetchObservability]);

  const handleSendTestPing = async () => {
    setTestPingLoading(true);
    setActionNotice({ message: 'Routing test ping through Eluvix pipeline...' });
    try {
      const res = await fetch('/api/v1/observability', { method: 'POST' });
      const json = await res.json();
      if (json.success) {
        setActionNotice({
          message: `✓ Test ping succeeded via ${json.upstreamId} in ${json.durationMs}ms (Status: ${json.status})`,
        });
        await fetchObservability(false);
      } else {
        setActionNotice({ message: `Test ping failed: ${json.error}`, error: true });
      }
    } catch (err: any) {
      setActionNotice({ message: `Error: ${err.message}`, error: true });
    } finally {
      setTestPingLoading(false);
      setTimeout(() => setActionNotice(null), 4500);
    }
  };

  const handlePurgeLogs = async () => {
    if (!window.confirm('Are you sure you want to clear all historical request logs?')) return;
    try {
      const res = await fetch('/api/v1/observability', { method: 'DELETE' });
      const json = await res.json();
      if (json.success) {
        setActionNotice({ message: '✓ All activity logs have been purged.' });
        await fetchObservability(false);
      }
    } catch (err: any) {
      setActionNotice({ message: `Purge failed: ${err.message}`, error: true });
    } finally {
      setTimeout(() => setActionNotice(null), 4000);
    }
  };

  const handleExportJson = () => {
    if (!data) return;
    const jsonString = JSON.stringify(data.logs, null, 2);
    const blob = new Blob([jsonString], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `eluvix-activity-logs-${new Date().toISOString().slice(0, 19)}.json`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  // Filter logs by search query
  const filteredLogs = useMemo(() => {
    if (!data) return [];
    if (!searchQuery.trim()) return data.logs;
    const q = searchQuery.toLowerCase();
    return data.logs.filter(
      (l) =>
        l.model.toLowerCase().includes(q) ||
        l.upstream_id.toLowerCase().includes(q) ||
        l.status.toString().includes(q) ||
        (l.id && l.id.toString().includes(q))
    );
  }, [data, searchQuery]);

  const formatTokens = (num: number) => {
    if (num >= 1000000) return `${(num / 1000000).toFixed(1)}M`;
    if (num >= 1000) return `${(num / 1000).toFixed(1)}k`;
    return num.toLocaleString();
  };

  const formatTime = (ts: string) => {
    if (!ts) return 'Just now';
    try {
      const date = new Date(ts.replace(' ', 'T') + 'Z');
      return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
    } catch {
      return ts;
    }
  };

  if (loading && !data) {
    return (
      <main className="flex min-h-screen flex-col items-center justify-center bg-slate-950 text-slate-100 font-sans p-6">
        <div className="flex items-center gap-3 text-sky-400">
          <span className="animate-spin text-2xl">⏳</span>
          <span className="text-lg font-medium">Loading Eluvix Observability...</span>
        </div>
      </main>
    );
  }

  const summary = data?.summary || {
    totalRequests: 0,
    successCount: 0,
    errorCount: 0,
    successRate: 100,
    avgLatencyMs: 0,
    promptTokens: 0,
    completionTokens: 0,
    totalTokens: 0,
    estimatedSavings: '0.000',
    activeUpstreamsCount: 0,
    totalUpstreamsCount: 0,
  };

  return (
    <main className="flex min-h-screen flex-col items-center p-6 md:p-12 bg-slate-950 text-slate-100 font-sans">
      <div className="max-w-6xl w-full">
        {/* Top Header & Navigation */}
        <header className="flex flex-col md:flex-row justify-between items-start md:items-center pb-6 border-b border-slate-800 gap-4">
          <div>
            <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wider text-slate-400 mb-1">
              <Link href="/" className="hover:text-sky-400 transition">
                Eluvix
              </Link>
              <span>/</span>
              <span className="text-sky-400">Observability</span>
            </div>
            <div className="flex items-center gap-3">
              <span className="text-3xl">📊</span>
              <h1 className="text-2xl md:text-3xl font-extrabold tracking-tight text-white">
                Live Activity &amp; Observability
              </h1>
            </div>
            <p className="text-slate-400 text-sm mt-1">
              Real-time monitoring of routed token traffic, model latencies, engine health, and request audit logs.
            </p>
          </div>

          {/* Action Buttons & Navigation */}
          <div className="flex flex-wrap items-center gap-2.5">
            {/* Live Toggle */}
            <button
              onClick={() => setIsLive(!isLive)}
              className={`text-xs px-3 py-1.5 rounded-lg border font-semibold flex items-center gap-2 transition ${
                isLive
                  ? 'bg-emerald-950/80 border-emerald-500/60 text-emerald-400'
                  : 'bg-slate-900 border-slate-700 text-slate-400 hover:text-slate-200'
              }`}
            >
              <span className={`w-2 h-2 rounded-full ${isLive ? 'bg-emerald-400 animate-pulse' : 'bg-slate-500'}`} />
              <span>{isLive ? 'LIVE (3s)' : 'PAUSED'}</span>
            </button>

            <button
              onClick={() => fetchObservability(false)}
              className="bg-slate-800 hover:bg-slate-700 text-slate-200 text-xs px-3 py-1.5 rounded-lg border border-slate-700 transition"
              title="Manual Refresh"
            >
              🔄 Refresh
            </button>

            <button
              onClick={handleSendTestPing}
              disabled={testPingLoading}
              className="bg-sky-600 hover:bg-sky-500 disabled:opacity-50 text-white font-bold text-xs px-3 py-1.5 rounded-lg shadow transition flex items-center gap-1.5"
            >
              <span className={testPingLoading ? 'animate-spin' : ''}>⚡</span>
              <span>{testPingLoading ? 'Pinging...' : 'Send Test Ping'}</span>
            </button>

            <div className="h-4 w-px bg-slate-800 hidden md:block" />

            <Link
              href="/configurator"
              className="bg-slate-800 hover:bg-slate-700 text-slate-200 text-xs px-3 py-1.5 rounded-lg border border-slate-700 transition flex items-center gap-1"
            >
              <span>⚙️</span> Configurator
            </Link>
            <Link
              href="/editor"
              className="bg-indigo-600 hover:bg-indigo-500 text-white font-semibold text-xs px-3 py-1.5 rounded-lg shadow transition flex items-center gap-1"
            >
              <span>🔀</span> Editor
            </Link>
            <Link
              href="/playground"
              className="bg-emerald-600 hover:bg-emerald-500 text-white font-semibold text-xs px-3 py-1.5 rounded-lg shadow transition flex items-center gap-1"
            >
              <span>🧪</span> Playground
            </Link>
          </div>
        </header>

        {actionNotice && (
          <div
            className={`mt-4 p-3 rounded-lg text-xs font-mono flex items-center gap-2 ${
              actionNotice.error
                ? 'bg-rose-950/80 border border-rose-800 text-rose-300'
                : 'bg-indigo-950/80 border border-indigo-700/60 text-indigo-300'
            }`}
          >
            <span>ℹ️</span> {actionNotice.message}
          </div>
        )}

        {/* 1. Operational KPI Metrics Cards */}
        <section className="mt-8 grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
          {/* Requests & Success */}
          <div className="bg-slate-900 border border-slate-800 rounded-xl p-5 shadow-xl flex flex-col justify-between">
            <div className="flex justify-between items-start">
              <span className="text-xs font-semibold text-slate-400 uppercase tracking-wider">Total Requests</span>
              <span className="text-lg">📈</span>
            </div>
            <div className="mt-2">
              <div className="text-3xl font-extrabold text-white">{summary.totalRequests}</div>
              <div className="flex items-center gap-2 mt-1">
                <span className="text-xs text-emerald-400 font-semibold">{summary.successRate}% Success</span>
                <span className="text-slate-600 text-xs">•</span>
                <span className="text-xs text-slate-400">{summary.errorCount} Errors</span>
              </div>
            </div>
          </div>

          {/* Average Latency */}
          <div className="bg-slate-900 border border-slate-800 rounded-xl p-5 shadow-xl flex flex-col justify-between">
            <div className="flex justify-between items-start">
              <span className="text-xs font-semibold text-slate-400 uppercase tracking-wider">Avg Response Time</span>
              <span className="text-lg">⏱️</span>
            </div>
            <div className="mt-2">
              <div className="text-3xl font-extrabold text-white">
                {summary.avgLatencyMs} <span className="text-base text-slate-400 font-normal">ms</span>
              </div>
              <div className="mt-1">
                <span
                  className={`text-[10px] font-bold px-2 py-0.5 rounded ${
                    summary.avgLatencyMs < 500
                      ? 'bg-emerald-950 text-emerald-400 border border-emerald-800'
                      : summary.avgLatencyMs < 2000
                      ? 'bg-amber-950 text-amber-400 border border-amber-800'
                      : 'bg-purple-950 text-purple-400 border border-purple-800'
                  }`}
                >
                  {summary.avgLatencyMs < 500 ? '⚡ Ultra-Fast' : summary.avgLatencyMs < 2000 ? 'Moderate' : 'Deep Thinking / Frontier'}
                </span>
              </div>
            </div>
          </div>

          {/* Token Throughput */}
          <div className="bg-slate-900 border border-slate-800 rounded-xl p-5 shadow-xl flex flex-col justify-between">
            <div className="flex justify-between items-start">
              <span className="text-xs font-semibold text-slate-400 uppercase tracking-wider">Token Throughput</span>
              <span className="text-lg">🔤</span>
            </div>
            <div className="mt-2">
              <div className="text-3xl font-extrabold text-sky-400">{formatTokens(summary.totalTokens)}</div>
              <div className="text-xs text-slate-400 mt-1 flex items-center gap-2">
                <span>Prompt: {formatTokens(summary.promptTokens)}</span>
                <span className="text-slate-600">•</span>
                <span>Output: {formatTokens(summary.completionTokens)}</span>
              </div>
            </div>
          </div>

          {/* Estimated Local Savings */}
          <div className="bg-slate-900 border border-slate-800 rounded-xl p-5 shadow-xl flex flex-col justify-between">
            <div className="flex justify-between items-start">
              <span className="text-xs font-semibold text-slate-400 uppercase tracking-wider">Local Cost Savings</span>
              <span className="text-lg">💰</span>
            </div>
            <div className="mt-2">
              <div className="text-3xl font-extrabold text-emerald-400">${summary.estimatedSavings}</div>
              <div className="text-xs text-slate-400 mt-1">
                Saved vs commercial cloud APIs ($0.005/req)
              </div>
            </div>
          </div>
        </section>

        {/* 2. Upstream Node Health Matrix */}
        <section className="mt-8 bg-slate-900 border border-slate-800 rounded-xl p-6 shadow-xl">
          <div className="flex justify-between items-center pb-4 border-b border-slate-800">
            <div>
              <span className="text-xs font-bold text-sky-400 uppercase tracking-wider">Node Status</span>
              <h2 className="text-lg font-bold text-white mt-0.5">
                Upstream Engine Health ({summary.activeUpstreamsCount} of {summary.totalUpstreamsCount} Active)
              </h2>
            </div>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-3.5 mt-4">
            {data?.upstreams.map((node) => (
              <div
                key={node.id}
                className={`p-3.5 rounded-lg border flex flex-col justify-between transition ${
                  node.status === 'online'
                    ? 'bg-slate-950/80 border-slate-800 hover:border-emerald-500/50'
                    : 'bg-slate-950/40 border-slate-850 opacity-60'
                }`}
              >
                <div>
                  <div className="flex items-center justify-between">
                    <span className="font-bold text-xs text-white truncate" title={node.name}>
                      {node.name}
                    </span>
                    <span
                      className={`text-[10px] font-bold px-1.5 py-0.5 rounded flex items-center gap-1 ${
                        node.status === 'online'
                          ? 'bg-emerald-950 text-emerald-400 border border-emerald-800'
                          : 'bg-slate-800 text-slate-400 border border-slate-700'
                      }`}
                    >
                      <span className={`w-1.5 h-1.5 rounded-full ${node.status === 'online' ? 'bg-emerald-400' : 'bg-slate-500'}`} />
                      {node.status.toUpperCase()}
                    </span>
                  </div>

                  <div className="font-mono text-[11px] text-slate-400 mt-1 truncate" title={node.endpoint}>
                    {node.endpoint}
                  </div>
                </div>

                <div className="mt-3 pt-2.5 border-t border-slate-850 flex items-center justify-between text-[11px]">
                  <span className="text-slate-400 font-medium">
                    {node.status === 'online' ? `${node.latencyMs} ms` : 'Unreachable'}
                  </span>
                  <span className="text-sky-400 font-mono text-[10px]">
                    {node.modelsCount} model(s)
                  </span>
                </div>
              </div>
            ))}
          </div>
        </section>

        {/* 3. Traffic Distribution (Models & Upstreams) */}
        <section className="mt-8 grid grid-cols-1 lg:grid-cols-2 gap-6">
          {/* By Model */}
          <div className="bg-slate-900 border border-slate-800 rounded-xl p-5 shadow-xl">
            <span className="text-xs font-bold text-sky-400 uppercase tracking-wider">Traffic Breakdown</span>
            <h3 className="text-sm font-bold text-white mt-0.5 mb-4">Requests by Model</h3>

            {Object.keys(data?.modelDistribution || {}).length === 0 ? (
              <div className="text-xs text-slate-500 py-6 text-center">No model activity recorded yet.</div>
            ) : (
              <div className="space-y-3">
                {Object.entries(data?.modelDistribution || {}).map(([modelName, count]) => {
                  const pct = summary.totalRequests > 0 ? Math.round((count / summary.totalRequests) * 100) : 0;
                  return (
                    <div key={modelName}>
                      <div className="flex justify-between text-xs mb-1">
                        <span className="font-mono text-slate-300 font-medium truncate max-w-[240px]">{modelName}</span>
                        <span className="text-slate-400">{count} reqs ({pct}%)</span>
                      </div>
                      <div className="h-1.5 bg-slate-800 rounded-full overflow-hidden">
                        <div className="h-full bg-sky-500 rounded-full transition-all duration-500" style={{ width: `${pct}%` }} />
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>

          {/* By Upstream */}
          <div className="bg-slate-900 border border-slate-800 rounded-xl p-5 shadow-xl">
            <span className="text-xs font-bold text-sky-400 uppercase tracking-wider">Engine Routing</span>
            <h3 className="text-sm font-bold text-white mt-0.5 mb-4">Requests by Upstream Engine</h3>

            {Object.keys(data?.upstreamDistribution || {}).length === 0 ? (
              <div className="text-xs text-slate-500 py-6 text-center">No upstream activity recorded yet.</div>
            ) : (
              <div className="space-y-3">
                {Object.entries(data?.upstreamDistribution || {}).map(([upstreamName, count]) => {
                  const pct = summary.totalRequests > 0 ? Math.round((count / summary.totalRequests) * 100) : 0;
                  return (
                    <div key={upstreamName}>
                      <div className="flex justify-between text-xs mb-1">
                        <span className="font-mono text-slate-300 font-medium truncate max-w-[240px]">{upstreamName}</span>
                        <span className="text-slate-400">{count} reqs ({pct}%)</span>
                      </div>
                      <div className="h-1.5 bg-slate-800 rounded-full overflow-hidden">
                        <div className="h-full bg-emerald-500 rounded-full transition-all duration-500" style={{ width: `${pct}%` }} />
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </section>

        {/* 4. Live Request Activity Feed */}
        <section className="mt-8 bg-slate-900 border border-slate-800 rounded-xl p-6 shadow-xl mb-12">
          <div className="flex flex-col md:flex-row justify-between items-start md:items-center gap-4 pb-4 border-b border-slate-800">
            <div>
              <span className="text-xs font-bold text-sky-400 uppercase tracking-wider">Audit Stream</span>
              <h2 className="text-lg font-bold text-white mt-0.5">
                Real-Time Request Activity ({filteredLogs.length} entries)
              </h2>
            </div>

            {/* Filter and Action Controls */}
            <div className="flex flex-wrap items-center gap-2">
              {/* Status Filter */}
              <div className="flex items-center bg-slate-950 p-1 rounded-lg border border-slate-800 text-xs">
                {(['all', 'success', 'error'] as const).map((mode) => (
                  <button
                    key={mode}
                    onClick={() => setStatusFilter(mode)}
                    className={`px-2.5 py-1 rounded font-medium transition capitalize ${
                      statusFilter === mode
                        ? 'bg-sky-500 text-slate-950 font-bold'
                        : 'text-slate-400 hover:text-slate-200'
                    }`}
                  >
                    {mode}
                  </button>
                ))}
              </div>

              <button
                onClick={handleExportJson}
                disabled={filteredLogs.length === 0}
                className="bg-slate-800 hover:bg-slate-700 disabled:opacity-40 text-slate-300 text-xs px-2.5 py-1.5 rounded-lg border border-slate-700 transition flex items-center gap-1"
                title="Export Activity Logs as JSON"
              >
                <span>💾</span> Export JSON
              </button>

              <button
                onClick={handlePurgeLogs}
                disabled={summary.totalRequests === 0}
                className="bg-rose-950 hover:bg-rose-900 border border-rose-800/80 disabled:opacity-40 text-rose-300 text-xs px-2.5 py-1.5 rounded-lg transition"
                title="Clear request history from database"
              >
                🗑️ Clear Logs
              </button>
            </div>
          </div>

          {/* Search bar */}
          <div className="mt-4 mb-4">
            <input
              type="text"
              placeholder="Search logs by model, upstream ID, status..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="w-full bg-slate-950 border border-slate-800 rounded-lg px-3 py-2 text-xs text-slate-200 placeholder-slate-500 focus:outline-none focus:border-sky-500 font-sans"
            />
          </div>

          {/* Log Table */}
          <div className="overflow-x-auto border border-slate-800 rounded-lg bg-slate-950">
            <table className="w-full text-left text-xs">
              <thead className="bg-slate-900 text-slate-400 font-semibold border-b border-slate-800">
                <tr>
                  <th className="p-3 w-16">Status</th>
                  <th className="p-3">Time</th>
                  <th className="p-3">Model</th>
                  <th className="p-3">Upstream Engine</th>
                  <th className="p-3 w-28 text-right">Latency</th>
                  <th className="p-3 w-32 text-right">Tokens</th>
                  <th className="p-3 w-16 text-center">Inspect</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-850">
                {filteredLogs.length === 0 ? (
                  <tr>
                    <td colSpan={7} className="p-8 text-center text-slate-500 text-xs">
                      No request activity found matching current filters. Send a prompt via OpenCode, curl, or click &ldquo;Send Test Ping&rdquo; above!
                    </td>
                  </tr>
                ) : (
                  filteredLogs.map((log) => {
                    const isSuccess = log.status >= 200 && log.status < 400;
                    return (
                      <tr key={log.id} className="hover:bg-slate-900/60 transition">
                        <td className="p-3">
                          <span
                            className={`font-mono text-[11px] font-bold px-1.5 py-0.5 rounded ${
                              isSuccess
                                ? 'bg-emerald-950 text-emerald-400 border border-emerald-800'
                                : 'bg-rose-950 text-rose-400 border border-rose-800'
                            }`}
                          >
                            {log.status}
                          </span>
                        </td>
                        <td className="p-3 font-mono text-slate-400 whitespace-nowrap">
                          {formatTime(log.timestamp)}
                        </td>
                        <td className="p-3 font-mono text-slate-200 font-medium">
                          <div className="flex items-center gap-1.5">
                            <span>{log.model}</span>
                            {log.model === 'auto' && (
                              <span className="bg-sky-950 text-sky-400 border border-sky-800 text-[10px] px-1 py-0.2 rounded font-bold">
                                auto
                              </span>
                            )}
                          </div>
                        </td>
                        <td className="p-3 text-slate-300 font-mono text-[11px]">
                          {log.upstream_id}
                        </td>
                        <td className="p-3 font-mono text-right">
                          <span
                            className={
                              log.duration_ms < 500
                                ? 'text-emerald-400'
                                : log.duration_ms < 2000
                                ? 'text-amber-400'
                                : 'text-purple-400'
                            }
                          >
                            {log.duration_ms} ms
                          </span>
                        </td>
                        <td className="p-3 font-mono text-right text-slate-400">
                          {log.prompt_tokens || 0} / {log.completion_tokens || 0}
                        </td>
                        <td className="p-3 text-center">
                          <button
                            onClick={() => setSelectedLog(log)}
                            className="text-xs text-sky-400 hover:text-sky-300 transition"
                            title="Inspect log details"
                          >
                            🔍
                          </button>
                        </td>
                      </tr>
                    );
                  })
                )}
              </tbody>
            </table>
          </div>
        </section>

        {/* Modal for Log Inspection */}
        {selectedLog && (
          <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm p-4">
            <div className="bg-slate-900 border border-slate-800 rounded-xl max-w-lg w-full p-6 shadow-2xl relative">
              <div className="flex justify-between items-center pb-3 border-b border-slate-800">
                <h3 className="font-bold text-white text-sm flex items-center gap-2">
                  <span>Log Inspector #{selectedLog.id}</span>
                  <span
                    className={`text-xs px-2 py-0.5 rounded font-mono ${
                      selectedLog.status === 200
                        ? 'bg-emerald-950 text-emerald-400 border border-emerald-800'
                        : 'bg-rose-950 text-rose-400 border border-rose-800'
                    }`}
                  >
                    HTTP {selectedLog.status}
                  </span>
                </h3>
                <button
                  onClick={() => setSelectedLog(null)}
                  className="text-slate-400 hover:text-white text-lg font-bold"
                >
                  ✕
                </button>
              </div>

              <div className="mt-4 space-y-2 text-xs">
                <div className="flex justify-between py-1 border-b border-slate-800">
                  <span className="text-slate-400">Timestamp:</span>
                  <span className="font-mono text-slate-200">{selectedLog.timestamp}</span>
                </div>
                <div className="flex justify-between py-1 border-b border-slate-800">
                  <span className="text-slate-400">Requested Model:</span>
                  <span className="font-mono text-sky-300 font-bold">{selectedLog.model}</span>
                </div>
                <div className="flex justify-between py-1 border-b border-slate-800">
                  <span className="text-slate-400">Routed Upstream:</span>
                  <span className="font-mono text-slate-200">{selectedLog.upstream_id}</span>
                </div>
                <div className="flex justify-between py-1 border-b border-slate-800">
                  <span className="text-slate-400">Latency Duration:</span>
                  <span className="font-mono text-slate-200">{selectedLog.duration_ms} ms</span>
                </div>
                <div className="flex justify-between py-1 border-b border-slate-800">
                  <span className="text-slate-400">Prompt Tokens:</span>
                  <span className="font-mono text-slate-200">{selectedLog.prompt_tokens || 0}</span>
                </div>
                <div className="flex justify-between py-1 border-b border-slate-800">
                  <span className="text-slate-400">Completion Tokens:</span>
                  <span className="font-mono text-slate-200">{selectedLog.completion_tokens || 0}</span>
                </div>
              </div>

              <div className="mt-6 flex justify-end">
                <button
                  onClick={() => setSelectedLog(null)}
                  className="bg-slate-800 hover:bg-slate-700 text-slate-200 text-xs px-4 py-2 rounded-lg transition"
                >
                  Close
                </button>
              </div>
            </div>
          </div>
        )}
      </div>
    </main>
  );
}
