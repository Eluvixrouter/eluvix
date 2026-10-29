"use client";

import { useState, useEffect, useCallback, useRef } from 'react';
import NodeHealthIndicator from '../NodeHealthIndicator';
import { Handle, Position, useReactFlow } from '@xyflow/react';

interface DiscoveredModel {
  id: string;
  name?: string;
  size?: number | string;
  recipe?: string;
  ownedBy?: string;
  labels?: string[];
}

export default function SglangNode({ id, data }: { id: string; data: any }) {
  const { updateNodeData } = useReactFlow();
  const [endpoint, setEndpoint] = useState<string>(data?.endpoint || 'http://localhost:30000');
  const [priority, setPriority] = useState<number>(data?.priority ?? 24);
  const [visionCapable, setVisionCapable] = useState<boolean>(data?.visionCapable ?? false);
  const [selectedModel, setSelectedModel] = useState<string>(data?.selectedModel || '*');
  const [models, setModels] = useState<string[]>(data?.models || []);
  const [details, setDetails] = useState<DiscoveredModel[]>(data?.modelDetails || []);
  const [status, setStatus] = useState<'idle' | 'checking' | 'online' | 'offline'>('idle');

  // Disaggregation & Mooncake RDMA controls
  const [showDisagg, setShowDisagg] = useState<boolean>(Boolean(data?.disaggregation?.role && data.disaggregation.role !== 'colocated'));
  const [disaggregationMode, setDisaggregationMode] = useState<'colocated' | 'prefill' | 'decode' | 'pd-router'>(
    data?.disaggregation?.role === 'pd-disaggregated' ? 'pd-router' : (data?.disaggregation?.role || 'colocated')
  );
  const [transferBackend, setTransferBackend] = useState<'mooncake' | 'nixl'>(
    data?.disaggregation?.kvConnector || 'mooncake'
  );
  const [ibDevice, setIbDevice] = useState<string>(
    data?.disaggregation?.rdmaDevice || 'mlx5_0'
  );
  const [tpSize, setTpSize] = useState<number>(
    data?.disaggregation?.tensorParallelSize ?? 4
  );
  const [kvCacheDtype, setKvCacheDtype] = useState<'fp8_e4m3' | 'bf16' | 'nvfp4' | 'mxfp4'>(
    data?.disaggregation?.kvCacheDtype || 'fp8_e4m3'
  );
  const [prefillEndpoint, setPrefillEndpoint] = useState<string>(
    data?.disaggregation?.prefillEndpoint || 'http://10.200.1.10:30000'
  );
  const [decodeEndpoint, setDecodeEndpoint] = useState<string>(
    data?.disaggregation?.decodeEndpoint || 'http://10.200.1.20:30001'
  );
  const [confidentialEnabled, setConfidentialEnabled] = useState<boolean>(
    Boolean(data?.confidential?.enabled)
  );
  const [confidentialArch, setConfidentialArch] = useState<string>(
    data?.confidential?.architecture || 'sev-snp-h100-cc'
  );
  const [quantFormat, setQuantFormat] = useState<string>(
    data?.quantization?.format || 'fp8_e4m3'
  );
  const [outlierMitigation, setOutlierMitigation] = useState<string>(
    data?.quantization?.outlierMitigation || 'hadamard-quarot'
  );
  const [fabricTopology, setFabricTopology] = useState<string>(
    data?.fabric?.topology || 'rail-dlb-oooddp'
  );
  const [srv6UsidCarrier, setSrv6UsidCarrier] = useState<string>(
    data?.fabric?.srv6UsidCarrier || 'fcbb:bb00:0202:0104:0040::'
  );

  const dataRef = useRef(data);
  dataRef.current = data;

  const syncData = useCallback((updates: Record<string, any>) => {
    if (dataRef.current) {
      Object.assign(dataRef.current, updates);
    }
    if (id) {
      updateNodeData(id, updates);
    }
  }, [id, updateNodeData]);

  const detectModels = useCallback(async (targetEndpoint = endpoint) => {
    setStatus('checking');
    try {
      const res = await fetch('/api/v1/detect-models', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          id: id || data?.id || 'sglang',
          name: 'SGLang Engine',
          type: 'openai-compatible',
          endpoint: targetEndpoint
        })
      });

      const json = await res.json();
      if (json.success && Array.isArray(json.models) && json.models.length > 0) {
        setModels(json.models);
        setDetails(json.details || []);
        setStatus('online');
        syncData({
          endpoint: targetEndpoint,
          models: json.models,
          modelDetails: json.details || [],
          status: 'online'
        });
      } else {
        setModels([]);
        setDetails([]);
        setStatus('offline');
        syncData({ endpoint: targetEndpoint, models: [], status: 'offline' });
      }
    } catch {
      setModels([]);
      setDetails([]);
      setStatus('offline');
      syncData({ endpoint: targetEndpoint, models: [], status: 'offline' });
    }
  }, [endpoint, id, data?.id, syncData]);

  useEffect(() => {
    detectModels();
  }, [detectModels]);

  return (
    <div className="bg-gray-900 border-2 border-emerald-500 rounded-lg p-3.5 min-w-[280px] max-w-[340px] shadow-2xl transition hover:shadow-emerald-500/10">
      <Handle type="target" position={Position.Left} className="w-3.5 h-3.5 bg-emerald-500 -left-2" />

      {/* Node Header */}
      <div className="flex items-center justify-between pb-2 mb-2 border-b border-gray-800">
        <div className="flex items-center gap-2">
          <div className="flex items-center gap-1.5">
            <NodeHealthIndicator serviceName="sglang" />
            <span className="text-xl">🌙</span>
          </div>
          <div>
            <div className="font-bold text-emerald-400 text-sm flex items-center gap-1.5">
              <span>SGLang Engine</span>
            </div>
            <div className="text-[10px] text-gray-400 font-mono">RadixAttention + Mooncake RDMA</div>
          </div>
        </div>

        {/* Live Status Badge */}
        <div className="flex items-center gap-1.5">
          {status === 'checking' && (
            <span className="flex items-center gap-1 text-[10px] text-amber-400 bg-amber-500/20 px-2 py-0.5 rounded-full font-medium animate-pulse">
              <span className="w-1.5 h-1.5 rounded-full bg-amber-400"></span>
              Scanning
            </span>
          )}
          {status === 'online' && (
            <span className="flex items-center gap-1 text-[10px] text-emerald-300 bg-emerald-500/20 px-2 py-0.5 rounded-full font-medium">
              <span className="w-1.5 h-1.5 rounded-full bg-emerald-400"></span>
              Online ({models.length})
            </span>
          )}
          {status === 'offline' && (
            <span className="flex items-center gap-1 text-[10px] text-red-400 bg-red-500/20 px-2 py-0.5 rounded-full font-medium">
              <span className="w-1.5 h-1.5 rounded-full bg-red-400"></span>
              Offline
            </span>
          )}
          <button
            onClick={() => detectModels(endpoint)}
            title="Rescan SGLang models"
            className="nodrag p-1 text-gray-400 hover:text-emerald-400 hover:bg-gray-800 rounded transition"
          >
            <svg className={`w-3.5 h-3.5 ${status === 'checking' ? 'animate-spin' : ''}`} fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
            </svg>
          </button>
        </div>
      </div>

      <div className="space-y-2.5 text-xs text-gray-300">
        <div>
          <div className="flex justify-between items-center mb-1">
            <label className="text-[11px] font-semibold text-gray-400">SGLang Server Endpoint</label>
            <div className="flex gap-1">
              <button
                type="button"
                onClick={() => { setEndpoint('http://localhost:30000'); detectModels('http://localhost:30000'); }}
                className="nodrag text-[9px] px-1 py-0.2 rounded bg-gray-800 hover:bg-emerald-900/50 text-emerald-300 font-mono"
              >
                :30000
              </button>
              <button
                type="button"
                onClick={() => { setEndpoint('http://localhost:8000'); detectModels('http://localhost:8000'); }}
                className="nodrag text-[9px] px-1 py-0.2 rounded bg-gray-800 hover:bg-emerald-900/50 text-emerald-300 font-mono"
              >
                :8000 (LB)
              </button>
            </div>
          </div>
          <input
            className="nodrag w-full bg-gray-950 border border-gray-700 focus:border-emerald-500 rounded p-1.5 text-white font-mono text-[11px] outline-none transition"
            value={endpoint}
            onChange={(e) => {
              setEndpoint(e.target.value);
              syncData({ endpoint: e.target.value });
            }}
            placeholder="http://localhost:30000"
          />
        </div>

        {/* Model Selector */}
        <div>
          <div className="flex justify-between items-center mb-1">
            <label className="text-[11px] font-semibold text-gray-400">Active Routing Model</label>
            {models.length > 0 && (
              <span className="text-[10px] text-emerald-400 font-mono">{models.length} discovered</span>
            )}
          </div>

          {models.length > 0 ? (
            <select
              className="nodrag w-full bg-gray-950 border border-gray-700 focus:border-emerald-500 rounded p-1.5 text-white text-xs outline-none transition cursor-pointer"
              value={selectedModel}
              onChange={(e) => {
                setSelectedModel(e.target.value);
                syncData({ selectedModel: e.target.value });
              }}
            >
              <option value="*">🌟 Serve All Models (*) Universal Fallback</option>
              {models.map(m => {
                const detail = details.find(d => d.id === m);
                const size = detail?.size ? ` (${detail.size})` : '';
                return (
                  <option key={m} value={m}>
                    {m}{size}
                  </option>
                );
              })}
            </select>
          ) : (
            <div className="p-2 rounded bg-gray-950 border border-gray-800 text-[11px] text-gray-400 flex items-center justify-between">
              <span>{status === 'checking' ? 'Querying SGLang /v1/models...' : 'No models detected on port'}</span>
              <button
                onClick={() => detectModels(endpoint)}
                className="nodrag text-emerald-400 hover:underline text-[10px]"
              >
                Scan
              </button>
            </div>
          )}
        </div>

        {/* Disaggregated Serving & Mooncake RDMA */}
        <div className="bg-gray-950/80 rounded border border-gray-800 p-2 space-y-2">
          <div className="flex justify-between items-center">
            <span className="text-[10px] font-semibold uppercase tracking-wider text-emerald-400 flex items-center gap-1">
              <span>⚡</span> Mooncake Disaggregation
            </span>
            <button
              type="button"
              onClick={() => setShowDisagg(!showDisagg)}
              className="nodrag text-[10px] text-gray-400 hover:text-emerald-300"
            >
              {showDisagg ? 'Hide' : disaggregationMode === 'colocated' ? 'Configure' : disaggregationMode}
            </button>
          </div>

          {showDisagg && (
            <div className="space-y-2 pt-1 border-t border-gray-800/80">
              <div>
                <label className="block text-[10px] font-semibold text-gray-400 mb-0.5">Disaggregation Mode</label>
                <select
                  className="nodrag w-full bg-gray-900 border border-gray-700 focus:border-emerald-500 rounded p-1 text-white text-[11px] outline-none"
                  value={disaggregationMode}
                  onChange={(e) => {
                    const next = e.target.value as any;
                    setDisaggregationMode(next);
                    syncData({
                      disaggregation: {
                        role: next === 'pd-router' ? 'pd-disaggregated' : next,
                        kvConnector: transferBackend,
                        kvCacheDtype,
                        tensorParallelSize: tpSize,
                        rdmaDevice: ibDevice,
                        prefillEndpoint: next === 'pd-router' ? prefillEndpoint : undefined,
                        decodeEndpoint: next === 'pd-router' ? decodeEndpoint : undefined
                      }
                    });
                  }}
                >
                  <option value="colocated">Co-Located (Continuous Batching)</option>
                  <option value="prefill">Prefill Worker (--disaggregation-mode prefill)</option>
                  <option value="decode">Decode Worker (--disaggregation-mode decode)</option>
                  <option value="pd-router">Disaggregated PD Router (sglang_router)</option>
                </select>
              </div>

              {disaggregationMode !== 'colocated' && (
                <>
                  <div className="grid grid-cols-2 gap-1.5">
                    <div>
                      <label className="block text-[10px] font-semibold text-gray-400 mb-0.5">Transfer Backend</label>
                      <select
                        className="nodrag w-full bg-gray-900 border border-gray-700 focus:border-emerald-500 rounded p-1 text-white text-[10px] outline-none font-mono"
                        value={transferBackend}
                        onChange={(e) => {
                          const next = e.target.value as any;
                          setTransferBackend(next);
                          syncData({
                            disaggregation: {
                              role: disaggregationMode === 'pd-router' ? 'pd-disaggregated' : disaggregationMode,
                              kvConnector: next,
                              kvCacheDtype,
                              tensorParallelSize: tpSize,
                              rdmaDevice: ibDevice,
                              prefillEndpoint: disaggregationMode === 'pd-router' ? prefillEndpoint : undefined,
                              decodeEndpoint: disaggregationMode === 'pd-router' ? decodeEndpoint : undefined
                            }
                          });
                        }}
                      >
                        <option value="mooncake">Mooncake (RDMA)</option>
                        <option value="nixl">NIXL (GPUDirect)</option>
                      </select>
                    </div>

                    <div>
                      <label className="block text-[10px] font-semibold text-gray-400 mb-0.5">KV Cache Dtype</label>
                      <select
                        className="nodrag w-full bg-gray-900 border border-gray-700 focus:border-emerald-500 rounded p-1 text-white text-[10px] outline-none font-mono"
                        value={kvCacheDtype}
                        onChange={(e) => {
                          const next = e.target.value as any;
                          setKvCacheDtype(next);
                          syncData({
                            disaggregation: {
                              role: disaggregationMode === 'pd-router' ? 'pd-disaggregated' : disaggregationMode,
                              kvConnector: transferBackend,
                              kvCacheDtype: next,
                              tensorParallelSize: tpSize,
                              rdmaDevice: ibDevice,
                              prefillEndpoint: disaggregationMode === 'pd-router' ? prefillEndpoint : undefined,
                              decodeEndpoint: disaggregationMode === 'pd-router' ? decodeEndpoint : undefined
                            }
                          });
                        }}
                      >
                        <option value="fp8_e4m3">fp8_e4m3 (Recommended)</option>
                        <option value="nvfp4">nvfp4 (Blackwell E2M1+E4M3)</option>
                        <option value="mxfp4">mxfp4 (OCP E2M1+E8M0)</option>
                        <option value="bf16">bf16 (Standard)</option>
                      </select>
                    </div>
                  </div>

                  <div className="grid grid-cols-2 gap-1.5">
                    <div>
                      <label className="block text-[10px] font-semibold text-gray-400 mb-0.5">Tensor Parallel (TP)</label>
                      <select
                        className="nodrag w-full bg-gray-900 border border-gray-700 focus:border-emerald-500 rounded p-1 text-white text-[10px] outline-none font-mono"
                        value={tpSize}
                        onChange={(e) => {
                          const v = parseInt(e.target.value, 10);
                          setTpSize(v);
                          syncData({
                            disaggregation: {
                              role: disaggregationMode === 'pd-router' ? 'pd-disaggregated' : disaggregationMode,
                              kvConnector: transferBackend,
                              kvCacheDtype,
                              tensorParallelSize: v,
                              rdmaDevice: ibDevice,
                              prefillEndpoint: disaggregationMode === 'pd-router' ? prefillEndpoint : undefined,
                              decodeEndpoint: disaggregationMode === 'pd-router' ? decodeEndpoint : undefined
                            }
                          });
                        }}
                      >
                        <option value={1}>TP=1</option>
                        <option value={2}>TP=2</option>
                        <option value={4}>TP=4 (H100)</option>
                        <option value={8}>TP=8 (HGX)</option>
                      </select>
                    </div>

                    <div>
                      <label className="block text-[10px] font-semibold text-gray-400 mb-0.5">IB Device</label>
                      <input
                        type="text"
                        className="nodrag w-full bg-gray-900 border border-gray-700 focus:border-emerald-500 rounded p-1 text-white font-mono text-[10px] outline-none"
                        value={ibDevice}
                        onChange={(e) => {
                          setIbDevice(e.target.value);
                          syncData({
                            disaggregation: {
                              role: disaggregationMode === 'pd-router' ? 'pd-disaggregated' : disaggregationMode,
                              kvConnector: transferBackend,
                              kvCacheDtype,
                              tensorParallelSize: tpSize,
                              rdmaDevice: e.target.value,
                              prefillEndpoint: disaggregationMode === 'pd-router' ? prefillEndpoint : undefined,
                              decodeEndpoint: disaggregationMode === 'pd-router' ? decodeEndpoint : undefined
                            }
                          });
                        }}
                        placeholder="mlx5_0"
                      />
                    </div>
                  </div>

                  {disaggregationMode === 'pd-router' && (
                    <div className="space-y-1.5 pt-1 border-t border-gray-800">
                      <div>
                        <label className="block text-[10px] font-semibold text-gray-400 mb-0.5">Prefill Worker URL</label>
                        <input
                          type="text"
                          className="nodrag w-full bg-gray-900 border border-gray-700 focus:border-emerald-500 rounded p-1 text-white font-mono text-[10px] outline-none"
                          value={prefillEndpoint}
                          onChange={(e) => {
                            setPrefillEndpoint(e.target.value);
                            syncData({
                              disaggregation: {
                                role: 'pd-disaggregated',
                                kvConnector: transferBackend,
                                kvCacheDtype,
                                tensorParallelSize: tpSize,
                                rdmaDevice: ibDevice,
                                prefillEndpoint: e.target.value,
                                decodeEndpoint
                              }
                            });
                          }}
                          placeholder="http://10.200.1.10:30000"
                        />
                      </div>
                      <div>
                        <label className="block text-[10px] font-semibold text-gray-400 mb-0.5">Decode Worker URL</label>
                        <input
                          type="text"
                          className="nodrag w-full bg-gray-900 border border-gray-700 focus:border-emerald-500 rounded p-1 text-white font-mono text-[10px] outline-none"
                          value={decodeEndpoint}
                          onChange={(e) => {
                            setDecodeEndpoint(e.target.value);
                            syncData({
                              disaggregation: {
                                role: 'pd-disaggregated',
                                kvConnector: transferBackend,
                                kvCacheDtype,
                                tensorParallelSize: tpSize,
                                rdmaDevice: ibDevice,
                                prefillEndpoint,
                                decodeEndpoint: e.target.value
                              }
                            });
                          }}
                          placeholder="http://10.200.1.20:30001"
                        />
                      </div>
                    </div>
                  )}
                </>
              )}
            </div>
          )}
        </div>

        {/* Priority Slider */}
        <div>
          <div className="flex justify-between items-center mb-1">
            <label className="text-[11px] font-semibold text-gray-400">Router Priority</label>
            <span className="text-[11px] font-mono text-emerald-400">{priority}</span>
          </div>
          <input
            type="range"
            min="1"
            max="50"
            step="1"
            className="nodrag w-full accent-emerald-500 cursor-pointer"
            value={priority}
            onChange={(e) => {
              const v = parseInt(e.target.value, 10) || 1;
              setPriority(v);
              syncData({ priority: v });
            }}
          />
        </div>

        {/* Vision Capable */}
        <div className="flex justify-between items-center bg-gray-900/60 p-2 rounded border border-gray-800">
          <label className="text-[11px] font-semibold text-gray-400">Vision Capable (Multimodal)</label>
          <input
            type="checkbox"
            className="nodrag accent-emerald-500 w-3 h-3 cursor-pointer"
            checked={visionCapable}
            onChange={(e) => {
              setVisionCapable(e.target.checked);
              syncData({ visionCapable: e.target.checked });
            }}
          />
        </div>

        {/* Confidential TEE Enclave */}
        <div className="bg-gray-900/60 p-2 rounded border border-gray-800 space-y-1.5">
          <div className="flex justify-between items-center">
            <label className="text-[11px] font-semibold text-emerald-400 flex items-center gap-1">
              <span>🔐</span> Confidential TEE Enclave
            </label>
            <input
              type="checkbox"
              className="nodrag accent-emerald-500 w-3 h-3 cursor-pointer"
              checked={confidentialEnabled}
              onChange={(e) => {
                const next = e.target.checked;
                setConfidentialEnabled(next);
                syncData({
                  confidential: {
                    enabled: next,
                    architecture: confidentialArch
                  }
                });
              }}
            />
          </div>
          {confidentialEnabled && (
            <select
              className="nodrag w-full bg-gray-950 border border-emerald-700/60 rounded p-1 text-emerald-300 text-[10px] font-mono outline-none"
              value={confidentialArch}
              onChange={(e) => {
                const next = e.target.value;
                setConfidentialArch(next);
                syncData({
                  confidential: {
                    enabled: confidentialEnabled,
                    architecture: next
                  }
                });
              }}
            >
              <option value="sev-snp-h100-cc">AMD SEV-SNP + H100 CC-On</option>
              <option value="tdx-b200-tee-io">Intel TDX + B200 TEE-I/O</option>
            </select>
          )}
        </div>

        {/* Sub-4-Bit Microscaling & Hadamard Rotation (NVFP4 / MXFP4) */}
        <div className="bg-gray-900/60 p-2 rounded border border-gray-800 space-y-1.5">
          <div className="flex justify-between items-center">
            <label className="text-[10px] font-semibold text-amber-400 flex items-center gap-1">
              <span>🧮</span> Precision &amp; Microscaling
            </label>
            <span className="text-[9px] font-mono text-amber-300/80">
              {quantFormat === 'nvfp4' ? '4.50b W4A4' : quantFormat === 'mxfp4' ? '4.25b W4A4' : quantFormat}
            </span>
          </div>
          <div className="grid grid-cols-2 gap-1.5">
            <select
              className="nodrag w-full bg-gray-950 border border-gray-700 focus:border-amber-500 rounded p-1 text-white text-[10px] font-mono outline-none"
              value={quantFormat}
              onChange={(e) => {
                const next = e.target.value;
                setQuantFormat(next);
                syncData({
                  quantization: {
                    enabled: true,
                    format: next,
                    outlierMitigation
                  }
                });
              }}
            >
              <option value="fp8_e4m3">FP8 (E4M3 W8A8)</option>
              <option value="nvfp4">NVFP4 (16-el E2M1+E4M3)</option>
              <option value="mxfp4">OCP MXFP4 (32-el E8M0)</option>
              <option value="int4_awq">INT4-AWQ (W4A16)</option>
              <option value="bf16">BF16 (16-bit)</option>
            </select>
            <select
              className="nodrag w-full bg-gray-950 border border-gray-700 focus:border-amber-500 rounded p-1 text-white text-[10px] font-mono outline-none"
              value={outlierMitigation}
              onChange={(e) => {
                const next = e.target.value;
                setOutlierMitigation(next);
                syncData({
                  quantization: {
                    enabled: true,
                    format: quantFormat,
                    outlierMitigation: next
                  }
                });
              }}
            >
              <option value="hadamard-quarot">QuaRot FWHT (R1-R4)</option>
              <option value="spinquant">SpinQuant Learned H</option>
              <option value="svdquant">SVDQuant (Rank-16)</option>
              <option value="none">No Rotation (Naive)</option>
            </select>
          </div>
        </div>

        {/* Rail-Optimized Clos Fabric (BGP EVPN / SRv6 uSID / DLB + OOO-DDP) */}
        <div className="bg-gray-900/60 p-2 rounded border border-gray-800 space-y-1.5">
          <div className="flex justify-between items-center">
            <label className="text-[10px] font-semibold text-indigo-400 flex items-center gap-1">
              <span>🕸️</span> Clos Fabric &amp; RoCEv2 Routing
            </label>
            <span className="text-[9px] font-mono text-indigo-300/80">
              {fabricTopology === 'rail-dlb-oooddp'
                ? '97.8% BusBW'
                : fabricTopology === 'rail-srv6-usid'
                ? '94.8% uSID'
                : fabricTopology === 'rail-pxn-ecmp'
                ? '82.1% PxN'
                : '44.6% ECMP'}
            </span>
          </div>
          <select
            className="nodrag w-full bg-gray-950 border border-gray-700 focus:border-indigo-500 rounded p-1 text-white text-[10px] font-mono outline-none"
            value={fabricTopology}
            onChange={(e) => {
              const next = e.target.value;
              setFabricTopology(next);
              syncData({
                fabric: {
                  enabled: true,
                  topology: next,
                  ncclPxn: next !== 'tor-static-ecmp',
                  bgpUnnumberedEvpn: next !== 'tor-static-ecmp',
                  srv6UsidCarrier: next === 'rail-srv6-usid' ? srv6UsidCarrier : undefined,
                  dlbPacketSpraying: next === 'rail-dlb-oooddp',
                  oooDdpEnabled: next === 'rail-dlb-oooddp'
                }
              });
            }}
          >
            <option value="rail-dlb-oooddp">Rail-Optimized + DLB Spraying (OOO-DDP)</option>
            <option value="rail-srv6-usid">Rail-Optimized + SRv6 uSID Spine Pinning</option>
            <option value="rail-pxn-ecmp">Rail-Optimized + NCCL PxN (4 QPs)</option>
            <option value="tor-static-ecmp">Standard ToR + Static 5-Tuple ECMP (1 QP)</option>
          </select>
          {fabricTopology === 'rail-srv6-usid' && (
            <input
              className="nodrag w-full bg-gray-950 border border-indigo-700/60 rounded p-1 text-indigo-200 text-[10px] font-mono outline-none"
              value={srv6UsidCarrier}
              onChange={(e) => {
                const next = e.target.value;
                setSrv6UsidCarrier(next);
                syncData({
                  fabric: {
                    enabled: true,
                    topology: fabricTopology,
                    ncclPxn: true,
                    bgpUnnumberedEvpn: true,
                    srv6UsidCarrier: next
                  }
                });
              }}
              placeholder="fcbb:bb00:0202:0104:0040::"
            />
          )}
        </div>
      </div>

      <Handle type="source" position={Position.Right} className="w-3.5 h-3.5 bg-emerald-500 -right-2" />
    </div>
  );
}
