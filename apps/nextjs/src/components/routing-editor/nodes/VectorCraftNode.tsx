"use client";

import { useState } from 'react';
import { Handle, Position, useReactFlow } from '@xyflow/react';

export default function VectorCraftNode({ id, data }: { id: string; data: any }) {
  const { updateNodeData } = useReactFlow();

  const [backendMode, setBackendMode] = useState<'auto' | 'remote' | 'headless'>(
    data?.backendMode || 'auto'
  );
  const [cliCommand, setCliCommand] = useState<string>(data?.cliCommand || 'vectorcraft-cli');
  const [controlAddress, setControlAddress] = useState<string>(
    data?.controlAddress || '127.0.0.1:7979'
  );
  const [defaultPromptWorkflow, setDefaultPromptWorkflow] = useState<
    'none' | 'poster' | 'icon-set' | 'recolor' | 'trace-and-style' | 'export-set'
  >(data?.defaultPromptWorkflow || 'poster');
  const [autoApproveTier, setAutoApproveTier] = useState<
    'readonly-inspect' | 'canvas-draw' | 'full-automation'
  >(data?.autoApproveTier || 'canvas-draw');
  const [defaultExportFormat, setDefaultExportFormat] = useState<string>(
    data?.defaultExportFormat || 'svg'
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

  if (data) {
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

  const hasRoots = Boolean(readRoot.trim() || writeRoot.trim());
  const effectiveMode =
    backendMode === 'remote'
      ? 'remote'
      : backendMode === 'headless' || hasRoots
        ? 'headless'
        : 'auto';

  const cliPreviewParts = [cliCommand || 'vectorcraft-cli', 'mcp'];
  if (effectiveMode === 'remote') {
    cliPreviewParts.push('--connect', controlAddress || '127.0.0.1:7979');
  } else {
    if (backendMode === 'headless') cliPreviewParts.push('--headless');
    if (readRoot.trim()) cliPreviewParts.push('--automation-read-root', readRoot.trim());
    if (writeRoot.trim()) cliPreviewParts.push('--automation-write-root', writeRoot.trim());
  }
  const cliPreview = cliPreviewParts.join(' ');

  const toolCountLabel =
    autoApproveTier === 'readonly-inspect'
      ? effectiveMode === 'headless'
        ? '5/8 Read-Only'
        : '8/8 Read-Only'
      : autoApproveTier === 'canvas-draw'
        ? effectiveMode === 'headless'
          ? '21/27 Canvas'
          : '24/33 Canvas'
        : effectiveMode === 'headless'
          ? '27/27 Headless'
          : '33/33 Full';

  return (
    <div className="bg-gray-900 border-2 border-pink-500 rounded-lg p-3.5 min-w-[310px] max-w-[350px] shadow-2xl transition hover:shadow-pink-500/15">
      <Handle
        type="target"
        position={Position.Left}
        className="w-3.5 h-3.5 bg-pink-500 -left-2"
      />

      {/* Header */}
      <div className="font-bold text-pink-400 mb-2 flex items-center justify-between border-b border-gray-800 pb-2">
        <div className="flex items-center gap-1.5">
          <span>🎨</span>
          <span className="text-sm">VectorCraft Art MCP</span>
        </div>
        <span className="text-[10px] bg-pink-500/20 text-pink-300 px-1.5 py-0.5 rounded font-mono uppercase">
          {effectiveMode}
        </span>
      </div>

      <div className="text-xs text-gray-300 space-y-2.5">
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
              <option value="remote">🖥️ Remote (--connect)</option>
              <option value="headless">⚙️ Headless (--headless)</option>
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
              <option value="svg">SVG (Vector)</option>
              <option value="pdf">PDF (Print/Vector)</option>
              <option value="ai">Adobe Illustrator (.ai)</option>
              <option value="eps">EPS (PostScript)</option>
              <option value="png">PNG (Raster)</option>
              <option value="webp">WebP (Raster)</option>
              <option value="psd">PSD (Layered)</option>
              <option value="vectorcraft">Native (.vectorcraft)</option>
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
                const val = e.target.value as any;
                setDefaultPromptWorkflow(val);
                syncData({ defaultPromptWorkflow: val });
              }}
            >
              <option value="poster">🖼️ Poster Layout</option>
              <option value="icon-set">🔣 Icon Set Grid</option>
              <option value="recolor">🎨 Recolor Artwork</option>
              <option value="trace-and-style">✒️ Trace &amp; Style</option>
              <option value="export-set">📦 Export Artboard Set</option>
              <option value="none">None (Raw Tools)</option>
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
              <option value="canvas-draw">✏️ Canvas &amp; Batch</option>
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
              placeholder="vectorcraft-cli"
            />
          </div>
          <div>
            <label className="block text-[10px] font-semibold text-gray-400 mb-1">
              Control Port (--connect)
            </label>
            <input
              className="nodrag w-full bg-gray-950 border border-gray-700 focus:border-pink-500 rounded p-1.5 text-white font-mono text-[10px] outline-none transition"
              value={controlAddress}
              onChange={(e) => {
                const val = e.target.value;
                setControlAddress(val);
                syncData({ controlAddress: val });
              }}
              placeholder="127.0.0.1:7979"
            />
          </div>
        </div>

        {/* File Confinement Roots */}
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

        {/* Live CLI Preview & Telemetry Strip */}
        <div className="pt-2 border-t border-gray-800 space-y-1.5">
          <div className="bg-gray-950 px-2 py-1 rounded border border-gray-800 font-mono text-[9px] text-pink-300 truncate" title={cliPreview}>
            $ {cliPreview}
          </div>
          <div className="grid grid-cols-3 gap-1 text-[9px] font-mono text-gray-400">
            <div className="bg-gray-950 px-1.5 py-1 rounded border border-gray-800 text-center">
              🛠️ {toolCountLabel}
            </div>
            <div className="bg-gray-950 px-1.5 py-1 rounded border border-gray-800 text-center">
              📐 612×792pt
            </div>
            <div className="bg-gray-950 px-1.5 py-1 rounded border border-gray-800 text-center">
              📦 256-Batch
            </div>
          </div>
        </div>
      </div>

      <Handle
        type="source"
        position={Position.Right}
        id="vectorcraft-out"
        className="w-3.5 h-3.5 bg-pink-500 -right-2 transition hover:scale-125"
      />
    </div>
  );
}
