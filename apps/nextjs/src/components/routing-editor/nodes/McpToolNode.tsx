"use client";

import { useState } from 'react';
import { Handle, Position, useReactFlow } from '@xyflow/react';

export default function McpToolNode({ id, data }: { id: string; data: any }) {
  const { updateNodeData } = useReactFlow();
  const [toolName, setToolName] = useState(data?.toolName || 'Filesystem');
  const [mcpEndpoint, setMcpEndpoint] = useState(data?.mcpEndpoint || 'http://localhost:8003/mcp');
  const [executionMode, setExecutionMode] = useState<'auto' | 'confirm' | 'dry-run'>(data?.executionMode || 'auto');
  const [timeoutMs, setTimeoutMs] = useState<number>(data?.timeoutMs ?? 5000);

  // Ensure default structure
  if (data) {
    if (!data.toolName) data.toolName = toolName;
    if (!data.mcpEndpoint) data.mcpEndpoint = mcpEndpoint;
    if (!data.executionMode) data.executionMode = executionMode;
    if (data.timeoutMs === undefined) data.timeoutMs = timeoutMs;
  }

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
