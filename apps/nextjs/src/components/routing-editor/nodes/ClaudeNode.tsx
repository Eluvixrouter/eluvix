"use client";

import { useState, useEffect, useCallback, useRef } from 'react';
import { Handle, Position, useReactFlow } from '@xyflow/react';

const ANTHROPIC_MODEL_PRESETS = [
  { id: 'claude-3-7-sonnet', name: 'Claude 3.7 Sonnet (Hybrid Reasoning)', tier: 'Frontier' },
  { id: 'claude-3-5-sonnet', name: 'Claude 3.5 Sonnet (Coding Workhorse)', tier: 'Frontier' },
  { id: 'claude-3-5-haiku', name: 'Claude 3.5 Haiku (High Speed)', tier: 'Economy' },
  { id: 'claude-3-opus', name: 'Claude 3 Opus (Legacy Frontier)', tier: 'Deep Thought' },
  { id: '*', name: '* (All Anthropic Models)', tier: 'Wildcard' },
];

export default function ClaudeNode({ id, data }: { id: string; data: any }) {
  const { updateNodeData } = useReactFlow();
  const [endpoint, setEndpoint] = useState<string>(data?.endpoint || 'https://api.anthropic.com/v1');
  const [apiKey, setApiKey] = useState<string>(data?.apiKey || '');
  const [priority, setPriority] = useState<number>(data?.priority ?? 10);
  const [costPer1kTokens, setCostPer1kTokens] = useState<number>(data?.costPer1kTokens ?? 0.003);
  const [visionCapable, setVisionCapable] = useState<boolean>(data?.visionCapable ?? true);
  const [selectedModel, setSelectedModel] = useState<string>(data?.selectedModel || 'claude-3-7-sonnet');
  const [customModel, setCustomModel] = useState<string>('');
  const [status, setStatus] = useState<'idle' | 'checking' | 'online' | 'offline'>('idle');
  const [expanded, setExpanded] = useState<boolean>(false);

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

  const detectModels = useCallback(async (targetEndpoint = endpoint, targetKey = apiKey) => {
    setStatus('checking');
    try {
      const res = await fetch('/api/v1/detect-models', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          id: id || data?.id || 'claude-direct',
          name: data?.label || 'Anthropic Claude',
          type: 'anthropic',
          endpoint: targetEndpoint,
          apiKey: targetKey || undefined
        })
      });

      const json = await res.json();
      if (json.success && Array.isArray(json.models) && json.models.length > 0) {
        setStatus('online');
        syncData({
          endpoint: targetEndpoint,
          apiKey: targetKey,
          status: 'online'
        });
      } else {
        setStatus('offline');
        syncData({ endpoint: targetEndpoint, apiKey: targetKey, status: 'offline' });
      }
    } catch {
      setStatus('offline');
      syncData({ endpoint: targetEndpoint, apiKey: targetKey, status: 'offline' });
    }
  }, [endpoint, apiKey, id, data?.id, data?.label, syncData]);

  // Initial detection if apiKey is provided
  useEffect(() => {
    if (apiKey) {
      detectModels();
    }
  }, [apiKey, detectModels]);

  const handleEndpointChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const val = e.target.value;
    setEndpoint(val);
    syncData({ endpoint: val });
  };

  const handleApiKeyChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const val = e.target.value;
    setApiKey(val);
    syncData({ apiKey: val });
  };

  const handlePriorityChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const val = parseInt(e.target.value, 10) || 1;
    setPriority(val);
    syncData({ priority: val });
  };

  const handleCostChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const val = parseFloat(e.target.value) || 0;
    setCostPer1kTokens(val);
    syncData({ costPer1kTokens: val });
  };

  const handleVisionToggle = (e: React.ChangeEvent<HTMLInputElement>) => {
    const val = e.target.checked;
    setVisionCapable(val);
    syncData({ visionCapable: val });
  };

  const handleModelSelect = (val: string) => {
    setSelectedModel(val);
    if (val !== 'custom') {
      syncData({ selectedModel: val });
    }
  };

  const handleCustomModelApply = () => {
    if (customModel.trim()) {
      setSelectedModel(customModel.trim());
      syncData({ selectedModel: customModel.trim() });
    }
  };

  return (
    <div className="relative shadow-2xl rounded-2xl bg-gradient-to-br from-amber-950/60 via-slate-900/90 to-amber-950/40 border border-amber-500/80 p-4 min-w-[320px] max-w-[360px] text-white backdrop-blur-md transition-all duration-300 hover:border-amber-400 hover:shadow-amber-500/20">
      {/* Target handle from Switchyard / routers / guards */}
      <Handle
        type="target"
        position={Position.Left}
        id="input"
        className="w-3.5 h-3.5 bg-amber-400 border-2 border-slate-950 shadow-md transition-transform hover:scale-125"
      />

      {/* Header */}
      <div className="flex items-center justify-between pb-3 border-b border-amber-500/30">
        <div className="flex items-center gap-2.5">
          <div className="w-8 h-8 rounded-lg bg-amber-500/20 border border-amber-500/40 flex items-center justify-center text-lg shadow-inner">
            ✳️
          </div>
          <div>
            <div className="font-bold text-sm tracking-wide text-amber-200">
              {data?.label || 'Anthropic Claude'}
            </div>
            <div className="text-[10px] text-amber-300/70 font-mono flex items-center gap-1.5">
              <span>api.anthropic.com</span>
              <span>•</span>
              <span className="text-[9px] uppercase tracking-wider bg-amber-500/20 text-amber-300 px-1 py-0.2 rounded font-sans">
                Cloud
              </span>
            </div>
          </div>
        </div>

        {/* Live Status Indicator */}
        <div className="flex items-center gap-1.5">
          <span
            className={`w-2 h-2 rounded-full transition-colors duration-300 ${
              status === 'online'
                ? 'bg-emerald-400 shadow-[0_0_8px_rgba(52,211,153,0.8)]'
                : status === 'checking'
                ? 'bg-amber-400 animate-pulse'
                : status === 'offline'
                ? 'bg-rose-400'
                : 'bg-slate-500'
            }`}
          />
          <span className="text-[10px] uppercase font-mono text-slate-400">
            {status}
          </span>
        </div>
      </div>

      {/* Model Selection */}
      <div className="mt-3">
        <div className="flex items-center justify-between text-[11px] font-medium text-slate-300 mb-1.5">
          <span>Active Frontier Model</span>
          <span className="text-[10px] text-amber-400 font-mono font-semibold">
            ${costPer1kTokens}/1k tok
          </span>
        </div>
        <select
          value={
            ANTHROPIC_MODEL_PRESETS.some((m) => m.id === selectedModel)
              ? selectedModel
              : 'custom'
          }
          onChange={(e) => handleModelSelect(e.target.value)}
          className="w-full bg-slate-950/80 border border-amber-500/40 rounded-lg px-2.5 py-1.5 text-xs text-amber-100 focus:outline-none focus:border-amber-400 transition"
        >
          {ANTHROPIC_MODEL_PRESETS.map((m) => (
            <option key={m.id} value={m.id} className="bg-slate-900 text-white">
              {m.name}
            </option>
          ))}
          <option value="custom" className="bg-slate-900 text-amber-300">
            Custom Model Identifier...
          </option>
        </select>
      </div>

      {/* Custom Model Input if custom is chosen */}
      {(!ANTHROPIC_MODEL_PRESETS.some((m) => m.id === selectedModel) ||
        selectedModel === 'custom') && (
        <div className="mt-2 flex gap-1.5">
          <input
            type="text"
            placeholder="e.g. claude-3-7-sonnet-latest"
            value={customModel}
            onChange={(e) => setCustomModel(e.target.value)}
            className="flex-1 bg-slate-950/90 border border-amber-500/50 rounded-lg px-2.5 py-1 text-xs text-amber-100 font-mono placeholder-slate-500 focus:outline-none focus:border-amber-400"
          />
          <button
            type="button"
            onClick={handleCustomModelApply}
            className="px-2 py-1 bg-amber-600 hover:bg-amber-500 text-slate-950 rounded-lg text-xs font-bold transition shadow"
          >
            Set
          </button>
        </div>
      )}

      {/* API Key Input */}
      <div className="mt-3">
        <label className="block text-[11px] font-medium text-slate-300 mb-1">
          Anthropic API Key
        </label>
        <div className="relative">
          <input
            type="password"
            placeholder="sk-ant-api03-..."
            value={apiKey}
            onChange={handleApiKeyChange}
            className="w-full bg-slate-950/80 border border-slate-700/80 rounded-lg px-2.5 py-1.5 text-xs text-slate-200 font-mono placeholder-slate-600 focus:outline-none focus:border-amber-400 transition pr-16"
          />
          <button
            type="button"
            onClick={() => detectModels()}
            disabled={status === 'checking'}
            className="absolute right-1 top-1 bottom-1 px-2 bg-amber-500/20 hover:bg-amber-500/30 text-amber-300 rounded text-[10px] font-mono transition flex items-center justify-center disabled:opacity-50"
          >
            {status === 'checking' ? '...' : 'Probe'}
          </button>
        </div>
      </div>

      {/* Collapsible Advanced Config */}
      <div className="mt-3 pt-2 border-t border-slate-800">
        <button
          type="button"
          onClick={() => setExpanded(!expanded)}
          className="w-full flex items-center justify-between text-[10px] text-slate-400 hover:text-amber-300 transition"
        >
          <span className="font-semibold uppercase tracking-wider">
            Endpoint & Routing Parameters
          </span>
          <span>{expanded ? '▲ Hide' : '▼ Expand'}</span>
        </button>

        {expanded && (
          <div className="mt-2 space-y-2.5 text-xs">
            <div>
              <label className="block text-[10px] text-slate-400 mb-0.5">
                API Base URL
              </label>
              <input
                type="text"
                value={endpoint}
                onChange={handleEndpointChange}
                className="w-full bg-slate-950/80 border border-slate-700/80 rounded px-2 py-1 text-xs font-mono text-slate-200 focus:outline-none focus:border-amber-400"
              />
            </div>

            <div className="grid grid-cols-2 gap-2">
              <div>
                <label className="block text-[10px] text-slate-400 mb-0.5">
                  Priority (Weight)
                </label>
                <input
                  type="number"
                  min="1"
                  max="100"
                  value={priority}
                  onChange={handlePriorityChange}
                  className="w-full bg-slate-950/80 border border-slate-700/80 rounded px-2 py-1 text-xs font-mono text-slate-200 focus:outline-none focus:border-amber-400"
                />
              </div>
              <div>
                <label className="block text-[10px] text-slate-400 mb-0.5">
                  Cost / 1k Tokens
                </label>
                <input
                  type="number"
                  step="0.0001"
                  value={costPer1kTokens}
                  onChange={handleCostChange}
                  className="w-full bg-slate-950/80 border border-slate-700/80 rounded px-2 py-1 text-xs font-mono text-slate-200 focus:outline-none focus:border-amber-400"
                />
              </div>
            </div>

            <label className="flex items-center gap-2 cursor-pointer pt-1">
              <input
                type="checkbox"
                checked={visionCapable}
                onChange={handleVisionToggle}
                className="rounded bg-slate-900 border-slate-700 text-amber-500 focus:ring-amber-400"
              />
              <span className="text-[11px] text-slate-300">
                Vision & Multimodal Support
              </span>
            </label>
          </div>
        )}
      </div>

      {/* Badges footer */}
      <div className="mt-3 flex items-center justify-between text-[10px] text-slate-400 font-mono pt-2 border-t border-slate-800/80">
        <span className="flex items-center gap-1 text-amber-300">
          <span>Priority:</span>
          <span className="font-bold">{priority}</span>
        </span>
        <span className="bg-amber-950/50 text-amber-300 border border-amber-500/30 px-1.5 py-0.5 rounded text-[9px]">
          tier-4 cloud
        </span>
      </div>

      {/* Source handle to observability or fallback */}
      <Handle
        type="source"
        position={Position.Right}
        id="output"
        className="w-3.5 h-3.5 bg-amber-400 border-2 border-slate-950 shadow-md transition-transform hover:scale-125"
      />
    </div>
  );
}
