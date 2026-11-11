"use client";

import { useState, useEffect, useCallback, useRef } from 'react';
import NodeHealthIndicator from '../NodeHealthIndicator';
import { Handle, Position, useReactFlow } from '@xyflow/react';

interface DiscoveredModel {
  id: string;
  name?: string;
  recipe?: string;
  ownedBy?: string;
  labels?: string[];
}

type WorkflowPreset =
  | 'flux-txt2img'
  | 'sdxl-txt2img'
  | 'wan21-txt2vid'
  | 'hunyuan3d-mesh'
  | 'custom-json';

type VramMode =
  | 'normalvram'
  | 'highvram'
  | 'gpu-only'
  | 'lowvram'
  | 'novram'
  | 'cpu';

const PRESET_LABELS: Record<WorkflowPreset, string> = {
  'flux-txt2img': 'Flux.1 Dev / Schnell (Txt2Img)',
  'sdxl-txt2img': 'SDXL 1.0 / Lightning (Txt2Img)',
  'wan21-txt2vid': 'Wan 2.1 / LTX-Video (Txt2Vid)',
  'hunyuan3d-mesh': 'Hunyuan3D 2.0 (3D Mesh GLB)',
  'custom-json': 'Custom ComfyUI API Workflow JSON',
};

export default function ComfyUINode({ id, data }: { id: string; data: any }) {
  const { updateNodeData } = useReactFlow();
  const [endpoint, setEndpoint] = useState<string>(data?.endpoint || 'http://localhost:8188');
  const [priority, setPriority] = useState<number>(data?.priority ?? 22);
  const [selectedModel, setSelectedModel] = useState<string>(
    data?.selectedModel || data?.comfyui?.checkpoint || '*'
  );
  const [models, setModels] = useState<string[]>(data?.models || []);
  const [details, setDetails] = useState<DiscoveredModel[]>(data?.modelDetails || []);
  const [status, setStatus] = useState<'idle' | 'checking' | 'online' | 'cached' | 'offline'>('idle');
  const [queueRunning, setQueueRunning] = useState<number>(0);
  const [queuePending, setQueuePending] = useState<number>(0);
  const [vramFreeGb, setVramFreeGb] = useState<number | null>(null);
  const [vramTotalGb, setVramTotalGb] = useState<number | null>(null);
  const [expanded, setExpanded] = useState<boolean>(false);
  const [showDagConfig, setShowDagConfig] = useState<boolean>(false);

  const [workflowPreset, setWorkflowPreset] = useState<WorkflowPreset>(
    data?.comfyui?.workflowPreset || 'flux-txt2img'
  );
  const [steps, setSteps] = useState<number>(data?.comfyui?.steps ?? 20);
  const [cfg, setCfg] = useState<number>(data?.comfyui?.cfg ?? 3.5);
  const [samplerName, setSamplerName] = useState<string>(
    data?.comfyui?.samplerName || 'euler'
  );
  const [scheduler, setScheduler] = useState<string>(
    data?.comfyui?.scheduler || 'simple'
  );
  const [width, setWidth] = useState<number>(data?.comfyui?.width ?? 1024);
  const [height, setHeight] = useState<number>(data?.comfyui?.height ?? 1024);
  const [vramMode, setVramMode] = useState<VramMode>(
    data?.comfyui?.vramMode || 'normalvram'
  );
  const [reserveVramGb, setReserveVramGb] = useState<number>(
    data?.comfyui?.reserveVramGb ?? 4
  );
  const [postProcessArtCraftApp, setPostProcessArtCraftApp] = useState<string>(
    data?.comfyui?.postProcessArtCraftApp || ''
  );
  const [loopbackEluvixUrl, setLoopbackEluvixUrl] = useState<string>(
    data?.comfyui?.loopbackEluvixUrl || 'http://127.0.0.1:3588/v1'
  );
  const [mcpEnabled, setMcpEnabled] = useState<boolean>(
    data?.comfyui?.mcpEnabled ?? true
  );

  const dataRef = useRef(data);
  dataRef.current = data;

  useEffect(() => {
    if (!data) return;
    setEndpoint(data.endpoint || 'http://localhost:8188');
    setPriority(data.priority ?? 22);
    setSelectedModel(data.selectedModel || data.comfyui?.checkpoint || '*');
    if (Array.isArray(data.models)) setModels(data.models);
    if (Array.isArray(data.modelDetails)) setDetails(data.modelDetails);
    if (data.comfyui) {
      setWorkflowPreset(data.comfyui.workflowPreset || 'flux-txt2img');
      setSteps(data.comfyui.steps ?? 20);
      setCfg(data.comfyui.cfg ?? 3.5);
      setSamplerName(data.comfyui.samplerName || 'euler');
      setScheduler(data.comfyui.scheduler || 'simple');
      setWidth(data.comfyui.width ?? 1024);
      setHeight(data.comfyui.height ?? 1024);
      setVramMode(data.comfyui.vramMode || 'normalvram');
      setReserveVramGb(data.comfyui.reserveVramGb ?? 4);
      setPostProcessArtCraftApp(data.comfyui.postProcessArtCraftApp || '');
      setLoopbackEluvixUrl(data.comfyui.loopbackEluvixUrl || 'http://127.0.0.1:3588/v1');
      setMcpEnabled(data.comfyui.mcpEnabled ?? true);
    }
  }, [data]);

  const syncData = useCallback(
    (patch: Record<string, any>) => {
      updateNodeData(id, patch);
      if (typeof dataRef.current?.onChange === 'function') {
        dataRef.current.onChange(id, { ...dataRef.current, ...patch });
      }
    },
    [id, updateNodeData]
  );

  const syncComfyConfig = useCallback(
    (comfyPatch: Record<string, any>) => {
      const nextComfy = {
        workflowPreset,
        checkpoint: selectedModel !== '*' ? selectedModel : undefined,
        steps,
        cfg,
        samplerName,
        scheduler,
        width,
        height,
        vramMode,
        reserveVramGb,
        postProcessArtCraftApp: postProcessArtCraftApp || undefined,
        loopbackEluvixUrl,
        mcpEnabled,
        ...(dataRef.current?.comfyui || {}),
        ...comfyPatch,
      };
      syncData({ comfyui: nextComfy });
    },
    [
      workflowPreset,
      selectedModel,
      steps,
      cfg,
      samplerName,
      scheduler,
      width,
      height,
      vramMode,
      reserveVramGb,
      postProcessArtCraftApp,
      loopbackEluvixUrl,
      mcpEnabled,
      syncData,
    ]
  );

  const probeModels = useCallback(
    async (targetEndpoint: string) => {
      if (!targetEndpoint) return;
      setStatus('checking');
      try {
        const [res, statusRes] = await Promise.all([
          fetch('/api/v1/detect-models', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              endpoint: targetEndpoint,
              type: 'comfyui',
            }),
          }),
          fetch(`/api/v1/comfyui/status?endpoint=${encodeURIComponent(targetEndpoint)}`).catch(
            () => null
          ),
        ]);

        let systemOnline = false;
        if (statusRes && statusRes.ok) {
          try {
            const sysJson = await statusRes.json();
            if (sysJson?.online) {
              systemOnline = true;
              setQueueRunning(Number(sysJson.queueRunning ?? 0));
              setQueuePending(Number(sysJson.queuePending ?? 0));
              setVramFreeGb(
                typeof sysJson.vramFreeGb === 'number' ? sysJson.vramFreeGb : null
              );
              setVramTotalGb(
                typeof sysJson.vramTotalGb === 'number' ? sysJson.vramTotalGb : null
              );
            } else {
              setVramFreeGb(null);
              setVramTotalGb(null);
            }
          } catch {
            // Non-fatal telemetry parse error
          }
        }

        if (!res.ok) {
          setStatus(systemOnline ? 'online' : 'offline');
          return;
        }
        const json = await res.json();
        const discovered: string[] = Array.isArray(json.models) ? json.models : [];
        const discoveredDetails: DiscoveredModel[] = Array.isArray(json.details)
          ? json.details
          : [];
        if (discovered.length > 0) {
          setModels(discovered);
          setDetails(discoveredDetails);
          setStatus(json.cached && !systemOnline ? 'cached' : 'online');
          syncData({
            endpoint: targetEndpoint,
            models: discovered,
            modelDetails: discoveredDetails,
          });
        } else {
          setStatus(systemOnline ? 'online' : 'offline');
        }
      } catch {
        setStatus('offline');
      }
    },
    [syncData]
  );

  useEffect(() => {
    const timer = setTimeout(() => {
      probeModels(endpoint);
    }, 350);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleModelSelect = (modelId: string) => {
    setSelectedModel(modelId);
    const activeModels =
      modelId === '*'
        ? models.length > 0
          ? models
          : ['*']
        : [modelId, ...models.filter((m) => m !== modelId)];
    syncData({
      selectedModel: modelId,
      models: activeModels,
      comfyui: {
        ...(dataRef.current?.comfyui || {}),
        workflowPreset,
        checkpoint: modelId !== '*' ? modelId : undefined,
      },
    });
  };

  let portNum = '8188';
  try {
    const parsed = new URL(endpoint);
    if (parsed.port) portNum = parsed.port;
  } catch {
    // default 8188
  }

  const reserveFlag = reserveVramGb > 0 ? ` --reserve-vram ${reserveVramGb}` : '';
  const cliCommandPreview = `python main.py --listen 127.0.0.1 --port ${portNum} --${vramMode}${reserveFlag}`;

  return (
    <div className="bg-fuchsia-950/85 border-2 border-fuchsia-500/80 rounded-lg p-4 shadow-xl w-80 text-white backdrop-blur-sm relative">
      <Handle
        type="target"
        position={Position.Left}
        className="w-3.5 h-3.5 bg-fuchsia-400 -left-2"
      />
      <NodeHealthIndicator serviceName="comfyui" liveTelemetry={data?.liveTelemetry} />

      <div className="flex items-center justify-between border-b border-fuchsia-800/70 pb-2 mb-3 pr-14">
        <div className="flex items-center space-x-2">
          <span className="text-xl" role="img" aria-label="ComfyUI">
            🎬
          </span>
          <div>
            <div className="font-bold text-sm text-fuchsia-200">ComfyUI Engine</div>
            <div className="text-[10px] text-fuchsia-300/80 font-mono">
              Diffusion &amp; Media DAG · :{portNum}
            </div>
          </div>
        </div>
        <span
          className={`text-[10px] px-1.5 py-0.5 rounded font-mono uppercase ${
            status === 'online'
              ? 'bg-emerald-900/70 text-emerald-300 border border-emerald-600/50'
              : status === 'cached'
              ? 'bg-amber-900/70 text-amber-300 border border-amber-600/50'
              : status === 'checking'
              ? 'bg-fuchsia-900/70 text-fuchsia-200 animate-pulse'
              : 'bg-gray-800 text-gray-400'
          }`}
        >
          {status === 'online'
            ? `${models.length} ckpts`
            : status === 'cached'
            ? `${models.length} cached`
            : status === 'checking'
            ? 'probing...'
            : 'local'}
        </span>
      </div>

      <div className="space-y-2.5 text-xs">
        {/* Server Endpoint */}
        <div>
          <label className="text-gray-400 block mb-1 text-[11px] font-semibold">
            ComfyUI HTTP API Endpoint
          </label>
          <div className="flex gap-1.5">
            <input
              type="text"
              className="nodrag flex-1 bg-gray-950 border border-gray-800 rounded p-1.5 text-white font-mono text-[11px] focus:outline-none focus:border-fuchsia-400 transition-colors"
              value={endpoint}
              onChange={(e) => {
                setEndpoint(e.target.value);
                syncData({ endpoint: e.target.value });
              }}
              placeholder="http://localhost:8188"
            />
            <button
              type="button"
              onClick={() => probeModels(endpoint)}
              className="nodrag px-2 py-1 bg-fuchsia-900/60 hover:bg-fuchsia-800/80 border border-fuchsia-600/50 rounded text-[11px] text-fuchsia-200 transition-colors"
              title="Query ComfyUI /models/checkpoints and /models/diffusion_models"
            >
              ↻
            </button>
          </div>
        </div>

        {/* Workflow Preset */}
        <div>
          <label className="text-gray-400 block mb-1 text-[11px] font-semibold">
            Workflow DAG Preset
          </label>
          <select
            className="nodrag w-full bg-gray-950 border border-gray-800 rounded p-1.5 text-fuchsia-200 font-mono text-[11px] focus:outline-none focus:border-fuchsia-400"
            value={workflowPreset}
            onChange={(e) => {
              const nextPreset = e.target.value as WorkflowPreset;
              setWorkflowPreset(nextPreset);
              syncComfyConfig({ workflowPreset: nextPreset });
            }}
          >
            {(Object.keys(PRESET_LABELS) as WorkflowPreset[]).map((presetKey) => (
              <option key={presetKey} value={presetKey}>
                {PRESET_LABELS[presetKey]}
              </option>
            ))}
          </select>
        </div>

        {/* Checkpoint / UNet Selector */}
        <div>
          <div className="flex justify-between items-center mb-1">
            <label className="text-gray-400 text-[11px] font-semibold">
              Checkpoint / Diffusion Model
            </label>
            {details.length > 0 && (
              <button
                type="button"
                onClick={() => setExpanded((v) => !v)}
                className="nodrag text-[10px] text-fuchsia-300 hover:text-fuchsia-200 underline"
              >
                {expanded ? 'Hide catalog' : `Inspect (${details.length})`}
              </button>
            )}
          </div>
          <select
            className="nodrag w-full bg-gray-950 border border-gray-800 rounded p-1.5 text-fuchsia-200 font-mono text-[11px] focus:outline-none focus:border-fuchsia-400"
            value={selectedModel}
            onChange={(e) => handleModelSelect(e.target.value)}
          >
            <option value="*">
              {models.length > 0
                ? `Auto / Preset Default (${models.length} discovered)`
                : 'Auto / Preset Default (*)'}
            </option>
            {models.map((m) => (
              <option key={m} value={m}>
                {m}
              </option>
            ))}
          </select>
        </div>

        {/* Expandable Discovered Checkpoint Catalog */}
        {expanded && details.length > 0 && (
          <div className="nodrag max-h-32 overflow-y-auto bg-gray-950/90 border border-fuchsia-900/60 rounded p-1.5 space-y-1">
            {details.map((d) => {
              const isSelected = selectedModel === d.id;
              return (
                <button
                  key={d.id}
                  type="button"
                  onClick={() => handleModelSelect(d.id)}
                  className={`w-full text-left p-1.5 rounded border transition-colors flex flex-col gap-0.5 ${
                    isSelected
                      ? 'bg-fuchsia-900/50 border-fuchsia-500/70'
                      : 'bg-gray-900/60 border-gray-800 hover:border-fuchsia-700/50'
                  }`}
                >
                  <div className="flex items-center justify-between gap-1">
                    <span className="font-mono text-[11px] text-fuchsia-200 truncate">
                      {d.id}
                    </span>
                    {d.recipe && (
                      <span className="text-[9px] px-1 py-0.2 rounded bg-fuchsia-950 text-fuchsia-300 border border-fuchsia-700/40 font-mono shrink-0">
                        {d.recipe}
                      </span>
                    )}
                  </div>
                </button>
              );
            })}
          </div>
        )}

        {/* Diffusion Sampler, GPU VRAM Coordinator & Loopback Drawer */}
        <div className="bg-gray-950/80 border border-fuchsia-900/50 rounded p-2 space-y-2">
          <div className="flex items-center justify-between">
            <span className="text-[11px] font-semibold text-fuchsia-300 flex items-center gap-1">
              <span>🎛️</span> Sampler, VRAM &amp; Loopback
            </span>
            <button
              type="button"
              onClick={() => setShowDagConfig((v) => !v)}
              className="nodrag text-[10px] text-fuchsia-400 hover:text-fuchsia-200 font-mono"
            >
              {showDagConfig ? '▾ Collapse' : '▸ Configure'}
            </button>
          </div>

          <div className="grid grid-cols-2 gap-1.5">
            <div>
              <label className="text-[10px] text-gray-400 block mb-0.5">Sampler</label>
              <select
                className="nodrag w-full bg-gray-900 border border-gray-800 rounded p-1 text-[10px] font-mono text-fuchsia-200"
                value={samplerName}
                onChange={(e) => {
                  setSamplerName(e.target.value);
                  syncComfyConfig({ samplerName: e.target.value });
                }}
              >
                <option value="euler">euler</option>
                <option value="euler_ancestral">euler_ancestral</option>
                <option value="dpmpp_2m">dpmpp_2m</option>
                <option value="dpmpp_2m_sde">dpmpp_2m_sde</option>
                <option value="uni_pc">uni_pc</option>
                <option value="heun">heun</option>
              </select>
            </div>
            <div>
              <label className="text-[10px] text-gray-400 block mb-0.5">VRAM Policy</label>
              <select
                className="nodrag w-full bg-gray-900 border border-gray-800 rounded p-1 text-[10px] font-mono text-fuchsia-200"
                value={vramMode}
                onChange={(e) => {
                  const val = e.target.value as VramMode;
                  setVramMode(val);
                  syncComfyConfig({ vramMode: val });
                }}
              >
                <option value="normalvram">--normalvram (Shared)</option>
                <option value="lowvram">--lowvram (LLM Co-host)</option>
                <option value="highvram">--highvram (Dedicated)</option>
                <option value="gpu-only">--gpu-only</option>
                <option value="cpu">--cpu</option>
              </select>
            </div>
          </div>

          {showDagConfig && (
            <div className="space-y-2 pt-1 border-t border-gray-800/80">
              <div className="grid grid-cols-3 gap-1.5">
                <div>
                  <label className="text-[10px] text-gray-400 block mb-0.5">Steps</label>
                  <input
                    type="number"
                    min={1}
                    max={100}
                    className="nodrag w-full bg-gray-900 border border-gray-800 rounded p-1 text-[10px] font-mono text-white"
                    value={steps}
                    onChange={(e) => {
                      const v = Math.max(1, Math.min(100, Number(e.target.value) || 20));
                      setSteps(v);
                      syncComfyConfig({ steps: v });
                    }}
                  />
                </div>
                <div>
                  <label className="text-[10px] text-gray-400 block mb-0.5">CFG</label>
                  <input
                    type="number"
                    step={0.5}
                    min={1}
                    max={30}
                    className="nodrag w-full bg-gray-900 border border-gray-800 rounded p-1 text-[10px] font-mono text-white"
                    value={cfg}
                    onChange={(e) => {
                      const v = Math.max(1, Math.min(30, Number(e.target.value) || 3.5));
                      setCfg(v);
                      syncComfyConfig({ cfg: v });
                    }}
                  />
                </div>
                <div>
                  <label className="text-[10px] text-gray-400 block mb-0.5">Scheduler</label>
                  <select
                    className="nodrag w-full bg-gray-900 border border-gray-800 rounded p-1 text-[10px] font-mono text-fuchsia-200"
                    value={scheduler}
                    onChange={(e) => {
                      setScheduler(e.target.value);
                      syncComfyConfig({ scheduler: e.target.value });
                    }}
                  >
                    <option value="simple">simple</option>
                    <option value="normal">normal</option>
                    <option value="karras">karras</option>
                    <option value="sgm_uniform">sgm_uniform</option>
                  </select>
                </div>
              </div>

              <div className="grid grid-cols-2 gap-1.5">
                <div>
                  <label className="text-[10px] text-gray-400 block mb-0.5">Resolution</label>
                  <select
                    className="nodrag w-full bg-gray-900 border border-gray-800 rounded p-1 text-[10px] font-mono text-fuchsia-200"
                    value={`${width}x${height}`}
                    onChange={(e) => {
                      const [w, h] = e.target.value.split('x').map(Number);
                      setWidth(w);
                      setHeight(h);
                      syncComfyConfig({ width: w, height: h });
                    }}
                  >
                    <option value="1024x1024">1024×1024 (1:1)</option>
                    <option value="1344x768">1344×768 (16:9)</option>
                    <option value="768x1344">768×1344 (9:16)</option>
                    <option value="832x480">832×480 (Wan Video)</option>
                    <option value="512x512">512×512 (Fast)</option>
                  </select>
                </div>
                <div>
                  <label className="text-[10px] text-gray-400 block mb-0.5">
                    Reserve VRAM (GB)
                  </label>
                  <input
                    type="number"
                    min={0}
                    max={64}
                    className="nodrag w-full bg-gray-900 border border-gray-800 rounded p-1 text-[10px] font-mono text-white"
                    value={reserveVramGb}
                    onChange={(e) => {
                      const v = Math.max(0, Math.min(64, Number(e.target.value) || 0));
                      setReserveVramGb(v);
                      syncComfyConfig({ reserveVramGb: v });
                    }}
                  />
                </div>
              </div>

              <div>
                <label className="text-[10px] text-gray-400 block mb-0.5">
                  ArtCraft Suite Post-Process Handoff (Pillar 3)
                </label>
                <select
                  className="nodrag w-full bg-gray-900 border border-gray-800 rounded p-1 text-[10px] font-mono text-fuchsia-200"
                  value={postProcessArtCraftApp}
                  onChange={(e) => {
                    setPostProcessArtCraftApp(e.target.value);
                    syncComfyConfig({
                      postProcessArtCraftApp: e.target.value || undefined,
                    });
                  }}
                >
                  <option value="">None (Direct /view Output)</option>
                  <option value="vectorcraft">VectorCraft (SVG Vectorization)</option>
                  <option value="photocraft">PhotoCraft (Layer Compositing &amp; Retouch)</option>
                  <option value="filmcraft">FilmCraft (NLE Timeline &amp; Color Grade)</option>
                </select>
              </div>

              <div>
                <label className="text-[10px] text-gray-400 block mb-0.5">
                  Eluvix Reverse Loopback for ComfyUI LLM Nodes (Pillar 4)
                </label>
                <input
                  type="text"
                  className="nodrag w-full bg-gray-900 border border-gray-800 rounded p-1 text-[10px] font-mono text-white"
                  value={loopbackEluvixUrl}
                  onChange={(e) => {
                    setLoopbackEluvixUrl(e.target.value);
                    syncComfyConfig({ loopbackEluvixUrl: e.target.value });
                  }}
                  placeholder="http://127.0.0.1:3588/v1"
                />
              </div>

              <label className="flex items-center gap-1.5 text-[10px] text-gray-300 cursor-pointer">
                <input
                  type="checkbox"
                  className="nodrag accent-fuchsia-500 w-3 h-3"
                  checked={mcpEnabled}
                  onChange={(e) => {
                    setMcpEnabled(e.target.checked);
                    syncComfyConfig({ mcpEnabled: e.target.checked });
                  }}
                />
                <span>Expose comfyui-mcp to Connected Agent Harnesses</span>
              </label>

              <div className="bg-black/60 rounded p-1.5 border border-gray-800">
                <div className="text-[9px] text-gray-400 mb-0.5 font-mono">Launch Command:</div>
                <div className="text-[9px] text-fuchsia-300 font-mono break-all select-all">
                  {cliCommandPreview}
                </div>
              </div>
            </div>
          )}

          {/* Active Pillar Badges */}
          <div className="flex flex-wrap gap-1 pt-0.5">
            <span className="text-[9px] bg-fuchsia-950/80 text-fuchsia-300 border border-fuchsia-700/50 px-1.5 py-0.2 rounded font-mono">
              🖼️ /v1/images
            </span>
            {status === 'online' && (
              <span
                className="text-[9px] bg-emerald-950/80 text-emerald-300 border border-emerald-700/50 px-1.5 py-0.2 rounded font-mono"
                title="Live ComfyUI Queue (Running / Pending)"
              >
                ⏳ Q {queueRunning}/{queuePending}
              </span>
            )}
            {vramFreeGb !== null && (
              <span
                className="text-[9px] bg-sky-950/80 text-sky-300 border border-sky-700/50 px-1.5 py-0.2 rounded font-mono"
                title={
                  vramTotalGb !== null
                    ? `Free GPU VRAM: ${vramFreeGb} GB / ${vramTotalGb} GB`
                    : `Free GPU VRAM: ${vramFreeGb} GB`
                }
              >
                💾 {vramFreeGb}G free
              </span>
            )}
            {reserveVramGb > 0 && (
              <span className="text-[9px] bg-cyan-950/70 text-cyan-300 border border-cyan-700/50 px-1.5 py-0.2 rounded font-mono">
                ⚡ --reserve-vram {reserveVramGb}G
              </span>
            )}
            {postProcessArtCraftApp && (
              <span className="text-[9px] bg-amber-950/70 text-amber-300 border border-amber-700/50 px-1.5 py-0.2 rounded font-mono">
                🎨 → {postProcessArtCraftApp}
              </span>
            )}
            {data?.comfyui?.promptEnhancerUpstreamId && (
              <span className="text-[9px] bg-emerald-950/70 text-emerald-300 border border-emerald-700/50 px-1.5 py-0.2 rounded font-mono">
                🧠 LLM Prompt Enhancer
              </span>
            )}
          </div>
        </div>

        {/* Priority Slider */}
        <div>
          <div className="flex justify-between items-center mb-1">
            <label className="text-[11px] font-semibold text-gray-400">Router Priority</label>
            <span className="text-[11px] font-mono text-fuchsia-300">{priority}</span>
          </div>
          <input
            type="range"
            min="1"
            max="50"
            step="1"
            className="nodrag w-full accent-fuchsia-400 cursor-pointer"
            value={priority}
            onChange={(e) => {
              const val = parseInt(e.target.value, 10);
              setPriority(val);
              syncData({ priority: val });
            }}
          />
        </div>
      </div>

      <Handle
        type="source"
        position={Position.Right}
        className="w-3.5 h-3.5 bg-fuchsia-400 -right-2"
      />
    </div>
  );
}
