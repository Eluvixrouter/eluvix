"use client";

import { useState } from 'react';
import { Handle, Position, useReactFlow } from '@xyflow/react';

export default function AgentNode({ id, data }: { id: string; data: any }) {
  const { updateNodeData } = useReactFlow();
  const [agentName, setAgentName] = useState(data?.agentName || 'Custom ReAct Agent');
  const [modelName, setModelName] = useState(data?.modelName || 'meta-llama/Llama-3-8b');
  const [systemInstructions, setSystemInstructions] = useState(data?.systemInstructions || 'You are an autonomous AI assistant.');
  const [temperature, setTemperature] = useState(data?.temperature ?? 0.7);
  const [maxTokens, setMaxTokens] = useState(data?.maxTokens ?? 2048);
  const [memoryEnabled, setMemoryEnabled] = useState(data?.memoryEnabled !== false);

  // Ensure default structure
  if (data) {
    if (!data.agentName) data.agentName = agentName;
    if (!data.modelName) data.modelName = modelName;
    if (!data.systemInstructions) data.systemInstructions = systemInstructions;
    if (data.temperature === undefined) data.temperature = temperature;
    if (data.maxTokens === undefined) data.maxTokens = maxTokens;
    if (data.memoryEnabled === undefined) data.memoryEnabled = memoryEnabled;
  }

  const syncData = (updates: Record<string, any>) => {
    if (data) Object.assign(data, updates);
    if (id) updateNodeData(id, updates);
  };

  const handleNameChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const val = e.target.value;
    setAgentName(val);
    syncData({ agentName: val });
  };

  const handleModelChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const val = e.target.value;
    setModelName(val);
    syncData({ modelName: val });
  };

  const handleInstructionsChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    const val = e.target.value;
    setSystemInstructions(val);
    syncData({ systemInstructions: val });
  };

  return (
    <div className="bg-gray-900 border-2 border-purple-500 rounded-lg p-3.5 min-w-[280px] max-w-[320px] shadow-2xl transition hover:shadow-purple-500/10 relative">
      {/* Top Handle for MCP Tool Connections */}
      <Handle 
        type="target" 
        position={Position.Top} 
        id="tool-in" 
        className="w-3.5 h-3.5 bg-yellow-400 -top-2 transition hover:scale-125" 
        title="Connect MCP Tools Here"
      />
      
      {/* Left Input Handle */}
      <Handle type="target" position={Position.Left} className="w-3.5 h-3.5 bg-purple-500 -left-2" />
      
      {/* Header */}
      <div className="flex items-center justify-between pb-2 mb-2 border-b border-gray-800">
        <div className="flex items-center gap-1.5">
          <span className="text-lg">🤖</span>
          <div>
            <div className="font-bold text-purple-400 text-sm">{agentName}</div>
            <div className="text-[10px] text-gray-400 font-mono">Custom Prompt &amp; ReAct Agent</div>
          </div>
        </div>
        <span className="text-[10px] bg-purple-500/20 text-purple-300 px-1.5 py-0.5 rounded font-mono">
          REACT
        </span>
      </div>

      <div className="text-xs text-gray-300 space-y-2.5">
        <div>
          <label className="block text-[10px] font-semibold text-gray-400 mb-1">Agent Name</label>
          <input 
            className="nodrag w-full bg-gray-950 border border-gray-700 focus:border-purple-500 rounded p-1.5 text-white text-[11px] outline-none transition" 
            value={agentName} 
            onChange={handleNameChange}
            placeholder="e.g. Code Review Assistant"
          />
        </div>

        <div>
          <label className="block text-[10px] font-semibold text-gray-400 mb-1">Target Model / Engine</label>
          <input 
            className="nodrag w-full bg-gray-950 border border-gray-700 focus:border-purple-500 rounded p-1.5 text-white font-mono text-[11px] outline-none transition" 
            value={modelName} 
            onChange={handleModelChange}
            placeholder="e.g. meta-llama/Llama-3-8b"
          />
        </div>

        <div>
          <label className="block text-[10px] font-semibold text-gray-400 mb-1">System Persona &amp; Instructions</label>
          <textarea
            rows={2}
            className="nodrag w-full bg-gray-950 border border-gray-700 focus:border-purple-500 rounded p-1.5 text-white text-[11px] outline-none transition resize-none"
            value={systemInstructions}
            onChange={handleInstructionsChange}
            placeholder="You are an autonomous agent..."
          />
        </div>

        <div className="grid grid-cols-2 gap-2">
          <div>
            <div className="flex justify-between items-center mb-0.5">
              <label className="text-[10px] font-semibold text-gray-400">Temp</label>
              <span className="text-[10px] font-mono text-purple-400">{temperature}</span>
            </div>
            <input
              type="range"
              min="0"
              max="1"
              step="0.05"
              className="nodrag w-full accent-purple-500 cursor-pointer"
              value={temperature}
              onChange={(e) => {
                const val = parseFloat(e.target.value) || 0.7;
                setTemperature(val);
                syncData({ temperature: val });
              }}
            />
          </div>
          <div>
            <label className="block text-[10px] font-semibold text-gray-400 mb-0.5">Max Tokens</label>
            <input
              type="number"
              min={256}
              max={16384}
              step={256}
              className="nodrag w-full bg-gray-950 border border-gray-700 focus:border-purple-500 rounded p-1 text-white font-mono text-[11px] outline-none transition"
              value={maxTokens}
              onChange={(e) => {
                const val = parseInt(e.target.value, 10) || 2048;
                setMaxTokens(val);
                syncData({ maxTokens: val });
              }}
            />
          </div>
        </div>

        {/* Memory Toggle */}
        <div className="flex items-center justify-between bg-gray-950/80 p-2 rounded border border-gray-800">
          <label className="flex items-center gap-2 cursor-pointer text-[11px]">
            <input 
              type="checkbox"
              className="nodrag accent-purple-500 cursor-pointer"
              checked={memoryEnabled}
              onChange={(e) => {
                setMemoryEnabled(e.target.checked);
                syncData({ memoryEnabled: e.target.checked });
              }}
            />
            <span>Short-Term Multi-Turn Memory</span>
          </label>
          <span className="text-[10px] font-mono text-purple-400">{memoryEnabled ? 'Active' : 'Off'}</span>
        </div>

        {/* Quick Badges Strip */}
        <div className="pt-2 border-t border-gray-800 grid grid-cols-2 gap-1.5 text-[9px] font-mono text-gray-400">
          <div className="flex items-center gap-1 bg-gray-950 px-2 py-1 rounded border border-gray-800">
            <span>🌡️</span>
            <span>Temp: {temperature}</span>
          </div>
          <div className="flex items-center gap-1 bg-gray-950 px-2 py-1 rounded border border-gray-800">
            <span>📝</span>
            <span>Limit: {maxTokens} tkn</span>
          </div>
          <div className="flex items-center gap-1 bg-gray-950 px-2 py-1 rounded border border-gray-800">
            <span>🧠</span>
            <span>Memory: {memoryEnabled ? 'On' : 'Off'}</span>
          </div>
          <div className="flex items-center gap-1 bg-gray-950 px-2 py-1 rounded border border-gray-800">
            <span>🧰</span>
            <span>Tools: Attached Top</span>
          </div>
        </div>
      </div>

      {/* Right Output Handle */}
      <Handle type="source" position={Position.Right} className="w-3.5 h-3.5 bg-purple-500 -right-2 transition hover:scale-125" />
    </div>
  );
}
