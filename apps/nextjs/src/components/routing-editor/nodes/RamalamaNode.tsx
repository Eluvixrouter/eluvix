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
  contextLength?: number;
}

export default function RamalamaNode({ id, data }: { id: string; data: any }) {
  const { updateNodeData } = useReactFlow();
  const [endpoint, setEndpoint] = useState<string>(data?.endpoint || 'http://localhost:8080');
  const [priority, setPriority] = useState<number>(data?.priority ?? 21);
  const [visionCapable, setVisionCapable] = useState<boolean>(data?.visionCapable ?? false);
  const [selectedModel, setSelectedModel] = useState<string>(data?.selectedModel || '*');
  const [models, setModels] = useState<string[]>(data?.models || []);
  const [details, setDetails] = useState<DiscoveredModel[]>(data?.modelDetails || []);
  const [status, setStatus] = useState<'idle' | 'checking' | 'online' | 'cached' | 'offline'>('idle');
  const [expanded, setExpanded] = useState<boolean>(false);
  const [showOciConfig, setShowOciConfig] = useState<boolean>(false);

  const [containerEngine, setContainerEngine] = useState<'podman' | 'docker' | 'nocontainer'>(
    data?.ramalama?.containerEngine || 'podman'
  );
  const [runtime, setRuntime] = useState<'llama.cpp' | 'vllm' | 'mlx'>(
    data?.ramalama?.runtime || 'llama.cpp'
  );
  const [ociTransport, setOciTransport] = useState<'oci' | 'hf' | 'ollama' | 'rlcr'>(
    data?.ramalama?.ociTransport || 'oci'
  );
  const [accelerator, setAccelerator] = useState<'auto' | 'cuda' | 'rocm' | 'vulkan' | 'intel'>(
    data?.ramalama?.accelerator || 'auto'
  );
  const [selinuxEnforcing, setSelinuxEnforcing] = useState<boolean>(
    data?.ramalama?.selinuxEnforcing ?? true
  );
  const [networkIsolation, setNetworkIsolation] = useState<'bridge' | 'none' | 'host'>(
    data?.ramalama?.networkIsolation || 'bridge'
  );
  const [tempContainer, setTempContainer] = useState<boolean>(
    data?.ramalama?.tempContainer ?? false
  );
  const [ragOciUri, setRagOciUri] = useState<string>(
    data?.ramalama?.ragOciUri || ''
  );
  const [generateMode, setGenerateMode] = useState<'none' | 'quadlet' | 'kube' | 'compose'>(
    data?.ramalama?.generateMode || 'quadlet'
  );

  const dataRef = useRef(data);
  dataRef.current = data;

  useEffect(() => {
    if (!data) return;
    setEndpoint(data.endpoint || 'http://localhost:8080');
    setPriority(data.priority ?? 21);
    setVisionCapable(data.visionCapable ?? false);
    setSelectedModel(data.selectedModel || '*');
    if (Array.isArray(data.models)) setModels(data.models);
    if (Array.isArray(data.modelDetails)) setDetails(data.modelDetails);
    if (data.ramalama) {
      setContainerEngine(data.ramalama.containerEngine || 'podman');
      setRuntime(data.ramalama.runtime || 'llama.cpp');
      setOciTransport(data.ramalama.ociTransport || 'oci');
      setAccelerator(data.ramalama.accelerator || 'auto');
      setSelinuxEnforcing(data.ramalama.selinuxEnforcing ?? true);
      setNetworkIsolation(data.ramalama.networkIsolation || 'bridge');
      setTempContainer(data.ramalama.tempContainer ?? false);
      setRagOciUri(data.ramalama.ragOciUri || '');
      setGenerateMode(data.ramalama.generateMode || 'quadlet');
    }
  }, [data]);

  const syncData = useCallback((updates: Record<string, any>) => {
    if (dataRef.current) {
      Object.assign(dataRef.current, updates);
    }
    if (id) {
      updateNodeData(id, updates);
    }
  }, [id, updateNodeData]);

  const syncRamalamaConfig = (partial: Record<string, any>) => {
    const nextCfg = {
      containerEngine,
      runtime,
      ociTransport,
      accelerator,
      selinuxEnforcing,
      networkIsolation,
      tempContainer,
      ...(ragOciUri ? { ragOciUri } : {}),
      generateMode,
      ...(dataRef.current?.ramalama || {}),
      ...partial
    };
    if (!nextCfg.ragOciUri) {
      delete nextCfg.ragOciUri;
    }
    syncData({ ramalama: nextCfg });
  };

  const detectModels = useCallback(async (targetEndpoint = endpoint) => {
    setStatus('checking');
    try {
      const res = await fetch('/api/v1/detect-models', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          id: id || data?.id || 'ramalama',
          name: 'RamaLama OCI Engine',
          type: 'ramalama',
          endpoint: targetEndpoint
        })
      });

      const json = await res.json();
      if (json.success && Array.isArray(json.models) && json.models.length > 0) {
        setModels(json.models);
        setDetails(json.details || []);
        const nextStatus = json.offlineCached ? 'cached' : 'online';
        setStatus(nextStatus);
        syncData({
          endpoint: targetEndpoint,
          models: json.models,
          modelDetails: json.details || [],
          status: nextStatus
        });
      } else {
        const preservedModels =
          Array.isArray(dataRef.current?.models) && dataRef.current.models.length > 0
            ? dataRef.current.models
            : [];
        setModels(preservedModels);
        setDetails([]);
        setStatus('offline');
        syncData({ endpoint: targetEndpoint, models: preservedModels, status: 'offline' });
      }
    } catch {
      const preservedModels =
        Array.isArray(dataRef.current?.models) && dataRef.current.models.length > 0
          ? dataRef.current.models
          : [];
      setModels(preservedModels);
      setDetails([]);
      setStatus('offline');
      syncData({ endpoint: targetEndpoint, models: preservedModels, status: 'offline' });
    }
  }, [endpoint, id, data?.id, syncData]);

  useEffect(() => {
    detectModels();
  }, [detectModels]);

  const handleEndpointChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const val = e.target.value;
    setEndpoint(val);
    syncData({ endpoint: val });
  };

  const handlePriorityChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const val = parseInt(e.target.value, 10) || 1;
    setPriority(val);
    syncData({ priority: val });
  };

  const handleModelSelect = (e: React.ChangeEvent<HTMLSelectElement>) => {
    const val = e.target.value;
    setSelectedModel(val);
    syncData({ selectedModel: val });
  };

  let portNum = '8080';
  try {
    const parsed = new URL(endpoint);
    if (parsed.port) portNum = parsed.port;
  } catch {}

  const modelTarget =
    selectedModel && selectedModel !== '*'
      ? selectedModel.includes('://')
        ? selectedModel
        : `${ociTransport}://${selectedModel}`
      : `${ociTransport}://llama3.2:3b`;

  const engineFlag =
    containerEngine === 'nocontainer'
      ? '--nocontainer'
      : `--engine ${containerEngine}`;
  const runtimeFlag = runtime !== 'llama.cpp' ? ` --runtime ${runtime}` : '';
  const imageFlag =
    accelerator !== 'auto'
      ? ` --image quay.io/ramalama/${accelerator === 'intel' ? 'intel-gpu' : accelerator}:latest`
      : '';
  const selinuxFlag = containerEngine !== 'nocontainer' && selinuxEnforcing ? ' --selinux=true' : '';
  const netFlag = containerEngine !== 'nocontainer' && networkIsolation === 'none' ? ' --network=none' : '';
  const tempFlag = tempContainer ? ' --temp' : '';
  const ragFlag = ragOciUri.trim() ? ` --rag ${ragOciUri.trim()}` : '';
  const genFlag = generateMode !== 'none' ? ` --generate=${generateMode}` : '';
  const cliCommandPreview = `ramalama ${engineFlag}${runtimeFlag}${imageFlag}${selinuxFlag} serve${netFlag}${tempFlag}${ragFlag}${genFlag} --port ${portNum} --host 0.0.0.0 ${modelTarget}`;

  return (
    <div className="bg-gray-900 border-2 border-orange-500 rounded-lg p-3.5 min-w-[280px] max-w-[340px] shadow-2xl transition hover:shadow-orange-500/10">
      <Handle type="target" position={Position.Left} className="w-3.5 h-3.5 bg-orange-500 -left-2" />

      {/* Node Header */}
      <div className="flex items-center justify-between pb-2 mb-2 border-b border-gray-800">
        <div className="flex items-center gap-2">
          <div className="flex items-center gap-1.5">
            <NodeHealthIndicator serviceName="ramalama" liveTelemetry={data?.liveTelemetry} />
            <span className="text-xl">📦</span>
          </div>
          <div>
            <div className="font-bold text-orange-400 text-sm flex items-center gap-1.5">
              <span>{data?.label || 'RamaLama Engine'}</span>
            </div>
            <div className="text-[10px] text-gray-400 font-mono">Podman / OCI Container AI</div>
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
              Serving ({models.length})
            </span>
          )}
          {status === 'cached' && (
            <span className="flex items-center gap-1 text-[10px] text-orange-300 bg-orange-500/20 px-2 py-0.5 rounded-full font-medium" title="Discovered from local ramalama OCI store">
              <span className="w-1.5 h-1.5 rounded-full bg-orange-400"></span>
              CLI Cached ({models.length})
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
            title="Rescan RamaLama models"
            className="nodrag p-1 text-gray-400 hover:text-orange-300 hover:bg-gray-800 rounded transition"
          >
            <svg className={`w-3.5 h-3.5 ${status === 'checking' ? 'animate-spin' : ''}`} fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
            </svg>
          </button>
        </div>
      </div>

      {/* Endpoint & Priority Config */}
      <div className="space-y-2.5 text-xs text-gray-300">
        <div>
          <label className="block text-[11px] font-semibold text-gray-400 mb-1">RamaLama Server Endpoint</label>
          <input
            className="nodrag w-full bg-gray-950 border border-gray-700 focus:border-orange-400 rounded p-1.5 text-white font-mono text-[11px] outline-none transition"
            value={endpoint}
            onChange={handleEndpointChange}
            placeholder="http://localhost:8080"
          />
        </div>

        {/* Discovered Models Selector */}
        <div>
          <div className="flex justify-between items-center mb-1">
            <label className="text-[11px] font-semibold text-gray-400">Active OCI Routing Model</label>
            {models.length > 0 && (
              <span className="text-[10px] text-orange-300 font-mono">{models.length} discovered</span>
            )}
          </div>

          {models.length > 0 ? (
            <select
              className="nodrag w-full bg-gray-950 border border-gray-700 focus:border-orange-400 rounded p-1.5 text-white text-xs outline-none transition cursor-pointer"
              value={selectedModel}
              onChange={handleModelSelect}
            >
              <option value="*">🌟 Serve All Models (*) Universal Fallback</option>
              {models.map(m => {
                const detail = details.find(d => d.id === m);
                const size = detail?.size ? ` (${detail.size})` : '';
                const tag = detail?.labels && detail.labels.length > 0 ? ` [${detail.labels.join(', ')}]` : '';
                return (
                  <option key={m} value={m}>
                    {m}{tag}{size}
                  </option>
                );
              })}
            </select>
          ) : (
            <div className="p-2 rounded bg-gray-950 border border-gray-800 text-[11px] text-gray-400 flex items-center justify-between">
              <span>{status === 'checking' ? 'Querying RamaLama /v1/models...' : `No models detected on :${portNum}`}</span>
              <button
                onClick={() => detectModels(endpoint)}
                className="nodrag text-orange-400 hover:underline text-[10px]"
              >
                Scan
              </button>
            </div>
          )}
        </div>

        {/* Discovered Models Badges / List */}
        {models.length > 0 && (
          <div className="bg-gray-950/80 rounded border border-gray-800 p-2">
            <div className="flex justify-between items-center mb-1.5">
              <span className="text-[10px] font-semibold uppercase tracking-wider text-gray-400">Discovered OCI Models</span>
              <button
                onClick={() => setExpanded(!expanded)}
                className="nodrag text-[10px] text-orange-400 hover:text-orange-300"
              >
                {expanded ? 'Collapse' : `View All (${models.length})`}
              </button>
            </div>

            <div className={`space-y-1 overflow-y-auto ${expanded ? 'max-h-40' : 'max-h-20'}`}>
              {(expanded ? models : models.slice(0, 3)).map(m => {
                const detail = details.find(d => d.id === m);
                return (
                  <div
                    key={m}
                    onClick={() => {
                      setSelectedModel(m);
                      syncData({ selectedModel: m });
                    }}
                    className={`nodrag text-[10px] p-1 rounded flex items-center justify-between cursor-pointer transition ${
                      selectedModel === m ? 'bg-orange-500/20 border border-orange-400 text-orange-200' : 'bg-gray-900/60 hover:bg-gray-800 text-gray-300'
                    }`}
                  >
                    <span className="font-mono truncate max-w-[170px]" title={m}>{m}</span>
                    <div className="flex items-center gap-1 shrink-0">
                      {detail?.labels && detail.labels[0] && (
                        <span className="text-[9px] bg-orange-950 text-orange-300 border border-orange-800/60 px-1 rounded">
                          {detail.labels[0]}
                        </span>
                      )}
                      {detail?.size && (
                        <span className="text-[9px] text-gray-400">
                          {detail.size}
                        </span>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        )}

        {/* OCI Container & Runtime Controls */}
        <div className="bg-gray-950/90 rounded border border-orange-900/50 p-2 space-y-2">
          <div className="flex items-center justify-between">
            <span className="text-[10px] font-semibold uppercase tracking-wider text-orange-300 flex items-center gap-1">
              <span>🐳</span> OCI Runtime ({containerEngine} • {runtime})
            </span>
            <button
              type="button"
              onClick={() => setShowOciConfig(!showOciConfig)}
              className="nodrag text-[10px] text-orange-400 hover:text-orange-300 font-mono"
            >
              {showOciConfig ? 'Hide' : 'Configure'}
            </button>
          </div>

          {showOciConfig && (
            <div className="space-y-2 pt-1 border-t border-gray-800">
              <div className="grid grid-cols-2 gap-1.5">
                <div>
                  <label className="block text-[10px] text-gray-400 mb-0.5">Container Engine</label>
                  <select
                    className="nodrag w-full bg-gray-900 border border-gray-700 rounded p-1 text-[11px] text-white outline-none"
                    value={containerEngine}
                    onChange={(e) => {
                      const val = e.target.value as 'podman' | 'docker' | 'nocontainer';
                      setContainerEngine(val);
                      syncRamalamaConfig({ containerEngine: val });
                    }}
                  >
                    <option value="podman">Podman (Rootless)</option>
                    <option value="docker">Docker Engine</option>
                    <option value="nocontainer">Host (--nocontainer)</option>
                  </select>
                </div>
                <div>
                  <label className="block text-[10px] text-gray-400 mb-0.5">Inference Runtime</label>
                  <select
                    className="nodrag w-full bg-gray-900 border border-gray-700 rounded p-1 text-[11px] text-white outline-none"
                    value={runtime}
                    onChange={(e) => {
                      const val = e.target.value as 'llama.cpp' | 'vllm' | 'mlx';
                      setRuntime(val);
                      syncRamalamaConfig({ runtime: val });
                    }}
                  >
                    <option value="llama.cpp">llama.cpp (GGUF)</option>
                    <option value="vllm">vLLM Runtime</option>
                    <option value="mlx">MLX (Apple Silicon)</option>
                  </select>
                </div>
              </div>

              <div className="grid grid-cols-2 gap-1.5">
                <div>
                  <label className="block text-[10px] text-gray-400 mb-0.5">Model Transport</label>
                  <select
                    className="nodrag w-full bg-gray-900 border border-gray-700 rounded p-1 text-[11px] text-white outline-none"
                    value={ociTransport}
                    onChange={(e) => {
                      const val = e.target.value as 'oci' | 'hf' | 'ollama' | 'rlcr';
                      setOciTransport(val);
                      syncRamalamaConfig({ ociTransport: val });
                    }}
                  >
                    <option value="oci">oci:// (OCI Artifact)</option>
                    <option value="hf">hf:// (HuggingFace)</option>
                    <option value="ollama">ollama:// (Ollama)</option>
                    <option value="rlcr">rlcr:// (RamaLama)</option>
                  </select>
                </div>
                <div>
                  <label className="block text-[10px] text-gray-400 mb-0.5">GPU Image</label>
                  <select
                    className="nodrag w-full bg-gray-900 border border-gray-700 rounded p-1 text-[11px] text-white outline-none"
                    value={accelerator}
                    onChange={(e) => {
                      const val = e.target.value as 'auto' | 'cuda' | 'rocm' | 'vulkan' | 'intel';
                      setAccelerator(val);
                      syncRamalamaConfig({ accelerator: val });
                    }}
                  >
                    <option value="auto">Auto-Detect GPU</option>
                    <option value="cuda">NVIDIA CUDA</option>
                    <option value="rocm">AMD ROCm</option>
                    <option value="vulkan">Vulkan GPU</option>
                    <option value="intel">Intel XPU</option>
                  </select>
                </div>
              </div>

              <div className="grid grid-cols-2 gap-1.5">
                <div>
                  <label className="block text-[10px] text-gray-400 mb-0.5">Network Isolation</label>
                  <select
                    className="nodrag w-full bg-gray-900 border border-gray-700 rounded p-1 text-[11px] text-white outline-none"
                    value={networkIsolation}
                    onChange={(e) => {
                      const val = e.target.value as 'bridge' | 'none' | 'host';
                      setNetworkIsolation(val);
                      syncRamalamaConfig({ networkIsolation: val });
                    }}
                  >
                    <option value="bridge">Bridge (Standard)</option>
                    <option value="none">Airgapped (--network=none)</option>
                    <option value="host">Host Network</option>
                  </select>
                </div>
                <div>
                  <label className="block text-[10px] text-gray-400 mb-0.5">Generator Output</label>
                  <select
                    className="nodrag w-full bg-gray-900 border border-gray-700 rounded p-1 text-[11px] text-white outline-none"
                    value={generateMode}
                    onChange={(e) => {
                      const val = e.target.value as 'none' | 'quadlet' | 'kube' | 'compose';
                      setGenerateMode(val);
                      syncRamalamaConfig({ generateMode: val });
                    }}
                  >
                    <option value="quadlet">Podman Quadlet (.container)</option>
                    <option value="kube">Kubernetes Pod YAML</option>
                    <option value="compose">Docker Compose</option>
                    <option value="none">CLI Only</option>
                  </select>
                </div>
              </div>

              <div>
                <label className="block text-[10px] text-gray-400 mb-0.5">OCI RAG Data Artifact (--rag)</label>
                <input
                  className="nodrag w-full bg-gray-900 border border-gray-700 focus:border-orange-400 rounded p-1 text-[10px] text-white font-mono outline-none"
                  value={ragOciUri}
                  onChange={(e) => {
                    const val = e.target.value;
                    setRagOciUri(val);
                    syncRamalamaConfig({ ragOciUri: val });
                  }}
                  placeholder="oci://quay.io/org/docs-rag:latest"
                />
              </div>

              <div className="flex items-center justify-between gap-2 text-[10px] text-gray-300 pt-0.5">
                <label className="flex items-center gap-1 cursor-pointer">
                  <input
                    type="checkbox"
                    className="nodrag accent-orange-500 w-3 h-3"
                    checked={selinuxEnforcing}
                    onChange={(e) => {
                      setSelinuxEnforcing(e.target.checked);
                      syncRamalamaConfig({ selinuxEnforcing: e.target.checked });
                    }}
                  />
                  <span>SELinux (container_engine_t)</span>
                </label>
                <label className="flex items-center gap-1 cursor-pointer">
                  <input
                    type="checkbox"
                    className="nodrag accent-orange-500 w-3 h-3"
                    checked={tempContainer}
                    onChange={(e) => {
                      setTempContainer(e.target.checked);
                      syncRamalamaConfig({ tempContainer: e.target.checked });
                    }}
                  />
                  <span>Ephemeral (--temp)</span>
                </label>
              </div>

              <div className="bg-black/60 rounded p-1.5 border border-gray-800">
                <div className="text-[9px] text-gray-400 mb-0.5 font-mono">Launch Command:</div>
                <div className="text-[9px] text-orange-300 font-mono break-all select-all">
                  {cliCommandPreview}
                </div>
              </div>
            </div>
          )}

          {/* Active Security / RAG Badges */}
          <div className="flex flex-wrap gap-1 pt-0.5">
            {selinuxEnforcing && (
              <span className="text-[9px] bg-emerald-950/70 text-emerald-300 border border-emerald-700/50 px-1.5 py-0.2 rounded font-mono">
                🛡️ SELinux
              </span>
            )}
            {networkIsolation === 'none' && (
              <span className="text-[9px] bg-cyan-950/70 text-cyan-300 border border-cyan-700/50 px-1.5 py-0.2 rounded font-mono">
                🔒 --network=none
              </span>
            )}
            {ragOciUri.trim() && (
              <span className="text-[9px] bg-amber-950/70 text-amber-300 border border-amber-700/50 px-1.5 py-0.2 rounded font-mono truncate max-w-[180px]" title={ragOciUri}>
                📚 OCI RAG Attached
              </span>
            )}
          </div>
        </div>

        {/* Priority Slider */}
        <div>
          <div className="flex justify-between items-center mb-1">
            <label className="text-[11px] font-semibold text-gray-400">Router Priority</label>
            <span className="text-[11px] font-mono text-orange-300">{priority}</span>
          </div>
          <input
            type="range"
            min="1"
            max="50"
            step="1"
            className="nodrag w-full accent-orange-400 cursor-pointer"
            value={priority}
            onChange={handlePriorityChange}
          />
        </div>

        {/* Capabilities */}
        <div className="flex justify-between items-center bg-gray-900/60 p-2 rounded border border-gray-800">
          <label className="text-[11px] font-semibold text-gray-400">Vision Capable (Multimodal)</label>
          <input
            type="checkbox"
            className="nodrag accent-orange-500 w-3 h-3 cursor-pointer"
            checked={visionCapable}
            onChange={(e) => {
              setVisionCapable(e.target.checked);
              syncData({ visionCapable: e.target.checked });
            }}
          />
        </div>
      </div>

      <Handle type="source" position={Position.Right} className="w-3.5 h-3.5 bg-orange-500 -right-2" />
    </div>
  );
}
