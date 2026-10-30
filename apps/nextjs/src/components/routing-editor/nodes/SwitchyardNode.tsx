"use client";

import { useState, useCallback } from 'react';
import NodeHealthIndicator from '../NodeHealthIndicator';
import { Handle, Position, useReactFlow } from '@xyflow/react';

export interface SwitchyardRoute {
  id: string;
  name: string;
  costLabel: string;
  color: string;
}

const DEFAULT_ROUTES: SwitchyardRoute[] = [
  { id: 'tier-1', name: 'Tier 1: Local Fast (Lemonade $0)', costLabel: '$0.00', color: '#10b981' },
  { id: 'tier-2', name: 'Tier 2: Local Reasoning (Ollama $0)', costLabel: '$0.00', color: '#eab308' },
  { id: 'tier-3', name: 'Tier 3: Google Antigravity AGY ($0)', costLabel: '$0.00', color: '#06b6d4' },
  { id: 'tier-4', name: 'Tier 4: Claude Code (Frontier Agent)', costLabel: 'Frontier', color: '#f59e0b' }
];

export default function SwitchyardNode({ id, data }: { id: string; data: any }) {
  const { updateNodeData } = useReactFlow();
  const [strategy, setStrategy] = useState(data?.strategy || 'cost-complexity');
  const [routes, setRoutes] = useState<SwitchyardRoute[]>(data?.routes || DEFAULT_ROUTES);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [kvPrefixAffinity, setKvPrefixAffinity] = useState<boolean>(data?.kvPrefixAffinity ?? true);
  const [prefillIsolationThreshold, setPrefillIsolationThreshold] = useState<number>(
    data?.prefillIsolationThresholdTokens ?? 4096
  );
  const [enablePrefillIsolation, setEnablePrefillIsolation] = useState<boolean>(
    data?.prefillIsolationThresholdTokens !== undefined
  );
  const [confidentialPolicy, setConfidentialPolicy] = useState<string>(
    data?.confidentialPolicy || 'disabled'
  );
  const [quantizationPolicy, setQuantizationPolicy] = useState<string>(
    data?.quantizationPolicy || 'disabled'
  );
  const [fabricPolicy, setFabricPolicy] = useState<string>(
    data?.fabricPolicy || 'disabled'
  );

  // Synchronize with node data
  const syncData = useCallback((updates: Record<string, any>) => {
    if (data) {
      Object.assign(data, updates);
    }
    if (id) {
      updateNodeData(id, updates);
    }
  }, [id, data, updateNodeData]);

  // Ensure data object holds defaults
  if (data) {
    if (!data.strategy) data.strategy = strategy;
    if (!data.routes) data.routes = routes;
    if (data.timeoutMs === undefined) data.timeoutMs = 60000;
    if (data.retryCount === undefined) data.retryCount = 1;
    if (data.spilloverThresholdMs === undefined) data.spilloverThresholdMs = 30000;
    if (data.codeEscalation === undefined) data.codeEscalation = true;
    if (data.kvPrefixAffinity === undefined) data.kvPrefixAffinity = kvPrefixAffinity;
    if (!data.complexityThresholds) {
      data.complexityThresholds = { moderate: 300, heavy: 1500, frontier: 6000 };
    }
    if (data.maxCostPerRequest === undefined) data.maxCostPerRequest = 0.05;
  }

  const handleStrategyChange = (e: React.ChangeEvent<HTMLSelectElement>) => {
    const val = e.target.value;
    setStrategy(val);
    syncData({ strategy: val });
  };

  const handleAddRoute = () => {
    let maxIdx = 0;
    for (const r of routes) {
      const match = r.id.match(/^tier-(\d+)$/);
      if (match) {
        maxIdx = Math.max(maxIdx, parseInt(match[1], 10));
      }
    }
    const newIdx = maxIdx + 1;
    const newRoute: SwitchyardRoute = {
      id: `tier-${newIdx}`,
      name: `Tier ${newIdx}: Custom Route`,
      costLabel: 'Custom',
      color: '#38bdf8'
    };
    const updated = [...routes, newRoute];
    setRoutes(updated);
    syncData({ routes: updated });
  };

  const handleRemoveRoute = (id: string) => {
    if (routes.length <= 2) return; // Keep at least 2 outputs
    const updated = routes.filter(r => r.id !== id);
    setRoutes(updated);
    syncData({ routes: updated });
  };

  const handleRenameRoute = (id: string, newName: string) => {
    const updated = routes.map(r => r.id === id ? { ...r, name: newName } : r);
    setRoutes(updated);
    syncData({ routes: updated });
  };

  return (
    <div className="bg-gray-900 border-2 border-blue-500 rounded-lg p-3.5 min-w-[290px] max-w-[340px] shadow-2xl transition hover:shadow-blue-500/10">
      <Handle type="target" position={Position.Left} className="w-3.5 h-3.5 bg-blue-500 -left-2" />
      
      {/* Header */}
      <div className="flex items-center justify-between pb-2 mb-2 border-b border-gray-800">
        <div className="flex items-center gap-2">
          <div className="flex items-center gap-1.5">
            <NodeHealthIndicator serviceName="switchyard" />
            <span className="text-xl">🔀</span>
          </div>
          <div>
            <div className="font-bold text-blue-400 text-sm flex items-center gap-1.5">
              <span>Switchyard Balancer</span>
            </div>
            <div className="text-[10px] text-gray-400 font-mono">Cost &amp; Complexity Router</div>
          </div>
        </div>
        <span className="text-[10px] bg-blue-500/20 text-blue-300 px-2 py-0.5 rounded-full font-mono">
          {routes.length} Targets
        </span>
      </div>
      
      {/* Routing Strategy Selector */}
      <div className="space-y-2.5 text-xs text-gray-300">
        <div>
          <label className="block text-[11px] font-semibold text-gray-400 mb-1">Routing Strategy</label>
          <select 
            className="nodrag w-full bg-gray-950 border border-gray-700 focus:border-blue-500 rounded p-1.5 text-white text-xs outline-none transition cursor-pointer"
            value={strategy}
            onChange={handleStrategyChange}
          >
            <option value="cost-complexity">💰 Cost &amp; Complexity Matrix (Default)</option>
            <option value="cascade-cost">📉 Strict Cost Escalation ($0 ➔ Cloud)</option>
            <option value="lowest-cost">🪙 Lowest Cost First ($0 Local First)</option>
            <option value="lowest-latency">⚡ Lowest Latency</option>
            <option value="round-robin">🔄 Round Robin Multi-Provider</option>
          </select>
        </div>

        {/* Dynamic Provider Tiers */}
        <div>
          <div className="flex justify-between items-center mb-1.5">
            <label className="text-[11px] font-semibold text-gray-400">Target Output Tiers ({routes.length})</label>
            <button
              type="button"
              onClick={handleAddRoute}
              className="nodrag text-[10px] text-blue-400 hover:text-blue-300 font-semibold flex items-center gap-0.5 hover:underline"
            >
              + Add Target
            </button>
          </div>

          <div className="space-y-1.5">
            {routes.map((route) => (
              <div 
                key={route.id}
                className="relative flex items-center justify-between p-1.5 rounded bg-gray-950 border border-gray-800 hover:border-gray-700 transition"
              >
                <div className="flex items-center gap-1.5 flex-1 min-w-0 pr-2">
                  <span 
                    className="w-2 h-2 rounded-full shrink-0" 
                    style={{ backgroundColor: route.color }} 
                  />
                  {editingId === route.id ? (
                    <input
                      autoFocus
                      className="nodrag bg-gray-800 text-white text-[11px] px-1 py-0.5 rounded outline-none border border-blue-500 w-full"
                      value={route.name}
                      onChange={(e) => handleRenameRoute(route.id, e.target.value)}
                      onBlur={() => setEditingId(null)}
                      onKeyDown={(e) => { if (e.key === 'Enter') setEditingId(null); }}
                    />
                  ) : (
                    <span 
                      onClick={() => setEditingId(route.id)}
                      title="Click to rename tier"
                      className="text-[11px] font-medium text-gray-200 truncate cursor-pointer hover:text-blue-300"
                    >
                      {route.name}
                    </span>
                  )}
                </div>

                <div className="flex items-center gap-1.5 shrink-0 pr-3">
                  <span className="text-[9px] font-mono px-1 py-0.5 rounded bg-gray-800/80 text-gray-300">
                    {route.costLabel}
                  </span>
                  {routes.length > 2 && (
                    <button
                      type="button"
                      onClick={() => handleRemoveRoute(route.id)}
                      title="Remove target output"
                      className="nodrag text-gray-500 hover:text-red-400 text-xs px-0.5 leading-none transition"
                    >
                      ✕
                    </button>
                  )}
                </div>

                {/* Right Output Handle for this specific tier */}
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

        {/* Quick Metrics / Dynamic Controls Summary */}
        <div className="pt-2 border-t border-gray-800/80 grid grid-cols-2 gap-1.5 text-[9px] font-mono text-gray-300">
          <div className="flex items-center gap-1 bg-gray-950/80 px-2 py-1 rounded border border-gray-800" title="Upstream Timeout">
            <span className="text-blue-400">⏱️</span>
            <span>{data?.timeoutMs || 60000}ms</span>
          </div>
          <div className="flex items-center gap-1 bg-gray-950/80 px-2 py-1 rounded border border-gray-800" title="Max Retries">
            <span className="text-amber-400">🔁</span>
            <span>{data?.retryCount ?? 1}x retry</span>
          </div>
          <div className="flex items-center gap-1 bg-gray-950/80 px-2 py-1 rounded border border-gray-800" title="Latency Spillover Circuit Breaker">
            <span className="text-cyan-400">🌊</span>
            <span>Spill: {data?.spilloverThresholdMs || 30000}ms</span>
          </div>
          <div className="flex items-center gap-1 bg-gray-950/80 px-2 py-1 rounded border border-gray-800" title="Max Budget Ceiling">
            <span className="text-emerald-400">💰</span>
            <span>Cap: ${data?.maxCostPerRequest !== undefined ? data.maxCostPerRequest : '0.05'}</span>
          </div>
        </div>

        {/* Disaggregated Prefill & KV-Prefix Optimization Controls */}
        <div className="bg-gray-950/80 rounded border border-gray-800 p-2 space-y-2">
          <label className="flex items-center justify-between text-[11px] text-gray-300 cursor-pointer">
            <span className="font-semibold text-blue-300">KV-Cache Prefix Affinity</span>
            <input
              type="checkbox"
              className="nodrag accent-blue-500 w-3.5 h-3.5 cursor-pointer"
              checked={kvPrefixAffinity}
              onChange={(e) => {
                setKvPrefixAffinity(e.target.checked);
                syncData({ kvPrefixAffinity: e.target.checked });
              }}
            />
          </label>

          <label className="flex items-center justify-between text-[11px] text-gray-300 cursor-pointer">
            <span className="font-semibold text-blue-300">Prefill-Decode Isolation</span>
            <input
              type="checkbox"
              className="nodrag accent-blue-500 w-3.5 h-3.5 cursor-pointer"
              checked={enablePrefillIsolation}
              onChange={(e) => {
                setEnablePrefillIsolation(e.target.checked);
                syncData({
                  prefillIsolationThresholdTokens: e.target.checked ? prefillIsolationThreshold : undefined
                });
              }}
            />
          </label>

          {enablePrefillIsolation && (
            <div className="pt-1 border-t border-gray-800 flex items-center justify-between">
              <span className="text-[10px] text-gray-400">Burst Threshold:</span>
              <div className="flex items-center gap-1">
                <input
                  type="number"
                  min={1024}
                  step={1024}
                  className="nodrag w-16 bg-gray-900 border border-gray-700 focus:border-blue-500 rounded px-1.5 py-0.5 text-white font-mono text-[10px] outline-none"
                  value={prefillIsolationThreshold}
                  onChange={(e) => {
                    const v = parseInt(e.target.value, 10) || 4096;
                    setPrefillIsolationThreshold(v);
                    syncData({ prefillIsolationThresholdTokens: v });
                  }}
                />
                <span className="text-[9px] font-mono text-gray-400">tok</span>
              </div>
            </div>
          )}

          <div className="pt-1.5 border-t border-gray-800">
            <label className="block text-[10px] font-semibold text-emerald-400 mb-1">
              🔐 Confidential TEE Policy
            </label>
            <select
              className="nodrag w-full bg-gray-900 border border-gray-700 focus:border-emerald-500 rounded p-1 text-white text-[10px] outline-none"
              value={confidentialPolicy}
              onChange={(e) => {
                setConfidentialPolicy(e.target.value);
                syncData({ confidentialPolicy: e.target.value });
              }}
            >
              <option value="disabled">Standard (Allow Unencrypted)</option>
              <option value="prefer-tee">⚡ Prefer TEE Enclaves</option>
              <option value="require-tee">🔒 Require CPU TEE (SEV-SNP/TDX)</option>
              <option value="require-dual-attestation">🛡️ Require Dual CPU+GPU TEE</option>
            </select>
          </div>

          <div className="pt-1.5 border-t border-gray-800">
            <label className="block text-[10px] font-semibold text-amber-400 mb-1">
              🧮 Sub-4-Bit Quantization Policy
            </label>
            <select
              className="nodrag w-full bg-gray-900 border border-gray-700 focus:border-amber-500 rounded p-1 text-white text-[10px] outline-none"
              value={quantizationPolicy}
              onChange={(e) => {
                setQuantizationPolicy(e.target.value);
                syncData({ quantizationPolicy: e.target.value });
              }}
            >
              <option value="disabled">Standard (Allow Any Quantization)</option>
              <option value="prefer-nvfp4-hadamard">🚀 Prefer NVFP4 + Hadamard (3.42x W4A4)</option>
              <option value="lossless-reasoning">🛡️ Lossless Reasoning (Block Naive INT4/MXFP4)</option>
            </select>
          </div>

          <div className="pt-1.5 border-t border-gray-800">
            <label className="block text-[10px] font-semibold text-indigo-400 mb-1">
              🕸️ AI Cluster Clos Fabric Policy
            </label>
            <select
              className="nodrag w-full bg-gray-900 border border-gray-700 focus:border-indigo-500 rounded p-1 text-white text-[10px] outline-none"
              value={fabricPolicy}
              onChange={(e) => {
                setFabricPolicy(e.target.value);
                syncData({ fabricPolicy: e.target.value });
              }}
            >
              <option value="disabled">Standard (Any Underlay Fabric)</option>
              <option value="prefer-rail-optimized">⚡ Prefer Rail-Optimized (DLB / SRv6 / PxN)</option>
              <option value="require-collision-free-fabric">🛡️ Require Collision-Free Fabric (Block Static ECMP)</option>
            </select>
          </div>
        </div>

        {/* Complexity Auto-Detection Note */}
        <div className="p-2 rounded bg-blue-950/30 border border-blue-900/50 text-[10px] text-blue-300/90 leading-relaxed">
          <span className="font-semibold">💡 Multi-Provider Auto-Routing:</span> Evaluates input length &amp; reasoning depth to dispatch simple queries to free local engines, escalating to higher tiers as complexity increases.
        </div>
      </div>
    </div>
  );
}
