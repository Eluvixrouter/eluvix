"use client";

import { useState } from 'react';
import { Handle, Position, useReactFlow } from '@xyflow/react';

export default function ObservabilityNode({ id, data }: { id: string; data: any }) {
  const { updateNodeData } = useReactFlow();
  const [projectName, setProjectName] = useState(data?.projectName || 'eluvix-desktop');
  const [exporter, setExporter] = useState(data?.exporter || 'sqlite');
  const [captureInputs, setCaptureInputs] = useState(data?.captureInputs !== false);
  const [samplingRate, setSamplingRate] = useState(data?.samplingRate ?? 100);
  const [scrubPii, setScrubPii] = useState(data?.scrubPii !== false);

  // Ensure default structure
  if (data) {
    if (!data.projectName) data.projectName = projectName;
    if (!data.exporter) data.exporter = exporter;
    if (data.captureInputs === undefined) data.captureInputs = captureInputs;
    if (data.samplingRate === undefined) data.samplingRate = samplingRate;
    if (data.scrubPii === undefined) data.scrubPii = scrubPii;
    if (data.latencyAlertMs === undefined) data.latencyAlertMs = 5000;
  }

  const syncData = (updates: Record<string, any>) => {
    if (data) Object.assign(data, updates);
    if (id) updateNodeData(id, updates);
  };

  const handleNameChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const val = e.target.value;
    setProjectName(val);
    syncData({ projectName: val });
  };

  const handleExporterChange = (e: React.ChangeEvent<HTMLSelectElement>) => {
    const val = e.target.value;
    setExporter(val);
    syncData({ exporter: val });
  };

  return (
    <div className="bg-gray-900 border-2 border-indigo-500 rounded-lg p-3.5 min-w-[280px] max-w-[320px] shadow-2xl transition hover:shadow-indigo-500/10">
      <Handle type="target" position={Position.Left} className="w-3.5 h-3.5 bg-indigo-500 -left-2" />
      
      {/* Header */}
      <div className="flex items-center justify-between pb-2 mb-2 border-b border-gray-800">
        <div className="flex items-center gap-1.5">
          <span className="text-lg">📊</span>
          <div>
            <div className="font-bold text-indigo-400 text-sm">Observability Sink</div>
            <div className="text-[10px] text-gray-400 font-mono">Telemetry &amp; Audit Logs</div>
          </div>
        </div>
        <span className="text-[10px] bg-indigo-500/20 text-indigo-300 px-1.5 py-0.5 rounded font-mono uppercase">
          {exporter}
        </span>
      </div>
      
      <div className="text-xs text-gray-300 space-y-2.5">
        <div>
          <label className="block text-[10px] font-semibold text-gray-400 mb-1">Project Identifier</label>
          <input 
            type="text" 
            className="nodrag w-full bg-gray-950 border border-gray-700 focus:border-indigo-500 rounded p-1.5 text-white font-mono text-[11px] outline-none transition"
            placeholder="eluvix-production"
            value={projectName}
            onChange={handleNameChange}
          />
        </div>

        <div>
          <label className="block text-[10px] font-semibold text-gray-400 mb-1">Telemetry Exporter</label>
          <select
            className="nodrag w-full bg-gray-950 border border-gray-700 focus:border-indigo-500 rounded p-1.5 text-white text-[11px] outline-none transition cursor-pointer"
            value={exporter}
            onChange={handleExporterChange}
          >
            <option value="sqlite">💾 Local SQLite Audit Logs</option>
            <option value="otlp">🌐 OpenTelemetry (OTLP / gRPC)</option>
            <option value="langfuse">🦩 Langfuse Cloud / Self-Hosted</option>
            <option value="prometheus">📈 Prometheus Metrics Exporter</option>
          </select>
        </div>

        <div>
          <div className="flex justify-between items-center mb-1">
            <label className="text-[10px] font-semibold text-gray-400">Trace Sampling Rate</label>
            <span className="text-[10px] font-mono text-indigo-400 font-bold">{samplingRate}%</span>
          </div>
          <input
            type="range"
            min="1"
            max="100"
            step="1"
            className="nodrag w-full accent-indigo-500 cursor-pointer"
            value={samplingRate}
            onChange={(e) => {
              const val = parseInt(e.target.value, 10) || 100;
              setSamplingRate(val);
              syncData({ samplingRate: val });
            }}
          />
        </div>

        {/* Toggles */}
        <div className="space-y-1.5 bg-gray-950/80 p-2 rounded border border-gray-800">
          <label className="flex items-center justify-between text-[11px] font-semibold text-gray-300 cursor-pointer">
            <span>Capture Prompts &amp; Completions</span>
            <input 
              type="checkbox" 
              className="nodrag accent-indigo-500 cursor-pointer"
              checked={captureInputs}
              onChange={(e) => {
                setCaptureInputs(e.target.checked);
                syncData({ captureInputs: e.target.checked });
              }}
            />
          </label>
          <label className="flex items-center justify-between text-[11px] font-semibold text-gray-300 cursor-pointer">
            <span>Auto-Scrub PII from Traces</span>
            <input 
              type="checkbox" 
              className="nodrag accent-indigo-500 cursor-pointer"
              checked={scrubPii}
              onChange={(e) => {
                setScrubPii(e.target.checked);
                syncData({ scrubPii: e.target.checked });
              }}
            />
          </label>
        </div>

        {/* Quick Badges Strip */}
        <div className="pt-2 border-t border-gray-800 grid grid-cols-2 gap-1.5 text-[9px] font-mono text-gray-400">
          <div className="flex items-center gap-1 bg-gray-950 px-2 py-1 rounded border border-gray-800">
            <span>📡</span>
            <span>Sink: {exporter}</span>
          </div>
          <div className="flex items-center gap-1 bg-gray-950 px-2 py-1 rounded border border-gray-800">
            <span>🎲</span>
            <span>Sample: {samplingRate}%</span>
          </div>
          <div className="flex items-center gap-1 bg-gray-950 px-2 py-1 rounded border border-gray-800">
            <span>🛡️</span>
            <span>Scrub: {scrubPii ? 'Active' : 'Off'}</span>
          </div>
          <div className="flex items-center gap-1 bg-gray-950 px-2 py-1 rounded border border-gray-800">
            <span>📥</span>
            <span>Payloads: {captureInputs ? 'Logged' : 'Omitted'}</span>
          </div>
        </div>
      </div>

      <Handle type="source" position={Position.Right} id="obs-out" className="w-3.5 h-3.5 bg-indigo-500 -right-2 transition hover:scale-125" />
    </div>
  );
}
