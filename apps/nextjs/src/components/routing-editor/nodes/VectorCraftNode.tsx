"use client";

import { useState } from 'react';
import { Handle, Position, useReactFlow } from '@xyflow/react';
import {
  ARTCRAFT_APPS_CATALOG,
  ARTCRAFT_APP_IDS,
  buildArtCraftCliArgs,
  type ArtCraftAppId
} from '@eluvix/router-core/artcraft-mcp';

export default function VectorCraftNode({ id, data }: { id: string; data: any }) {
  const { updateNodeData } = useReactFlow();

  const initialApp: ArtCraftAppId =
    data?.app && ARTCRAFT_APPS_CATALOG[data.app as ArtCraftAppId]
      ? (data.app as ArtCraftAppId)
      : 'vectorcraft';
  const initialSpec = ARTCRAFT_APPS_CATALOG[initialApp];

  const [selectedApp, setSelectedApp] = useState<ArtCraftAppId>(initialApp);
  const [bundleMode, setBundleMode] = useState<boolean>(
    Array.isArray(data?.enabledApps) && data.enabledApps.length > 1
  );
  const [enabledApps, setEnabledApps] = useState<ArtCraftAppId[]>(
    Array.isArray(data?.enabledApps) && data.enabledApps.length > 0
      ? (data.enabledApps as ArtCraftAppId[])
      : [initialApp]
  );
  const [backendMode, setBackendMode] = useState<'auto' | 'remote' | 'headless'>(
    data?.backendMode || 'auto'
  );
  const [cliCommand, setCliCommand] = useState<string>(
    data?.cliCommand || initialSpec.cliBinary
  );
  const [controlAddress, setControlAddress] = useState<string>(
    data?.controlAddress || `127.0.0.1:${initialSpec.defaultControlPort ?? 7979}`
  );
  const [defaultPromptWorkflow, setDefaultPromptWorkflow] = useState<string>(
    data?.defaultPromptWorkflow || (initialSpec.prompts[0] ?? 'none')
  );
  const [autoApproveTier, setAutoApproveTier] = useState<
    'readonly-inspect' | 'canvas-draw' | 'workspace-edit' | 'full-automation'
  >(data?.autoApproveTier || 'canvas-draw');
  const [defaultExportFormat, setDefaultExportFormat] = useState<string>(
    data?.defaultExportFormat || initialSpec.defaultExportFormat
  );
  const [readRoot, setReadRoot] = useState<string>(
    Array.isArray(data?.readRoots) && data.readRoots.length > 0
      ? String(data.readRoots[0])
      : data?.readRoot || ''
  );
  const [writeRoot, setWriteRoot] = useState<string>(
    Array.isArray(data?.writeRoots) && data.writeRoots.length > 0
      ? String(data.writeRoots[0])
      : data?.writeRoot || ''
  );

  const spec = ARTCRAFT_APPS_CATALOG[selectedApp] || ARTCRAFT_APPS_CATALOG.vectorcraft;

  if (data) {
    if (!data.app) data.app = selectedApp;
    if (!data.enabledApps) data.enabledApps = enabledApps;
    if (!data.backendMode) data.backendMode = backendMode;
    if (!data.cliCommand) data.cliCommand = cliCommand;
    if (!data.controlAddress) data.controlAddress = controlAddress;
    if (!data.defaultPromptWorkflow) data.defaultPromptWorkflow = defaultPromptWorkflow;
    if (!data.autoApproveTier) data.autoApproveTier = autoApproveTier;
    if (!data.defaultExportFormat) data.defaultExportFormat = defaultExportFormat;
    if (data.readRoots === undefined) data.readRoots = readRoot ? [readRoot] : [];
    if (data.writeRoots === undefined) data.writeRoots = writeRoot ? [writeRoot] : [];
  }

  const syncData = (updates: Record<string, any>) => {
    if (data) Object.assign(data, updates);
    if (id) updateNodeData(id, updates);
  };

  const handleAppChange = (nextApp: ArtCraftAppId) => {
    const nextSpec = ARTCRAFT_APPS_CATALOG[nextApp];
    const nextPort = nextSpec.defaultControlPort ?? 7979;
    const nextAddr = `127.0.0.1:${nextPort}`;
    const nextFormat = nextSpec.defaultExportFormat;
    const nextPrompt = nextSpec.prompts[0] || 'none';
    const nextApps = bundleMode
      ? Array.from(new Set([nextApp, ...enabledApps]))
      : [nextApp];

    setSelectedApp(nextApp);
    setCliCommand(nextSpec.cliBinary);
    setControlAddress(nextAddr);
    setDefaultExportFormat(nextFormat);
    setDefaultPromptWorkflow(nextPrompt);
    setEnabledApps(nextApps);

    syncData({
      app: nextApp,
      enabledApps: nextApps,
      cliCommand: nextSpec.cliBinary,
      controlAddress: nextAddr,
      defaultExportFormat: nextFormat,
      defaultPromptWorkflow: nextPrompt
    });
  };

  const toggleBundledApp = (appId: ArtCraftAppId) => {
    const exists = enabledApps.includes(appId);
    const updated = exists
      ? enabledApps.filter(a => a !== appId)
      : [...enabledApps, appId];
    const safeList: ArtCraftAppId[] = updated.length > 0 ? updated : [selectedApp];
    setEnabledApps(safeList);
    syncData({ enabledApps: safeList });
  };

  const builtCli = buildArtCraftCliArgs({
    app: selectedApp,
    cliCommand,
    backendMode,
    controlAddress,
    readRoots: readRoot.trim() ? [readRoot.trim()] : [],
    writeRoots: writeRoot.trim() ? [writeRoot.trim()] : []
  });
  const cliPreview = `${builtCli.cliCommand} ${builtCli.mcpArgs.join(' ')}`;

  const remoteFlagLabel =
    spec.remoteFlagStyle === 'bridge'
      ? '--bridge'
      : spec.remoteFlagStyle === 'attach'
        ? '--attach'
        : spec.remoteFlagStyle === 'connect'
          ? '--connect'
          : 'Headless Only';

  const totalTools = spec.allTools.length;
  const readOnlyCount = spec.readOnlyTools.length;
  const toolCountLabel =
    autoApproveTier === 'readonly-inspect'
      ? `${readOnlyCount}/${totalTools} Read-Only`
      : autoApproveTier === 'full-automation'
        ? `${totalTools}/${totalTools} Full`
        : `${Math.max(1, totalTools - spec.remoteUiOnlyTools.length)}/${totalTools} Studio`;

  return (
    <div className="bg-gray-900 border-2 border-pink-500 rounded-lg p-3.5 min-w-[320px] max-w-[360px] shadow-2xl transition hover:shadow-pink-500/15">
      <Handle
        type="target"
        position={Position.Left}
        id="vectorcraft-in"
        className="w-3.5 h-3.5 bg-pink-500 -left-2 transition hover:scale-125"
        title="Agent Commands & Canvas Writes in (JSON-RPC)"
      />

      {/* Header */}
      <div className="font-bold text-pink-400 mb-2 flex items-center justify-between border-b border-gray-800 pb-2">
        <div className="flex items-center gap-1.5">
          <span>{spec.icon}</span>
          <span className="text-sm">
            {bundleMode && enabledApps.length > 1
              ? `ArtCraft Suite (${enabledApps.length} Apps)`
              : `${spec.name} MCP`}
          </span>
        </div>
        <span className="text-[10px] bg-pink-500/20 text-pink-300 px-1.5 py-0.5 rounded font-mono uppercase">
          {builtCli.effectiveMode}
        </span>
      </div>

      <div className="text-xs text-gray-300 space-y-2.5">
        {/* ArtCraft App Selector & Multi-App Bundle Toggle */}
        <div>
          <div className="flex items-center justify-between mb-1">
            <label className="block text-[10px] font-semibold text-gray-400">
              ArtCraft Studio Application (14 Apps)
            </label>
            <button
              type="button"
              onClick={() => {
                const nextBundle = !bundleMode;
                setBundleMode(nextBundle);
                if (!nextBundle) {
                  setEnabledApps([selectedApp]);
                  syncData({ enabledApps: [selectedApp] });
                }
              }}
              className={`nodrag text-[9px] px-1.5 py-0.5 rounded font-mono border transition ${
                bundleMode
                  ? 'bg-pink-600/30 border-pink-400 text-pink-200'
                  : 'bg-gray-950 border-gray-700 text-gray-400 hover:text-gray-200'
              }`}
            >
              {bundleMode ? '✓ Multi-App Bundle' : '+ Multi-App Bundle'}
            </button>
          </div>
          <select
            className="nodrag w-full bg-gray-950 border border-gray-700 focus:border-pink-500 rounded p-1.5 text-white text-[11px] outline-none transition cursor-pointer"
            value={selectedApp}
            onChange={(e) => handleAppChange(e.target.value as ArtCraftAppId)}
          >
            <optgroup label="Creative & Photo Studio">
              <option value="vectorcraft">🎨 VectorCraft — Vector Art, Bézier &amp; SVG/AI</option>
              <option value="photocraft">🖼️ PhotoCraft — Layered Raster &amp; PSD Studio</option>
              <option value="lightcraft">📸 LightCraft — RAW Darkroom &amp; Catalog</option>
            </optgroup>
            <optgroup label="Video, Motion & Audio">
              <option value="filmcraft">🎬 FilmCraft — Video NLE, Lumetri &amp; FCPXML</option>
              <option value="effectcraft">✨ EffectCraft — Keyframe VFX &amp; Compositing</option>
              <option value="soundcraft">🎵 SoundCraft — Multitrack DAW, MIDI &amp; LUFS</option>
            </optgroup>
            <optgroup label="UI/UX, Print & Presentations">
              <option value="figcraft">📐 FigCraft — UI/UX Design, Auto-Layout &amp; FigJam</option>
              <option value="designcraft">📰 DesignCraft — Multi-Page Print &amp; IDML</option>
              <option value="deckcraft">📊 DeckCraft — Slide Decks &amp; PPTX Studio</option>
            </optgroup>
            <optgroup label="Documents, PDF & Spreadsheets">
              <option value="pdfcraft">📄 PdfCraft — PDF Assembly, OCR &amp; Redaction</option>
              <option value="wordcraft">📝 WordCraft — Word Processor &amp; Tracked Changes</option>
              <option value="gridcraft">📈 GridCraft — Spreadsheet, Formulas &amp; XLSX</option>
            </optgroup>
            <optgroup label="CAD & Reverse Engineering">
              <option value="cadcraft">⚙️ CADCraft — 2D/3D Parametric CAD &amp; DXF/DWG</option>
              <option value="craft-anything">🔬 Craft Anything — 284-Tool RE &amp; Clean-Room Rebuild</option>
            </optgroup>
          </select>
          <p className="text-[9px] text-gray-400 mt-1 leading-tight">{spec.tagline}</p>
        </div>

        {/* Multi-App Bundle Pill Matrix */}
        {bundleMode && (
          <div className="bg-gray-950/90 border border-gray-800 rounded p-2">
            <div className="flex items-center justify-between mb-1.5">
              <span className="text-[9px] font-semibold text-pink-300 uppercase">
                Bundled MCP Servers ({enabledApps.length}/14)
              </span>
              <button
                type="button"
                onClick={() => {
                  const next =
                    enabledApps.length === ARTCRAFT_APP_IDS.length
                      ? [selectedApp]
                      : [...ARTCRAFT_APP_IDS];
                  setEnabledApps(next);
                  syncData({ enabledApps: next });
                }}
                className="nodrag text-[9px] text-pink-400 hover:underline font-mono"
              >
                {enabledApps.length === ARTCRAFT_APP_IDS.length ? 'Reset' : 'Select All 14'}
              </button>
            </div>
            <div className="flex flex-wrap gap-1">
              {ARTCRAFT_APP_IDS.map((appId) => {
                const item = ARTCRAFT_APPS_CATALOG[appId];
                const active = enabledApps.includes(appId);
                return (
                  <button
                    key={appId}
                    type="button"
                    onClick={() => toggleBundledApp(appId)}
                    className={`nodrag text-[9px] px-1.5 py-0.5 rounded font-mono border transition ${
                      active
                        ? 'bg-pink-500/25 border-pink-500 text-pink-200'
                        : 'bg-gray-900 border-gray-800 text-gray-500 hover:text-gray-300'
                    }`}
                  >
                    {item.icon} {item.name}
                  </button>
                );
              })}
            </div>
          </div>
        )}

        {/* Backend Mode & Export Format */}
        <div className="grid grid-cols-2 gap-2">
          <div>
            <label className="block text-[10px] font-semibold text-gray-400 mb-1">
              Backend Mode
            </label>
            <select
              className="nodrag w-full bg-gray-950 border border-gray-700 focus:border-pink-500 rounded p-1.5 text-white text-[11px] outline-none transition cursor-pointer"
              value={backendMode}
              onChange={(e) => {
                const val = e.target.value as 'auto' | 'remote' | 'headless';
                setBackendMode(val);
                syncData({ backendMode: val });
              }}
            >
              <option value="auto">⚡ Auto (GUI → CPU)</option>
              {spec.remoteFlagStyle !== 'none' && (
                <option value="remote">🖥️ Remote ({remoteFlagLabel})</option>
              )}
              <option value="headless">⚙️ Headless Stdio</option>
            </select>
          </div>
          <div>
            <label className="block text-[10px] font-semibold text-gray-400 mb-1">
              Export Format
            </label>
            <select
              className="nodrag w-full bg-gray-950 border border-gray-700 focus:border-pink-500 rounded p-1.5 text-white font-mono text-[11px] outline-none transition cursor-pointer"
              value={defaultExportFormat}
              onChange={(e) => {
                const val = e.target.value;
                setDefaultExportFormat(val);
                syncData({ defaultExportFormat: val });
              }}
            >
              {spec.exportFormats.map((fmt) => (
                <option key={fmt} value={fmt}>
                  .{fmt.toUpperCase()}
                </option>
              ))}
            </select>
          </div>
        </div>

        {/* Workflow Prompt & Auto-Approve Tier */}
        <div className="grid grid-cols-2 gap-2">
          <div>
            <label className="block text-[10px] font-semibold text-gray-400 mb-1">
              MCP Workflow Preset
            </label>
            <select
              className="nodrag w-full bg-gray-950 border border-gray-700 focus:border-pink-500 rounded p-1.5 text-white text-[11px] outline-none transition cursor-pointer"
              value={defaultPromptWorkflow}
              onChange={(e) => {
                const val = e.target.value;
                setDefaultPromptWorkflow(val);
                syncData({ defaultPromptWorkflow: val });
              }}
            >
              {spec.prompts.map((p) => (
                <option key={p} value={p}>
                  ✨ {p}
                </option>
              ))}
              <option value="none">None (Raw MCP Tools)</option>
            </select>
          </div>
          <div>
            <label className="block text-[10px] font-semibold text-gray-400 mb-1">
              Tool Approval Tier
            </label>
            <select
              className="nodrag w-full bg-gray-950 border border-gray-700 focus:border-pink-500 rounded p-1.5 text-white text-[11px] outline-none transition cursor-pointer"
              value={autoApproveTier}
              onChange={(e) => {
                const val = e.target.value as any;
                setAutoApproveTier(val);
                syncData({ autoApproveTier: val });
              }}
            >
              <option value="canvas-draw">✏️ Studio &amp; Batch</option>
              <option value="readonly-inspect">🔍 Read-Only Inspect</option>
              <option value="full-automation">🚀 Full + Export</option>
            </select>
          </div>
        </div>

        {/* CLI Binary & Control Address */}
        <div className="grid grid-cols-2 gap-2">
          <div>
            <label className="block text-[10px] font-semibold text-gray-400 mb-1">
              CLI Binary
            </label>
            <input
              className="nodrag w-full bg-gray-950 border border-gray-700 focus:border-pink-500 rounded p-1.5 text-white font-mono text-[10px] outline-none transition"
              value={cliCommand}
              onChange={(e) => {
                const val = e.target.value;
                setCliCommand(val);
                syncData({ cliCommand: val });
              }}
              placeholder={spec.cliBinary}
            />
          </div>
          <div>
            <label className="block text-[10px] font-semibold text-gray-400 mb-1">
              Control ({remoteFlagLabel})
            </label>
            <input
              className="nodrag w-full bg-gray-950 border border-gray-700 focus:border-pink-500 rounded p-1.5 text-white font-mono text-[10px] outline-none transition"
              value={controlAddress}
              onChange={(e) => {
                const val = e.target.value;
                setControlAddress(val);
                syncData({ controlAddress: val });
              }}
              disabled={spec.remoteFlagStyle === 'none'}
              placeholder={
                spec.defaultControlPort ? `127.0.0.1:${spec.defaultControlPort}` : 'stdio-only'
              }
            />
          </div>
        </div>

        {/* File Confinement Roots */}
        {spec.supportsAutomationRoots && (
          <div className="grid grid-cols-2 gap-2">
            <div>
              <label className="block text-[10px] font-semibold text-gray-400 mb-1">
                Read Root (Optional)
              </label>
              <input
                className="nodrag w-full bg-gray-950 border border-gray-700 focus:border-pink-500 rounded p-1.5 text-white font-mono text-[10px] outline-none transition"
                value={readRoot}
                onChange={(e) => {
                  const val = e.target.value;
                  setReadRoot(val);
                  syncData({
                    readRoot: val,
                    readRoots: val.trim() ? [val.trim()] : []
                  });
                }}
                placeholder="/workspace/assets"
              />
            </div>
            <div>
              <label className="block text-[10px] font-semibold text-gray-400 mb-1">
                Write Root (Optional)
              </label>
              <input
                className="nodrag w-full bg-gray-950 border border-gray-700 focus:border-pink-500 rounded p-1.5 text-white font-mono text-[10px] outline-none transition"
                value={writeRoot}
                onChange={(e) => {
                  const val = e.target.value;
                  setWriteRoot(val);
                  syncData({
                    writeRoot: val,
                    writeRoots: val.trim() ? [val.trim()] : []
                  });
                }}
                placeholder="/workspace/exports"
              />
            </div>
          </div>
        )}

        {/* Live CLI Preview & Telemetry Strip */}
        <div className="pt-2 border-t border-gray-800 space-y-1.5">
          <div
            className="bg-gray-950 px-2 py-1 rounded border border-gray-800 font-mono text-[9px] text-pink-300 truncate"
            title={cliPreview}
          >
            $ {cliPreview}
          </div>
          <div className="grid grid-cols-4 gap-1 text-[9px] font-mono text-gray-400">
            <div className="bg-gray-950 px-1 py-1 rounded border border-gray-800 text-center" title="Active MCP Tools">
              🛠️ {toolCountLabel}
            </div>
            <div className="bg-gray-950 px-1 py-1 rounded border border-gray-800 text-center" title="Connection Mode">
              🔌 {spec.defaultControlPort ? `:${spec.defaultControlPort}` : 'stdio'}
            </div>
            <div className="bg-gray-950 px-1 py-1 rounded border border-gray-800 text-center" title="Export File Format">
              📦 .{defaultExportFormat}
            </div>
            <div className="bg-pink-950/40 text-pink-300 px-1 py-1 rounded border border-pink-900/60 text-center" title="Bi-directional MCP: Read state & Write shapes/files">
              ↔️ R/W
            </div>
          </div>
        </div>
      </div>

      <Handle
        type="source"
        position={Position.Right}
        id="vectorcraft-out"
        className="w-3.5 h-3.5 bg-pink-500 -right-2 transition hover:scale-125"
        title="MCP Tool Exposure & Canvas State out"
      />
    </div>
  );
}
