"use client";

import { useState } from 'react';
import NodeHealthIndicator from '../NodeHealthIndicator';
import { Handle, Position, useReactFlow } from '@xyflow/react';

export interface TaskIntentRoute {
  id: string;
  name: string;
  color: string;
  icon: string;
}

const DEFAULT_INTENT_ROUTES: TaskIntentRoute[] = [
  { id: 'intent-code', name: 'Code & Engineering', color: '#3b82f6', icon: '💻' },
  { id: 'intent-reasoning', name: 'Deep Reasoning & Math', color: '#a855f7', icon: '🧠' },
  { id: 'intent-fast', name: 'Fast Chit-Chat & Summary', color: '#10b981', icon: '💬' },
  { id: 'intent-tools', name: 'Tool & Function Execution', color: '#eab308', icon: '🧰' },
  { id: 'intent-default', name: 'Default / Fallback', color: '#64748b', icon: '🔁' }
];

export default function TaskRouterNode({ id, data }: { id: string; data: any }) {
  const { updateNodeData } = useReactFlow();
  const [preference, setPreference] = useState(data?.preference || 'balanced');
  const [engine, setEngine] = useState(data?.classificationEngine || 'heuristic');
  const [confidenceThreshold, setConfidenceThreshold] = useState(data?.confidenceThreshold ?? 0.75);
  const routes: TaskIntentRoute[] = data?.routes || DEFAULT_INTENT_ROUTES;

  // Ensure default structure
  if (data) {
    if (!data.preference) data.preference = preference;
    if (!data.classificationEngine) data.classificationEngine = engine;
    if (data.confidenceThreshold === undefined) data.confidenceThreshold = confidenceThreshold;
    if (!data.routes) data.routes = routes;
  }

  const syncData = (updates: Record<string, any>) => {
    if (data) Object.assign(data, updates);
    if (id) updateNodeData(id, updates);
  };

  const handlePreferenceChange = (e: React.ChangeEvent<HTMLSelectElement>) => {
    const val = e.target.value;
    setPreference(val);
    syncData({ preference: val });
  };

  const handleEngineChange = (e: React.ChangeEvent<HTMLSelectElement>) => {
    const val = e.target.value;
    setEngine(val);
    syncData({ classificationEngine: val });
  };

  const handleConfidenceChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const val = parseFloat(e.target.value) || 0.75;
    setConfidenceThreshold(val);
    syncData({ confidenceThreshold: val });
  };

  return (
    <div className="bg-gray-900 border-2 border-yellow-500 rounded-lg p-3.5 min-w-[280px] max-w-[320px] shadow-2xl transition hover:shadow-yellow-500/10">
      <Handle type="target" position={Position.Left} className="w-3.5 h-3.5 bg-yellow-500 -left-2" />
      
      {/* Header */}
      <div className="flex items-center justify-between pb-2 mb-2 border-b border-gray-800">
        <div className="flex items-center gap-1.5">
          <NodeHealthIndicator serviceName="agent-router" />
          <span className="text-lg">🔀</span>
          <div>
            <div className="font-bold text-yellow-400 text-sm">Task Router</div>
            <div className="text-[10px] text-gray-400 font-mono">Semantic Intent Dispatcher</div>
          </div>
        </div>
        <span className="text-[10px] bg-yellow-500/20 text-yellow-300 px-1.5 py-0.5 rounded font-mono">
          {routes.length} INTENTS
        </span>
      </div>

      <div className="text-xs text-gray-300 space-y-2.5">
        <div className="grid grid-cols-2 gap-2">
          <div>
            <label className="block text-[10px] font-semibold text-gray-400 mb-1">Classifier Engine</label>
            <select 
              className="nodrag w-full bg-gray-950 border border-gray-700 focus:border-yellow-500 rounded p-1.5 text-white text-[11px] outline-none transition cursor-pointer"
              value={engine}
              onChange={handleEngineChange}
            >
              <option value="heuristic">⚡ Heuristic Regex ($0)</option>
              <option value="fastembed">🧠 FastEmbed Semantic</option>
              <option value="micro-llm">🤖 Micro-LLM (1B)</option>
            </select>
          </div>
          <div>
            <label className="block text-[10px] font-semibold text-gray-400 mb-1">Routing Mode</label>
            <select 
              className="nodrag w-full bg-gray-950 border border-gray-700 focus:border-yellow-500 rounded p-1.5 text-white text-[11px] outline-none transition cursor-pointer"
              value={preference}
              onChange={handlePreferenceChange}
            >
              <option value="balanced">⚖️ Balanced</option>
              <option value="cost">🪙 Lowest Cost</option>
              <option value="latency">⚡ Max Speed</option>
              <option value="capability">🎯 Capability Match</option>
            </select>
          </div>
        </div>

        <div>
          <div className="flex justify-between items-center mb-1">
            <label className="text-[10px] font-semibold text-gray-400">Confidence Threshold</label>
            <span className="text-[10px] font-mono text-yellow-400 font-bold">{confidenceThreshold}</span>
          </div>
          <input
            type="range"
            min="0.5"
            max="0.95"
            step="0.05"
            className="nodrag w-full accent-yellow-500 cursor-pointer"
            value={confidenceThreshold}
            onChange={handleConfidenceChange}
          />
        </div>

        {/* Intent Output Routes */}
        <div>
          <label className="block text-[10px] font-semibold text-gray-400 mb-1.5">Intent Targets</label>
          <div className="space-y-1.5">
            {routes.map((route) => (
              <div
                key={route.id}
                className="relative flex items-center justify-between p-1.5 rounded bg-gray-950 border border-gray-800 hover:border-gray-700 transition"
              >
                <div className="flex items-center gap-1.5">
                  <span>{route.icon}</span>
                  <span className="text-[11px] font-medium text-gray-200">{route.name}</span>
                </div>
                <Handle
                  type="source"
                  position={Position.Right}
                  id={route.id}
                  className="w-3.5 h-3.5 -right-2 transition hover:scale-125"
                  style={{ backgroundColor: route.color }}
                />
              </div>
            ))}
          </div>
        </div>

        {/* Quick Badges Strip */}
        <div className="pt-2 border-t border-gray-800 grid grid-cols-2 gap-1.5 text-[9px] font-mono text-gray-400">
          <div className="flex items-center gap-1 bg-gray-950 px-2 py-1 rounded border border-gray-800">
            <span>⚙️</span>
            <span>Engine: {engine}</span>
          </div>
          <div className="flex items-center gap-1 bg-gray-950 px-2 py-1 rounded border border-gray-800">
            <span>🎯</span>
            <span>Conf: {confidenceThreshold}</span>
          </div>
          <div className="flex items-center gap-1 bg-gray-950 px-2 py-1 rounded border border-gray-800">
            <span>🧭</span>
            <span>Pref: {preference}</span>
          </div>
          <div className="flex items-center gap-1 bg-gray-950 px-2 py-1 rounded border border-gray-800">
            <span>🔀</span>
            <span>Routes: {routes.length}</span>
          </div>
        </div>
      </div>
    </div>
  );
}
