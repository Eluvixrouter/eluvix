'use client';

import { useState } from 'react';
import { TOPOLOGY_PRESETS, TopologyPreset, TopologyNode } from './mockup-data';

export function MockupEditor() {
  const [selectedPresetId, setSelectedPresetId] = useState<string>('local-first');
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>('sec');
  const [dryRunRunning, setDryRunRunning] = useState<boolean>(false);
  const [dryRunResult, setDryRunResult] = useState<string | null>(null);

  const activePreset = TOPOLOGY_PRESETS.find((p) => p.id === selectedPresetId) || TOPOLOGY_PRESETS[0];
  const activeNode = activePreset.nodes.find((n) => n.id === selectedNodeId) || activePreset.nodes[1];

  function handleDryRun() {
    setDryRunRunning(true);
    setDryRunResult(null);
    setTimeout(() => {
      setDryRunRunning(false);
      setDryRunResult(`Dry-run passed in ${activePreset.latencyAvg} • In-Flight PII Redacted • 0 Token Leakage • Routing: ${activePreset.badge}`);
    }, 800);
  }

  return (
    <div className="space-y-6">
      {/* Preset Selector Bar */}
      <div className="rounded-2xl border border-slate-800 bg-slate-900/60 p-4">
        <div className="flex flex-col md:flex-row md:items-center justify-between pb-3 border-b border-slate-800/80 gap-3">
          <div>
            <h2 className="text-sm font-bold text-white flex items-center gap-2">
              <span>⚡ 12 Topology Presets &amp; Layout Manager</span>
              <span className="text-[10px] font-mono px-2 py-0.5 rounded bg-sky-500/20 text-sky-400 font-bold border border-sky-500/30">
                Switchyard Compiled
              </span>
            </h2>
            <p className="text-xs text-slate-400 mt-0.5">
              Select any architecture to inspect its compiled node layout and execution topology.
            </p>
          </div>

          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={handleDryRun}
              disabled={dryRunRunning}
              className="px-3.5 py-1.5 rounded-lg bg-sky-500 hover:bg-sky-400 text-slate-950 font-bold text-xs shadow-[0_0_15px_rgba(56,189,248,0.3)] transition"
            >
              {dryRunRunning ? 'Compiling Graph...' : '▶ Test Graph Dry-Run'}
            </button>
          </div>
        </div>

        {/* 12 Preset Pills Grid */}
        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-2 pt-3">
          {TOPOLOGY_PRESETS.map((preset) => {
            const isSelected = preset.id === selectedPresetId;
            return (
              <button
                key={preset.id}
                type="button"
                onClick={() => {
                  setSelectedPresetId(preset.id);
                  setSelectedNodeId(preset.nodes[0]?.id || null);
                  setDryRunResult(null);
                }}
                className={`p-2.5 rounded-xl text-left border transition-all ${
                  isSelected
                    ? 'border-sky-500 bg-sky-500/15 shadow-[0_0_15px_rgba(56,189,248,0.15)]'
                    : 'border-slate-800/80 bg-slate-950/40 hover:border-slate-700 hover:bg-slate-900/60'
                }`}
              >
                <div className="flex items-center justify-between gap-1">
                  <span className={`text-xs font-bold truncate ${
                    isSelected ? 'text-sky-300' : 'text-slate-200'
                  }`}>
                    {preset.name.replace(/^[0-9]+\.\s*/, '')}
                  </span>
                </div>
                <div className="flex items-center gap-1.5 mt-1">
                  <span className="text-[10px] font-mono font-semibold px-1.5 py-0.2 rounded bg-slate-800 text-slate-400">
                    {preset.badge}
                  </span>
                  <span className="text-[10px] font-mono text-emerald-400">
                    {preset.savingsRate}
                  </span>
                </div>
              </button>
            );
          })}
        </div>
      </div>

      {/* Dry Run Feedback Banner */}
      {dryRunResult && (
        <div className="p-3 rounded-xl border border-emerald-500/40 bg-emerald-950/30 text-emerald-300 text-xs font-mono flex items-center justify-between animate-in fade-in">
          <span>✓ {dryRunResult}</span>
          <button
            type="button"
            onClick={() => setDryRunResult(null)}
            className="text-slate-400 hover:text-white"
          >
            ✕
          </button>
        </div>
      )}

      {/* Main Interactive Flow Canvas & Inspector */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* Left 2 Cols: Visual Node Flow Canvas */}
        <div className="lg:col-span-2 rounded-2xl border border-slate-800 bg-slate-950/80 p-5 relative overflow-hidden flex flex-col min-h-[460px]">
          {/* Canvas Background Grid Pattern */}
          <div
            className="absolute inset-0 opacity-15 pointer-events-none"
            style={{
              backgroundImage: 'radial-gradient(circle, #38bdf8 1px, transparent 1px)',
              backgroundSize: '24px 24px',
            }}
          />

          {/* Canvas Top Bar */}
          <div className="relative z-10 flex items-center justify-between pb-3 border-b border-slate-800 text-xs">
            <div className="flex items-center gap-2">
              <span className="w-2 h-2 rounded-full bg-emerald-400 animate-pulse" />
              <span className="font-bold text-white">{activePreset.name}</span>
            </div>

            <div className="flex items-center gap-4 text-xs font-mono text-slate-400">
              <span>Avg Latency: <strong className="text-emerald-400">{activePreset.latencyAvg}</strong></span>
              <span>Sovereignty: <strong className="text-sky-400">{activePreset.sovereigntyScore}</strong></span>
            </div>
          </div>

          {/* Interactive Flow Nodes Visualizer */}
          <div className="relative z-10 flex-1 flex flex-col justify-center py-6">
            <p className="text-[11px] text-slate-400 mb-6 text-center">
              Click any node below to inspect its execution parameters and routing policies.
            </p>

            <div className="flex flex-wrap items-center justify-center gap-4 sm:gap-6">
              {activePreset.nodes.map((node, idx) => {
                const isSelected = selectedNodeId === node.id;
                const isGateway = node.type === 'gateway';
                const isSecurity = node.type === 'security';
                const isLocal = node.type === 'local';
                const isCloud = node.type === 'cloud';

                return (
                  <div key={node.id} className="flex items-center gap-3">
                    {/* Node Card */}
                    <button
                      type="button"
                      onClick={() => setSelectedNodeId(node.id)}
                      className={`relative rounded-xl p-3.5 text-left border transition-all w-48 shadow-lg ${
                        isSelected
                          ? 'border-sky-400 bg-sky-950/70 ring-2 ring-sky-500/50 scale-105'
                          : isSecurity
                          ? 'border-emerald-500/40 bg-emerald-950/30 hover:border-emerald-400'
                          : isLocal
                          ? 'border-cyan-500/40 bg-cyan-950/30 hover:border-cyan-400'
                          : isCloud
                          ? 'border-purple-500/40 bg-purple-950/30 hover:border-purple-400'
                          : 'border-slate-800 bg-slate-900/80 hover:border-slate-700'
                      }`}
                    >
                      <div className="flex items-center justify-between mb-1.5">
                        <span className="text-[10px] font-mono uppercase tracking-wider font-bold text-slate-400">
                          {node.type}
                        </span>
                        <span className={`w-2 h-2 rounded-full ${
                          node.status === 'active' ? 'bg-emerald-400 animate-ping' : 'bg-slate-500'
                        }`} />
                      </div>

                      <div className="font-bold text-xs text-white truncate">
                        {node.name}
                      </div>

                      <div className="text-[11px] font-mono text-sky-400 mt-1 truncate">
                        {node.label}
                      </div>

                      <div className="text-[10px] text-slate-400 mt-1 line-clamp-1">
                        {node.details}
                      </div>
                    </button>

                    {/* Flow arrow connector between sequential nodes */}
                    {idx < activePreset.nodes.length - 1 && (
                      <div className="hidden sm:flex items-center text-slate-600 font-mono text-sm">
                        ➔
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </div>

          {/* Canvas Bottom Details */}
          <div className="relative z-10 pt-3 border-t border-slate-800/80 text-xs text-slate-400 flex flex-col sm:flex-row items-center justify-between gap-2">
            <span>{activePreset.description}</span>
            <span className="font-mono text-emerald-400 shrink-0">Est. Spend Saved: {activePreset.savingsRate}</span>
          </div>
        </div>

        {/* Right Col: Node Inspector Panel */}
        <div className="rounded-2xl border border-slate-800 bg-slate-900/70 p-5 space-y-4">
          <div className="pb-3 border-b border-slate-800">
            <h3 className="text-xs font-mono uppercase tracking-wider text-slate-400 font-bold">
              Node Inspector
            </h3>
            <div className="text-base font-bold text-white mt-1 flex items-center gap-2">
              <span>{activeNode?.name}</span>
              <span className="text-[10px] font-mono px-2 py-0.5 rounded bg-sky-500/20 text-sky-400 uppercase">
                {activeNode?.type}
              </span>
            </div>
          </div>

          <div className="space-y-3 text-xs">
            <div>
              <label className="text-[11px] font-mono text-slate-400 uppercase">Primary Function</label>
              <div className="mt-1 p-2 rounded-lg bg-slate-950 border border-slate-800 text-slate-200 font-mono">
                {activeNode?.label}
              </div>
            </div>

            <div>
              <label className="text-[11px] font-mono text-slate-400 uppercase">Execution Logic</label>
              <div className="mt-1 p-2 rounded-lg bg-slate-950 border border-slate-800 text-slate-300">
                {activeNode?.details}
              </div>
            </div>

            <div>
              <label className="text-[11px] font-mono text-slate-400 uppercase">Node Status</label>
              <div className="mt-1 flex items-center gap-2 text-emerald-400 font-mono">
                <span className="w-2 h-2 rounded-full bg-emerald-400" />
                <span>{activeNode?.status.toUpperCase()} • Zero Bottleneck</span>
              </div>
            </div>

            <div className="pt-2 border-t border-slate-800/80 space-y-2">
              <label className="text-[11px] font-mono text-slate-400 uppercase">Configurable Parameters</label>
              
              <div className="flex items-center justify-between p-2 rounded bg-slate-950/60 border border-slate-850">
                <span className="text-slate-300">PII In-Flight Redaction</span>
                <span className="text-emerald-400 font-mono font-bold">STRICT</span>
              </div>

              <div className="flex items-center justify-between p-2 rounded bg-slate-950/60 border border-slate-850">
                <span className="text-slate-300">Timeout Threshold</span>
                <span className="text-slate-300 font-mono">3,500ms</span>
              </div>

              <div className="flex items-center justify-between p-2 rounded bg-slate-950/60 border border-slate-850">
                <span className="text-slate-300">Max VRAM Allocation</span>
                <span className="text-sky-400 font-mono">22.4 GB</span>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
