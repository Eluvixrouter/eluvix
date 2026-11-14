"use client";

import { useState, useEffect } from 'react';
import { Handle, Position, useReactFlow } from '@xyflow/react';

export default function McpToolNode({ id, data }: { id: string; data: any }) {
  const { updateNodeData } = useReactFlow();
  const [toolName, setToolName] = useState(data?.toolName || 'Filesystem');
  const [mcpEndpoint, setMcpEndpoint] = useState(data?.mcpEndpoint || 'http://localhost:8003/mcp');
  const [executionMode, setExecutionMode] = useState<'auto' | 'confirm' | 'dry-run'>(data?.executionMode || 'auto');
  const [timeoutMs, setTimeoutMs] = useState<number>(data?.timeoutMs ?? 5000);

  // Persist missing defaults into the node data via the store, never by
  // mutating the `data` prop. Guarded so each default is written once.
  // toolName/mcpEndpoint use `=== undefined` guards because their text
  // inputs can be cleared to '' — a `!data.x` guard would re-fire forever.
  useEffect(() => {
    if (!data || !id) return;
    const missing: Record<string, unknown> = {};
    if (data.toolName === undefined) missing.toolName = toolName;
    if (data.mcpEndpoint === undefined) missing.mcpEndpoint = mcpEndpoint;
    if (!data.executionMode) missing.executionMode = executionMode;
    if (data.timeoutMs === undefined) missing.timeoutMs = timeoutMs;
    if (Object.keys(missing).length > 0) updateNodeData(id, missing);
  }, [data, id, updateNodeData, toolName, mcpEndpoint, executionMode, timeoutMs]);

  const syncData = (updates: Record<string, any>) => {
    if (data) Object.assign(data, updates);
    if (id) updateNodeData(id, updates);
  };

  const handleNameChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const val = e.target.value;
    setToolName(val);
    syncData({ toolName: val });
  };

  const handleEndpointChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const val = e.target.value;
    setMcpEndpoint(val);
    syncData({ mcpEndpoint: val });
  };

  const handleModeChange = (e: React.ChangeEvent<HTMLSelectElement>) => {
    const val = e.target.value as 'auto' | 'confirm' | 'dry-run';
    setExecutionMode(val);
    syncData({ executionMode: val });
  };

  return (
    <div className="bg-gray-900 border-2 border-yellow-500 rounded-lg p-3.5 min-w-[260px] max-w-[300px] shadow-2xl transition hover:shadow-yellow-500/10">
      <Handle type="target" position={Position.Left} className="w-3.5 h-3.5 bg-yellow-500 -left-2" />
      
      {/* Header */}
      <div className="font-bold text-yellow-400 mb-2 flex items-center justify-between border-b border-gray-800 pb-2">
        <div className="flex items-center gap-1.5">
          <span>🧰</span>
          <span className="text-sm">{toolName || 'MCP Tool'}</span>
        </div>
        <span className="text-[10px] bg-yellow-500/20 text-yellow-300 px-1.5 py-0.5 rounded font-mono uppercase">
          {executionMode}
        </span>
      </div>
      
      <div className="text-xs text-gray-300 space-y-2.5">
        <div>
          <label className="block text-[10px] font-semibold text-gray-400 mb-1">Quick Server Preset</label>
          <select
            className="nodrag w-full bg-gray-950 border border-gray-700 focus:border-yellow-500 rounded p-1.5 text-white text-[11px] outline-none transition cursor-pointer"
            value={
              mcpEndpoint === 'http://localhost:8003/mcp'
                ? 'filesystem'
                : mcpEndpoint.startsWith('stdio://') && mcpEndpoint.includes('-cli mcp')
                  ? mcpEndpoint.replace(/^stdio:\/\/([a-z-]+)-cli\s+mcp.*$/, '$1')
                  : 'custom'
            }
            onChange={(e) => {
              const preset = e.target.value;
              if (preset === 'filesystem') {
                setToolName('Filesystem');
                setMcpEndpoint('http://localhost:8003/mcp');
                syncData({
                  toolName: 'Filesystem',
                  mcpEndpoint: 'http://localhost:8003/mcp'
                });
              } else if (preset !== 'custom') {
                const endpoint =
                  preset === 'vectorcraft'
                    ? 'stdio://vectorcraft-cli mcp --headless'
                    : preset === 'craft-anything'
                      ? 'stdio://craft-anything-cli mcp --deep --all-tools'
                      : `stdio://${preset}-cli mcp`;
                setToolName(preset);
                setMcpEndpoint(endpoint);
                syncData({
                  toolName: preset,
                  mcpEndpoint: endpoint
                });
              }
            }}
          >
            <option value="filesystem">📁 Filesystem MCP (HTTP)</option>
            <optgroup label="ArtCraft Suite MCP Servers (stdio)">
              <option value="vectorcraft">🎨 VectorCraft (vectorcraft-cli mcp)</option>
              <option value="photocraft">🖼️ PhotoCraft (photocraft-cli mcp)</option>
              <option value="filmcraft">🎬 FilmCraft (filmcraft-cli mcp)</option>
              <option value="lightcraft">📸 LightCraft (lightcraft-cli mcp)</option>
              <option value="pdfcraft">📄 PdfCraft (pdfcraft-cli mcp)</option>
              <option value="effectcraft">✨ EffectCraft (effectcraft-cli mcp)</option>
              <option value="designcraft">📰 DesignCraft (designcraft-cli mcp)</option>
              <option value="figcraft">📐 FigCraft (figcraft-cli mcp)</option>
              <option value="wordcraft">📝 WordCraft (wordcraft-cli mcp)</option>
              <option value="soundcraft">🎵 SoundCraft (soundcraft-cli mcp)</option>
              <option value="deckcraft">📊 DeckCraft (deckcraft-cli mcp)</option>
              <option value="cadcraft">⚙️ CADCraft (cadcraft-cli mcp)</option>
              <option value="gridcraft">📈 GridCraft (gridcraft-cli mcp)</option>
              <option value="craft-anything">🔬 Craft Anything (craft-anything-cli mcp)</option>
            </optgroup>
            <option value="custom">⚙️ Custom MCP Server</option>
          </select>
        </div>

        <div>
          <label className="block text-[10px] font-semibold text-gray-400 mb-1">Tool Identifier</label>
          <input
            className="nodrag w-full bg-gray-950 border border-gray-700 focus:border-yellow-500 rounded p-1.5 text-white font-mono text-[11px] outline-none transition"
            value={toolName}
            onChange={handleNameChange}
            placeholder="e.g. SQLite Search"
          />
        </div>

        <div>
          <label className="block text-[10px] font-semibold text-gray-400 mb-1">MCP URL / Command</label>
          <input
            className="nodrag w-full bg-gray-950 border border-gray-700 focus:border-yellow-500 rounded p-1.5 text-white font-mono text-[10px] outline-none transition"
            value={mcpEndpoint}
            onChange={handleEndpointChange}
            placeholder="http://localhost:8003/mcp"
          />
        </div>

        <div className="grid grid-cols-2 gap-2">
          <div>
            <label className="block text-[10px] font-semibold text-gray-400 mb-1">Execution Mode</label>
            <select
              className="nodrag w-full bg-gray-950 border border-gray-700 focus:border-yellow-500 rounded p-1.5 text-white text-[11px] outline-none transition cursor-pointer"
              value={executionMode}
              onChange={handleModeChange}
            >
              <option value="auto">⚡ Auto Run</option>
              <option value="confirm">✋ Confirmation</option>
              <option value="dry-run">🔍 Dry Run</option>
            </select>
          </div>
          <div>
            <label className="block text-[10px] font-semibold text-gray-400 mb-1">Timeout (ms)</label>
            <input
              type="number"
              min={500}
              max={30000}
              step={500}
              className="nodrag w-full bg-gray-950 border border-gray-700 focus:border-yellow-500 rounded p-1.5 text-white font-mono text-[11px] outline-none transition"
              value={timeoutMs}
              onChange={(e) => {
                const val = parseInt(e.target.value, 10) || 5000;
                setTimeoutMs(val);
                syncData({ timeoutMs: val });
              }}
            />
          </div>
        </div>

        {/* Quick Badges Strip */}
        <div className="pt-2 border-t border-gray-800 grid grid-cols-2 gap-1.5 text-[9px] font-mono text-gray-400">
          <div className="flex items-center gap-1 bg-gray-950 px-2 py-1 rounded border border-gray-800">
            <span>⏱️</span>
            <span>{timeoutMs}ms</span>
          </div>
          <div className="flex items-center gap-1 bg-gray-950 px-2 py-1 rounded border border-gray-800">
            <span>🛡️</span>
            <span>Mode: {executionMode}</span>
          </div>
        </div>
      </div>

      <Handle type="source" position={Position.Right} id="tool-out" className="w-3.5 h-3.5 bg-yellow-500 -right-2 transition hover:scale-125" />
    </div>
  );
}
