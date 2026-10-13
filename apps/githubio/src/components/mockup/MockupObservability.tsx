'use client';

import { useState, useMemo } from 'react';
import { MOCK_TRACES, MockTrace } from './mockup-data';

export function MockupObservability() {
  const [traces] = useState<MockTrace[]>(MOCK_TRACES);
  const [filterStatus, setFilterStatus] = useState<string>('all');
  const [searchQuery, setSearchQuery] = useState<string>('');
  const [selectedTrace, setSelectedTrace] = useState<MockTrace | null>(null);

  const filteredTraces = useMemo(() => {
    return traces.filter((t) => {
      const matchesStatus =
        filterStatus === 'all' ||
        (filterStatus === '200' && t.status === '200 OK') ||
        (filterStatus === 'sanitized' && t.status === 'Sanitized') ||
        (filterStatus === 'fallback' && t.status === 'Fallback');

      const q = searchQuery.toLowerCase().trim();
      const matchesSearch =
        !q ||
        t.model.toLowerCase().includes(q) ||
        t.upstream.toLowerCase().includes(q) ||
        t.client.toLowerCase().includes(q);

      return matchesStatus && matchesSearch;
    });
  }, [traces, filterStatus, searchQuery]);

  return (
    <div className="space-y-6">
      {/* KPI Summary Cards */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <div className="p-4 rounded-xl border border-slate-800 bg-slate-900/70">
          <div className="text-[11px] font-mono text-slate-400 uppercase tracking-wider">Total Requests (24h)</div>
          <div className="text-2xl font-black text-white mt-1">14,289</div>
          <div className="text-[11px] text-emerald-400 mt-1">▲ 18.2% from yesterday</div>
        </div>

        <div className="p-4 rounded-xl border border-slate-800 bg-slate-900/70">
          <div className="text-[11px] font-mono text-slate-400 uppercase tracking-wider">Avg Gateway Latency</div>
          <div className="text-2xl font-black text-white mt-1">14.2ms</div>
          <div className="text-[11px] text-emerald-400 mt-1">Sub-20ms local processing</div>
        </div>

        <div className="p-4 rounded-xl border border-slate-800 bg-slate-900/70">
          <div className="text-[11px] font-mono text-slate-400 uppercase tracking-wider">Success Rate</div>
          <div className="text-2xl font-black text-white mt-1">99.8%</div>
          <div className="text-[11px] text-sky-400 mt-1">Automated zero-downtime failover</div>
        </div>

        <div className="p-4 rounded-xl border border-emerald-500/30 bg-emerald-950/20">
          <div className="text-[11px] font-mono text-emerald-400 uppercase tracking-wider">Spend Saved This Month</div>
          <div className="text-2xl font-black text-emerald-400 mt-1">$842.18</div>
          <div className="text-[11px] text-emerald-400 font-semibold mt-1">88.4% off cloud API baseline</div>
        </div>
      </div>

      {/* Upstream Health Status Bar */}
      <div className="rounded-2xl border border-slate-800 bg-slate-900/50 p-4">
        <div className="text-xs font-mono uppercase tracking-wider text-slate-400 font-bold mb-3">
          Hardware &amp; Engine Health Matrix
        </div>
        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3">
          {[
            { name: 'vLLM GPU', latency: '14ms', status: 'Optimal', color: 'emerald' },
            { name: 'Ollama Core', latency: '18ms', status: 'Optimal', color: 'emerald' },
            { name: 'Lemonade', latency: '12ms', status: 'Optimal', color: 'emerald' },
            { name: 'Switchyard', latency: '24ms', status: 'Optimal', color: 'emerald' },
            { name: 'Billama Mesh', latency: '48ms', status: 'Optimal', color: 'emerald' },
            { name: 'OpenAI Cloud', latency: '310ms', status: 'Standby', color: 'sky' },
          ].map((engine) => (
            <div
              key={engine.name}
              className="p-2.5 rounded-xl border border-slate-800 bg-slate-950/60 text-xs font-mono"
            >
              <div className="flex items-center justify-between">
                <span className="font-bold text-white text-[11px]">{engine.name}</span>
                <span className="w-2 h-2 rounded-full bg-emerald-400" />
              </div>
              <div className="text-slate-400 text-[10px] mt-1">{engine.latency} ping</div>
              <div className="text-emerald-400 text-[10px] font-semibold">{engine.status}</div>
            </div>
          ))}
        </div>
      </div>

      {/* Real-time Traces Table */}
      <div className="rounded-2xl border border-slate-800 bg-slate-900/60 p-5 space-y-4">
        <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-3">
          <div>
            <h3 className="text-sm font-bold text-white flex items-center gap-2">
              <span>📋 In-Flight Execution Traces</span>
              <span className="text-[10px] font-mono px-2 py-0.5 rounded bg-emerald-500/10 text-emerald-400">
                SQLite Telemetry Active
              </span>
            </h3>
            <p className="text-xs text-slate-400 mt-0.5">
              Live cryptographic log of routed prompts, token metrics, and cost savings.
            </p>
          </div>

          <div className="flex items-center gap-2 w-full sm:w-auto">
            <input
              type="text"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="Search traces (model, client)..."
              className="w-full sm:w-56 rounded-lg border border-slate-800 bg-slate-950 px-2.5 py-1 text-xs text-white placeholder-slate-500 focus:outline-none focus:border-sky-500"
            />

            <select
              value={filterStatus}
              onChange={(e) => setFilterStatus(e.target.value)}
              className="rounded-lg border border-slate-800 bg-slate-950 px-2 py-1 text-xs text-slate-300 focus:outline-none focus:border-sky-500"
            >
              <option value="all">All Status</option>
              <option value="200">200 OK</option>
              <option value="sanitized">Sanitized</option>
              <option value="fallback">Fallback</option>
            </select>
          </div>
        </div>

        {/* Traces Table */}
        <div className="overflow-x-auto">
          <table className="w-full text-left text-xs">
            <thead>
              <tr className="border-b border-slate-800 font-mono text-[11px] text-slate-400">
                <th className="py-2.5 px-3">Time</th>
                <th className="py-2.5 px-3">Model</th>
                <th className="py-2.5 px-3">Upstream</th>
                <th className="py-2.5 px-3">Client</th>
                <th className="py-2.5 px-3">Tokens</th>
                <th className="py-2.5 px-3">Latency</th>
                <th className="py-2.5 px-3">Cost</th>
                <th className="py-2.5 px-3">Savings</th>
                <th className="py-2.5 px-3">Status</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-850 font-mono">
              {filteredTraces.map((trace) => (
                <tr
                  key={trace.id}
                  onClick={() => setSelectedTrace(trace)}
                  className="hover:bg-slate-800/40 cursor-pointer transition text-slate-300"
                >
                  <td className="py-2.5 px-3 text-slate-400">{trace.time}</td>
                  <td className="py-2.5 px-3 font-semibold text-white">{trace.model}</td>
                  <td className="py-2.5 px-3 text-sky-400">{trace.upstream}</td>
                  <td className="py-2.5 px-3 text-slate-400">{trace.client}</td>
                  <td className="py-2.5 px-3">{trace.tokens}</td>
                  <td className="py-2.5 px-3 text-emerald-400">{trace.durationMs}ms</td>
                  <td className="py-2.5 px-3">{trace.cost}</td>
                  <td className="py-2.5 px-3 text-emerald-400 font-semibold">{trace.savings}</td>
                  <td className="py-2.5 px-3">
                    <span
                      className={`px-1.5 py-0.5 rounded text-[10px] font-semibold ${
                        trace.status === '200 OK'
                          ? 'bg-emerald-500/10 text-emerald-400'
                          : trace.status === 'Sanitized'
                          ? 'bg-sky-500/10 text-sky-400'
                          : 'bg-amber-500/10 text-amber-400'
                      }`}
                    >
                      {trace.status}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {/* Selected Trace Details Drawer / Modal */}
      {selectedTrace && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4 animate-in fade-in">
          <div className="w-full max-w-lg rounded-2xl border border-slate-800 bg-slate-900 p-6 space-y-4 shadow-2xl">
            <div className="flex items-center justify-between pb-3 border-b border-slate-800">
              <div>
                <h4 className="text-sm font-bold text-white font-mono">Trace Inspector: {selectedTrace.id}</h4>
                <p className="text-xs text-slate-400">Captured at {selectedTrace.time} via {selectedTrace.client}</p>
              </div>
              <button
                type="button"
                onClick={() => setSelectedTrace(null)}
                className="text-slate-400 hover:text-white"
              >
                ✕
              </button>
            </div>

            <div className="space-y-3 text-xs font-mono">
              <div className="flex items-center justify-between p-2 rounded bg-slate-950 border border-slate-800">
                <span className="text-slate-400">Model Executed:</span>
                <span className="text-white font-bold">{selectedTrace.model}</span>
              </div>
              <div className="flex items-center justify-between p-2 rounded bg-slate-950 border border-slate-800">
                <span className="text-slate-400">Upstream Route:</span>
                <span className="text-sky-400 font-bold">{selectedTrace.upstream}</span>
              </div>
              <div className="flex items-center justify-between p-2 rounded bg-slate-950 border border-slate-800">
                <span className="text-slate-400">Execution Latency:</span>
                <span className="text-emerald-400 font-bold">{selectedTrace.durationMs}ms</span>
              </div>
              <div className="flex items-center justify-between p-2 rounded bg-slate-950 border border-slate-800">
                <span className="text-slate-400">Tokens Processed:</span>
                <span className="text-white">{selectedTrace.tokens} tokens</span>
              </div>
              <div className="flex items-center justify-between p-2 rounded bg-slate-950 border border-slate-800">
                <span className="text-slate-400">Eluvix Local Cost:</span>
                <span className="text-emerald-400 font-bold">{selectedTrace.cost}</span>
              </div>
              <div className="flex items-center justify-between p-2 rounded bg-slate-950 border border-slate-800">
                <span className="text-slate-400">Commercial Cloud Baseline:</span>
                <span className="text-slate-400">{selectedTrace.savings} saved</span>
              </div>
              <div className="p-3 rounded-xl bg-slate-950 border border-slate-800 text-[11px] text-slate-300">
                <div className="font-bold text-white mb-1">Cryptographic Audit Stamp:</div>
                <div className="text-[10px] text-slate-500 break-all">
                  SHA256: 8f3c7a10b981f26a190a12e5e7eb05966904785710b981d97706
                </div>
              </div>
            </div>

            <button
              type="button"
              onClick={() => setSelectedTrace(null)}
              className="w-full py-2 rounded-xl bg-slate-800 hover:bg-slate-700 text-xs font-semibold text-white transition"
            >
              Close Inspector
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
