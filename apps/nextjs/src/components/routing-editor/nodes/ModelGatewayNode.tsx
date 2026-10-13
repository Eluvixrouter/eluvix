"use client";

import { useState } from 'react';
import { Handle, Position, useReactFlow } from '@xyflow/react';

export default function ModelGatewayNode({ id, data }: { id: string; data: any }) {
  const { updateNodeData } = useReactFlow();
  const [primaryModel, setPrimaryModel] = useState(data?.primaryModel || 'gpt-4o');
  const [fallbackStrategy, setFallbackStrategy] = useState(data?.fallbackStrategy || 'cheaper');
  const [cacheEnabled, setCacheEnabled] = useState(data?.cacheEnabled !== false);
  const cacheTtl = data?.cacheTtlSeconds ?? 3600;
  const [rateLimitRpm, setRateLimitRpm] = useState(data?.rateLimitRpm ?? 60);

  // Ensure default structure
  if (data) {
    if (!data.primaryModel) data.primaryModel = primaryModel;
    if (!data.fallbackStrategy) data.fallbackStrategy = fallbackStrategy;
    if (data.cacheEnabled === undefined) data.cacheEnabled = cacheEnabled;
    if (data.cacheTtlSeconds === undefined) data.cacheTtlSeconds = cacheTtl;
    if (data.cacheSimilarityThreshold === undefined) data.cacheSimilarityThreshold = 0.95;
    if (data.rateLimitRpm === undefined) data.rateLimitRpm = rateLimitRpm;
    if (data.rateLimitTpm === undefined) data.rateLimitTpm = 100000;
  }

  const syncData = (updates: Record<string, any>) => {
    if (data) Object.assign(data, updates);
    if (id) updateNodeData(id, updates);
  };

  const handleModelChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const val = e.target.value;
    setPrimaryModel(val);
    syncData({ primaryModel: val });
  };

  const handleStrategyChange = (e: React.ChangeEvent<HTMLSelectElement>) => {
    const val = e.target.value;
    setFallbackStrategy(val);
    syncData({ fallbackStrategy: val });
  };

  return (
    <div className="bg-gray-900 border-2 border-emerald-500 rounded-lg p-3.5 min-w-[280px] max-w-[320px] shadow-2xl transition hover:shadow-emerald-500/10">
      <Handle type="target" position={Position.Left} className="w-3.5 h-3.5 bg-emerald-500 -left-2" />
      
      {/* Header */}
      <div className="flex items-center justify-between pb-2 mb-2 border-b border-gray-800">
        <div className="flex items-center gap-1.5">
          <span className="text-lg">🚪</span>
          <div>
            <div className="font-bold text-emerald-400 text-sm">Model Gateway</div>
            <div className="text-[10px] text-gray-400 font-mono">Bifrost OpenAI Adapter &amp; Cache</div>
          </div>
        </div>
        <span className="text-[10px] bg-emerald-500/20 text-emerald-300 px-1.5 py-0.5 rounded font-mono">
          BIFROST
        </span>
      </div>
      
      <div className="text-xs text-gray-300 space-y-2.5">
        <div>
          <label className="block text-[10px] font-semibold text-gray-400 mb-1">Primary Upstream Model</label>
          <input 
            type="text" 
            className="nodrag w-full bg-gray-950 border border-gray-700 focus:border-emerald-500 rounded p-1.5 text-white font-mono text-[11px] outline-none transition"
            placeholder="e.g. gpt-4o, llama3"
            value={primaryModel}
            onChange={handleModelChange}
          />
        </div>
        
        <div className="grid grid-cols-2 gap-2">
          <div>
            <label className="block text-[10px] font-semibold text-gray-400 mb-1">Fallback Strategy</label>
            <select 
              className="nodrag w-full bg-gray-950 border border-gray-700 focus:border-emerald-500 rounded p-1.5 text-white text-[11px] outline-none transition cursor-pointer"
              value={fallbackStrategy}
              onChange={handleStrategyChange}
            >
              <option value="cheaper">📉 Cheaper Tier</option>
              <option value="same-tier">🔄 Same-Tier</option>
              <option value="fail-fast">🚫 Fail Fast</option>
            </select>
          </div>
          <div>
            <label className="block text-[10px] font-semibold text-gray-400 mb-1">RPM Rate Limit</label>
            <input
              type="number"
              min={1}
              max={10000}
              className="nodrag w-full bg-gray-950 border border-gray-700 focus:border-emerald-500 rounded p-1.5 text-white font-mono text-[11px] outline-none transition"
              value={rateLimitRpm}
              onChange={(e) => {
                const val = parseInt(e.target.value, 10) || 60;
                setRateLimitRpm(val);
                syncData({ rateLimitRpm: val });
              }}
            />
          </div>
        </div>

        {/* Semantic Cache Toggle */}
        <div className="flex items-center justify-between bg-gray-950/80 p-2 rounded border border-gray-800">
          <label className="flex items-center gap-2 cursor-pointer text-[11px]">
            <input 
              type="checkbox"
              className="nodrag accent-emerald-500 cursor-pointer"
              checked={cacheEnabled}
              onChange={(e) => {
                setCacheEnabled(e.target.checked);
                syncData({ cacheEnabled: e.target.checked });
              }}
            />
            <span>Semantic Response Cache</span>
          </label>
          <span className="text-[10px] font-mono text-emerald-400">{cacheEnabled ? `${cacheTtl}s TTL` : 'Disabled'}</span>
        </div>

        {/* Quick Badges Strip */}
        <div className="pt-2 border-t border-gray-800 grid grid-cols-2 gap-1.5 text-[9px] font-mono text-gray-400">
          <div className="flex items-center gap-1 bg-gray-950 px-2 py-1 rounded border border-gray-800">
            <span>💾</span>
            <span>Cache: {cacheEnabled ? 'Active' : 'Off'}</span>
          </div>
          <div className="flex items-center gap-1 bg-gray-950 px-2 py-1 rounded border border-gray-800">
            <span>⚡</span>
            <span>Limit: {rateLimitRpm} RPM</span>
          </div>
          <div className="flex items-center gap-1 bg-gray-950 px-2 py-1 rounded border border-gray-800">
            <span>🎯</span>
            <span>Sim: {data?.cacheSimilarityThreshold ?? 0.95}</span>
          </div>
          <div className="flex items-center gap-1 bg-gray-950 px-2 py-1 rounded border border-gray-800">
            <span>🔁</span>
            <span>Mode: {fallbackStrategy}</span>
          </div>
        </div>
      </div>

      <Handle type="source" position={Position.Right} id="mg-out" className="w-3.5 h-3.5 bg-emerald-500 -right-2" />
    </div>
  );
}
