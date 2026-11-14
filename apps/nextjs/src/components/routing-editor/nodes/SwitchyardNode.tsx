"use client";

import { useState, useCallback, useEffect } from 'react';
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
  const [mediaIntentRouting, setMediaIntentRouting] = useState<boolean>(data?.mediaIntentRouting ?? true);
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
  const [crsPolicy, setCrsPolicy] = useState<string>(
    data?.crsPolicy || 'disabled'
  );
  const [attentionPolicy, setAttentionPolicy] = useState<string>(
    data?.attentionPolicy || 'disabled'
  );
  const [maxDailySpendUsd, setMaxDailySpendUsd] = useState<number>(
    typeof data?.maxDailySpendUsd === 'number' ? data.maxDailySpendUsd : 0
  );
  const [budgetExhaustedAction, setBudgetExhaustedAction] = useState<string>(
    data?.budgetExhaustedAction || 'prefer-local'
  );

  // Keep local editable state in sync when the node data reference changes
  // (layout load, undo/redo, decompile). Adjusting state during render is the
  // React-sanctioned replacement for a resync effect: React discards this
  // render and re-renders with the new state before committing, so no
  // cascading post-commit render happens.
  const [prevData, setPrevData] = useState(data);
  if (data !== prevData) {
    setPrevData(data);
    if (data) {
      setStrategy(data.strategy || 'cost-complexity');
      setRoutes(Array.isArray(data.routes) && data.routes.length > 0 ? data.routes : DEFAULT_ROUTES);
      setKvPrefixAffinity(data.kvPrefixAffinity ?? true);
      setMediaIntentRouting(data.mediaIntentRouting ?? true);
      setPrefillIsolationThreshold(data.prefillIsolationThresholdTokens ?? 4096);
      setEnablePrefillIsolation(data.prefillIsolationThresholdTokens !== undefined);
      setConfidentialPolicy(data.confidentialPolicy || 'disabled');
      setQuantizationPolicy(data.quantizationPolicy || 'disabled');
      setFabricPolicy(data.fabricPolicy || 'disabled');
      setCrsPolicy(data.crsPolicy || 'disabled');
      setAttentionPolicy(data.attentionPolicy || 'disabled');
      setMaxDailySpendUsd(typeof data.maxDailySpendUsd === 'number' ? data.maxDailySpendUsd : 0);
      setBudgetExhaustedAction(data.budgetExhaustedAction || 'prefer-local');
    }
  }

  // Synchronize with node data
  const syncData = useCallback((updates: Record<string, any>) => {
    if (data) {
      Object.assign(data, updates);
    }
    if (id) {
      updateNodeData(id, updates);
    }
  }, [id, data, updateNodeData]);

  // Persist missing defaults into the node data via the store, never by
  // mutating the `data` prop. Guarded so each default is written once; the
  // compiler defaults the same values for missing fields, so this only
  // keeps saved layouts self-contained.
  useEffect(() => {
    if (!data || !id) return;
    const missing: Record<string, unknown> = {};
    if (!data.strategy) missing.strategy = 'cost-complexity';
    if (!data.routes) missing.routes = DEFAULT_ROUTES;
    if (data.timeoutMs === undefined) missing.timeoutMs = 60000;
    if (data.retryCount === undefined) missing.retryCount = 1;
    if (data.spilloverThresholdMs === undefined) missing.spilloverThresholdMs = 30000;
    if (data.codeEscalation === undefined) missing.codeEscalation = true;
    if (data.kvPrefixAffinity === undefined) missing.kvPrefixAffinity = true;
    if (!data.complexityThresholds) {
      missing.complexityThresholds = { moderate: 300, heavy: 1500, frontier: 6000 };
    }
    if (data.maxCostPerRequest === undefined) missing.maxCostPerRequest = 0.05;
    if (Object.keys(missing).length > 0) updateNodeData(id, missing);
  }, [data, id, updateNodeData]);

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
            <option value="thompson-bandit">🎰 Contextual Thompson Bandit (Online RL)</option>
            <option value="stall-escalation">🧬 Neuro-Symbolic Stall Escalation</option>
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

          <label
            className="flex items-center justify-between text-[11px] text-gray-300 cursor-pointer"
            title="Auto-steer image/video/3D prompts to ComfyUI & isolate text/code/tool chat away from diffusion engines"
          >
            <span className="font-semibold text-fuchsia-300">🎨 Modality &amp; Synthesis Steering</span>
            <input
              type="checkbox"
              className="nodrag accent-fuchsia-500 w-3.5 h-3.5 cursor-pointer"
              checked={mediaIntentRouting}
              onChange={(e) => {
                setMediaIntentRouting(e.target.checked);
                syncData({ mediaIntentRouting: e.target.checked });
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

          <div className="pt-1.5 border-t border-gray-800">
            <label className="block text-[10px] font-semibold text-fuchsia-400 mb-1">
              🧬 Neuro-Symbolic CRS Verification Policy
            </label>
            <select
              className="nodrag w-full bg-gray-900 border border-gray-700 focus:border-fuchsia-500 rounded p-1 text-white text-[10px] outline-none"
              value={crsPolicy}
              onChange={(e) => {
                setCrsPolicy(e.target.value);
                syncData({ crsPolicy: e.target.value });
              }}
            >
              <option value="disabled">Standard (No CRS Triage Required)</option>
              <option value="slice-and-verify">⚡ Slice &amp; Verify (Prefer CRS Slicer/Sanitizer)</option>
              <option value="strict-zero-false-positive">🛡️ Strict Zero-False-Positive (Require CRS Verifier)</option>
            </select>
          </div>

          <div className="pt-1.5 border-t border-gray-800">
            <label className="block text-[10px] font-semibold text-cyan-400 mb-1">
              ⚡ FlashAttention-3 &amp; tcgen05 Kernel Policy
            </label>
            <select
              className="nodrag w-full bg-gray-900 border border-gray-700 focus:border-cyan-500 rounded p-1 text-white text-[10px] outline-none"
              value={attentionPolicy}
              onChange={(e) => {
                setAttentionPolicy(e.target.value);
                syncData({ attentionPolicy: e.target.value });
              }}
            >
              <option value="disabled">Standard (Allow Any Attention Kernel)</option>
              <option value="prefer-fa3-warp-specialized">⚡ Prefer FA3 Warp-Specialized (WGMMA + TMA 128B)</option>
              <option value="prefer-blackwell-tmem">🚀 Prefer Blackwell SM100 tcgen05 + 256KB TMEM</option>
              <option value="require-fp8-ping-pong">🛡️ Require FP8 Ping-Pong + Hadamard (Block FA2/SDPA)</option>
            </select>
          </div>

          <div className="pt-1.5 border-t border-gray-800 space-y-1.5">
            <div className="flex items-center justify-between">
              <label className="text-[10px] font-semibold text-emerald-400">
                💵 24h Cloud Spend Cap (USD)
              </label>
              <input
                type="number"
                min={0}
                step={0.5}
                value={maxDailySpendUsd}
                placeholder="0 = off"
                onChange={(e) => {
                  const val = Math.max(0, Number(e.target.value) || 0);
                  setMaxDailySpendUsd(val);
                  syncData({ maxDailySpendUsd: val > 0 ? val : undefined });
                }}
                className="nodrag w-20 bg-gray-900 border border-gray-700 focus:border-emerald-500 rounded px-1.5 py-0.5 text-[10px] text-emerald-300 font-mono text-right outline-none"
              />
            </div>
            {maxDailySpendUsd > 0 && (
              <select
                className="nodrag w-full bg-gray-900 border border-gray-700 focus:border-emerald-500 rounded p-1 text-white text-[10px] outline-none"
                value={budgetExhaustedAction}
                onChange={(e) => {
                  setBudgetExhaustedAction(e.target.value);
                  syncData({ budgetExhaustedAction: e.target.value });
                }}
              >
                <option value="prefer-local">🌱 Soft-Failover to $0 Local Engines (Default)</option>
                <option value="strict-local">🔒 Strict $0 Local Only (429 if no local)</option>
                <option value="reject">🛑 Hard Reject All Traffic (HTTP 429)</option>
              </select>
            )}
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
