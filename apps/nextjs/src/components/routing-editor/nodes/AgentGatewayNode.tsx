"use client";

import { useState } from 'react';
import NodeHealthIndicator from '../NodeHealthIndicator';
import { Handle, Position, useReactFlow } from '@xyflow/react';

export default function AgentGatewayNode({ id, data }: { id: string; data: any }) {
  const { updateNodeData } = useReactFlow();
  const [accessPolicy, setAccessPolicy] = useState(data?.accessPolicy || 'restrictive');
  const [mcpEndpoint, setMcpEndpoint] = useState(data?.mcpEndpoint || 'http://localhost:8003/mcp');
  const [enableNativeTools, setEnableNativeTools] = useState<boolean>(data?.enableNativeTools ?? true);
  const [toolTimeoutMs, setToolTimeoutMs] = useState<number>(data?.toolTimeoutMs ?? 10000);
  const [sanitizeOutput, setSanitizeOutput] = useState<boolean>(data?.sanitizeToolOutput !== false);

  // Ensure default structure
  if (data) {
    if (!data.accessPolicy) data.accessPolicy = accessPolicy;
    if (!data.mcpEndpoint) data.mcpEndpoint = mcpEndpoint;
    if (data.enableNativeTools === undefined) data.enableNativeTools = enableNativeTools;
    if (data.toolTimeoutMs === undefined) data.toolTimeoutMs = toolTimeoutMs;
    if (data.sanitizeToolOutput === undefined) data.sanitizeToolOutput = sanitizeOutput;
  }

  const syncData = (updates: Record<string, any>) => {
    if (data) Object.assign(data, updates);
    if (id) updateNodeData(id, updates);
  };

  const handlePolicyChange = (e: React.ChangeEvent<HTMLSelectElement>) => {
    const val = e.target.value;
    setAccessPolicy(val);
    syncData({ accessPolicy: val });
  };

  const handleEndpointChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const val = e.target.value;
    setMcpEndpoint(val);
    syncData({ mcpEndpoint: val });
  };

  return (
    <div className="bg-gray-900 border-2 border-green-500 rounded-lg p-3.5 min-w-[280px] max-w-[320px] shadow-2xl transition hover:shadow-green-500/10">
      <Handle type="target" position={Position.Left} className="w-3.5 h-3.5 bg-green-500 -left-2" />
      
      {/* Header */}
      <div className="flex items-center justify-between pb-2 mb-2 border-b border-gray-800">
        <div className="flex items-center gap-1.5">
          <NodeHealthIndicator serviceName="agentgateway" />
          <span className="text-lg">🔌</span>
          <div>
            <div className="font-bold text-green-400 text-sm">Agent Gateway</div>
            <div className="text-[10px] text-gray-400 font-mono">MCP Protocol &amp; Tool Hub</div>
          </div>
        </div>
        <span className="text-[10px] bg-green-500/20 text-green-300 px-1.5 py-0.5 rounded font-mono">
          MCP v1.0
        </span>
      </div>
      
      <div className="text-xs text-gray-300 space-y-2.5">
        <div>
          <label className="block text-[10px] font-semibold text-gray-400 mb-1">MCP Registry Endpoint</label>
          <input
            className="nodrag w-full bg-gray-950 border border-gray-700 focus:border-green-500 rounded p-1.5 text-white font-mono text-[11px] outline-none transition"
            value={mcpEndpoint}
            onChange={handleEndpointChange}
            placeholder="http://localhost:8003/mcp"
          />
        </div>

        <div className="grid grid-cols-2 gap-2">
          <div>
            <label className="block text-[10px] font-semibold text-gray-400 mb-1">Access Policy</label>
            <select 
              className="nodrag w-full bg-gray-950 border border-gray-700 focus:border-green-500 rounded p-1.5 text-white text-[11px] outline-none transition cursor-pointer"
              value={accessPolicy}
              onChange={handlePolicyChange}
            >
              <option value="restrictive">🔒 Restrictive</option>
              <option value="permissive">🏢 Internal Only</option>
              <option value="open">🌐 Open (Public)</option>
            </select>
          </div>
          <div>
            <label className="block text-[10px] font-semibold text-gray-400 mb-1">Tool Timeout</label>
            <input
              type="number"
              min={1000}
              max={60000}
              step={1000}
              className="nodrag w-full bg-gray-950 border border-gray-700 focus:border-green-500 rounded p-1.5 text-white font-mono text-[11px] outline-none transition"
              value={toolTimeoutMs}
              onChange={(e) => {
                const val = parseInt(e.target.value, 10) || 10000;
                setToolTimeoutMs(val);
                syncData({ toolTimeoutMs: val });
              }}
            />
          </div>
        </div>

        {/* Toggles */}
        <div className="space-y-1.5 bg-gray-950/80 p-2 rounded border border-gray-800">
          <div className="flex justify-between items-center">
            <label className="text-[11px] font-semibold text-gray-300">Inject Native System Tools</label>
            <input
              type="checkbox"
              className="nodrag accent-green-500 cursor-pointer"
              checked={enableNativeTools}
              onChange={(e) => {
                setEnableNativeTools(e.target.checked);
                syncData({ enableNativeTools: e.target.checked });
              }}
            />
          </div>
          <div className="flex justify-between items-center">
            <label className="text-[11px] font-semibold text-gray-300">Sanitize Tool Output (PII scrub)</label>
            <input
              type="checkbox"
              className="nodrag accent-green-500 cursor-pointer"
              checked={sanitizeOutput}
              onChange={(e) => {
                setSanitizeOutput(e.target.checked);
                syncData({ sanitizeToolOutput: e.target.checked });
              }}
            />
          </div>
        </div>

        {/* Quick Badges Strip */}
        <div className="pt-2 border-t border-gray-800 grid grid-cols-2 gap-1.5 text-[9px] font-mono text-gray-400">
          <div className="flex items-center gap-1 bg-gray-950 px-2 py-1 rounded border border-gray-800">
            <span>⏱️</span>
            <span>Timeout: {toolTimeoutMs}ms</span>
          </div>
          <div className="flex items-center gap-1 bg-gray-950 px-2 py-1 rounded border border-gray-800">
            <span>🛡️</span>
            <span>Scrub: {sanitizeOutput ? 'Active' : 'Off'}</span>
          </div>
          <div className="flex items-center gap-1 bg-gray-950 px-2 py-1 rounded border border-gray-800">
            <span>🔐</span>
            <span>Policy: {accessPolicy}</span>
          </div>
          <div className="flex items-center gap-1 bg-gray-950 px-2 py-1 rounded border border-gray-800">
            <span>🧰</span>
            <span>Native: {enableNativeTools ? 'On' : 'Off'}</span>
          </div>
        </div>
      </div>

      <Handle type="source" position={Position.Right} id="ag-out" className="w-3.5 h-3.5 bg-green-500 -right-2 transition hover:scale-125" />
    </div>
  );
}
