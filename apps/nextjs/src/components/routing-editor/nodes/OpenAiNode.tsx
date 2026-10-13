"use client";

import { useState, useEffect, useCallback, useRef } from 'react';
import { Handle, Position, useReactFlow } from '@xyflow/react';

const OPENAI_MODEL_PRESETS = [
  { id: 'gpt-4o', name: 'GPT-4o (Omni Flagship)', tier: 'Frontier' },
  { id: 'gpt-4o-mini', name: 'GPT-4o mini (Fast & Low Cost)', tier: 'Economy' },
  { id: 'o1', name: 'o1 (Frontier Deep Reasoning)', tier: 'Deep Reasoning' },
  { id: 'o3-mini', name: 'o3-mini (High Coding & Math)', tier: 'Coding Reasoning' },
  { id: 'o1-mini', name: 'o1-mini (Fast Coding Reasoning)', tier: 'Fast Reasoning' },
  { id: 'gpt-4-turbo', name: 'GPT-4 Turbo (128k Context)', tier: 'Standard' },
  { id: '*', name: '* (All OpenAI Models)', tier: 'Wildcard' },
];

export default function OpenAiNode({ id, data }: { id: string; data: any }) {
  const { updateNodeData } = useReactFlow();
  const [endpoint, setEndpoint] = useState<string>(data?.endpoint || 'https://api.openai.com/v1');
  const [apiKey, setApiKey] = useState<string>(data?.apiKey || '');
  const [priority, setPriority] = useState<number>(data?.priority ?? 10);
  const [costPer1kTokens, setCostPer1kTokens] = useState<number>(data?.costPer1kTokens ?? 0.005);
  const [visionCapable, setVisionCapable] = useState<boolean>(data?.visionCapable ?? true);
  const [selectedModel, setSelectedModel] = useState<string>(data?.selectedModel || 'gpt-4o');
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
          id: id || data?.id || 'openai-direct',
          name: data?.label || 'OpenAI Direct',
          type: 'openai-compatible',
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

  const handleModelSelect = (e: React.ChangeEvent<HTMLSelectElement>) => {
    const val = e.target.value;
    if (val === '__custom__') {
      setSelectedModel(customModel || 'custom-openai');
      syncData({ selectedModel: customModel || 'custom-openai' });
    } else {
      setSelectedModel(val);
      syncData({ selectedModel: val });
    }
  };

  const handleCustomModelSet = () => {
    if (!customModel.trim()) return;
    const trimmed = customModel.trim();
    setSelectedModel(trimmed);
    syncData({ selectedModel: trimmed });
  };

  const isPreset = OPENAI_MODEL_PRESETS.some(p => p.id === selectedModel);

  return (
    <div className="bg-gray-900 border-2 border-emerald-500/80 rounded-xl p-3.5 min-w-[300px] max-w-[360px] shadow-2xl transition hover:shadow-emerald-500/20 hover:border-emerald-400">
      {/* Target input handle (left) */}
      <Handle
        type="target"
        position={Position.Left}
        className="w-3.5 h-3.5 bg-emerald-400 border-2 border-gray-900 rounded-full !-left-2 shadow-[0_0_8px_rgba(16,185,129,0.8)]"
      />

      {/* Node Header */}
      <div className="flex items-center justify-between pb-2 mb-2.5 border-b border-gray-800">
        <div className="flex items-center gap-2">
          <span className="text-xl">🟢</span>
          <div>
            <div className="font-bold text-emerald-300 text-sm flex items-center gap-1.5">
              <span>{data?.label || 'OpenAI Direct'}</span>
            </div>
            <div className="text-[10px] text-gray-400 font-mono">Frontier Cloud LLM API</div>
          </div>
        </div>

        {/* Live Status Badge */}
        <div className="flex items-center gap-1.5">
          {status === 'checking' && (
            <span className="flex items-center gap-1 text-[10px] text-amber-400 bg-amber-500/20 px-2 py-0.5 rounded-full font-medium animate-pulse">
              <span className="w-1.5 h-1.5 rounded-full bg-amber-400"></span>
              Probing
            </span>
          )}
          {status === 'online' && (
            <span className="flex items-center gap-1 text-[10px] text-emerald-300 bg-emerald-500/20 px-2 py-0.5 rounded-full font-medium">
              <span className="w-1.5 h-1.5 rounded-full bg-emerald-400"></span>
              Online
            </span>
          )}
          {status === 'offline' && (
            <span className="flex items-center gap-1 text-[10px] text-red-400 bg-red-500/20 px-2 py-0.5 rounded-full font-medium">
              <span className="w-1.5 h-1.5 rounded-full bg-red-400"></span>
              Offline
            </span>
          )}
          {status === 'idle' && (
            <span className="text-[9px] bg-emerald-500/20 text-emerald-300 border border-emerald-500/40 px-1.5 py-0.5 rounded font-mono">
              Frontier
            </span>
          )}
          <button
            type="button"
            onClick={() => detectModels(endpoint, apiKey)}
            title="Probe OpenAI endpoint"
            className="nodrag p-1 text-gray-400 hover:text-emerald-300 hover:bg-gray-800 rounded transition"
          >
            <svg className={`w-3.5 h-3.5 ${status === 'checking' ? 'animate-spin' : ''}`} fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
            </svg>
          </button>
        </div>
      </div>

      {/* Model Selector */}
      <div className="mb-2.5">
        <label className="block text-[11px] font-semibold text-gray-300 mb-1">
          OpenAI Model
        </label>
        <select
          value={isPreset ? selectedModel : '__custom__'}
          onChange={handleModelSelect}
          className="nodrag w-full bg-gray-950 border border-gray-700 text-white rounded px-2 py-1.5 text-xs focus:outline-none focus:border-emerald-400"
        >
          {OPENAI_MODEL_PRESETS.map(p => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
          <option value="__custom__">✏️ Custom Model ID...</option>
        </select>
      </div>

      {/* Custom Model Input */}
      {(!isPreset || selectedModel === '__custom__') && (
        <div className="mb-2.5 flex gap-1">
          <input
            type="text"
            value={customModel}
            onChange={(e) => setCustomModel(e.target.value)}
            placeholder="e.g. gpt-4o-2024-11-20"
            className="nodrag flex-1 bg-gray-950 border border-emerald-500/50 text-white rounded px-2 py-1 text-xs focus:outline-none"
          />
          <button
            type="button"
            onClick={handleCustomModelSet}
            className="nodrag px-2 py-1 bg-emerald-600 hover:bg-emerald-500 text-white rounded text-xs font-semibold"
          >
            Set
          </button>
        </div>
      )}

      {/* API Key Field */}
      <div className="mb-2.5">
        <div className="flex items-center justify-between mb-1">
          <label className="text-[11px] font-semibold text-gray-300">
            OpenAI API Key
          </label>
          <span className="text-[9px] text-gray-500 font-mono">OPENAI_API_KEY</span>
        </div>
        <input
          type="password"
          value={apiKey}
          onChange={handleApiKeyChange}
          placeholder="sk-proj-... (or system env)"
          className="nodrag w-full bg-gray-950 border border-gray-700 text-white rounded px-2 py-1 text-xs focus:outline-none focus:border-emerald-400 font-mono"
        />
      </div>

      {/* Quick Metrics Bar */}
      <div className="grid grid-cols-2 gap-2 text-[10px] text-gray-400 bg-gray-950/60 p-2 rounded border border-gray-800/80 mb-2">
        <div>
          <span className="text-gray-500">Tier: </span>
          <span className="text-emerald-300 font-medium">Tier 4 (Frontier)</span>
        </div>
        <div>
          <span className="text-gray-500">Est. Cost: </span>
          <span className="text-emerald-400 font-mono">${costPer1kTokens}/1k</span>
        </div>
      </div>

      {/* Expandable Advanced Options */}
      <div>
        <button
          type="button"
          onClick={() => setExpanded(!expanded)}
          className="nodrag text-[10px] text-emerald-400 hover:text-emerald-300 flex items-center gap-1 font-medium transition"
        >
          <span>{expanded ? '▲ Hide Advanced Settings' : '▼ Advanced Settings'}</span>
        </button>

        {expanded && (
          <div className="mt-2 pt-2 border-t border-gray-800 space-y-2 text-xs">
            <div>
              <label className="block text-[10px] text-gray-400 mb-0.5">Endpoint URL</label>
              <input
                type="text"
                value={endpoint}
                onChange={handleEndpointChange}
                className="nodrag w-full bg-gray-950 border border-gray-700 text-white rounded px-2 py-1 text-xs font-mono focus:outline-none focus:border-emerald-400"
              />
            </div>
            <div className="grid grid-cols-2 gap-2">
              <div>
                <label className="block text-[10px] text-gray-400 mb-0.5">Router Priority</label>
                <input
                  type="number"
                  value={priority}
                  onChange={handlePriorityChange}
                  className="nodrag w-full bg-gray-950 border border-gray-700 text-white rounded px-2 py-1 text-xs focus:outline-none focus:border-emerald-400"
                />
              </div>
              <div>
                <label className="block text-[10px] text-gray-400 mb-0.5">Cost / 1k Tokens ($)</label>
                <input
                  type="number"
                  step="0.001"
                  value={costPer1kTokens}
                  onChange={handleCostChange}
                  className="nodrag w-full bg-gray-950 border border-gray-700 text-white rounded px-2 py-1 text-xs focus:outline-none focus:border-emerald-400"
                />
              </div>
            </div>
            <div className="flex items-center gap-2 pt-1">
              <input
                type="checkbox"
                id={`vision-${id}`}
                checked={visionCapable}
                onChange={(e) => {
                  setVisionCapable(e.target.checked);
                  syncData({ visionCapable: e.target.checked });
                }}
                className="nodrag rounded border-gray-700 text-emerald-500 focus:ring-0"
              />
              <label htmlFor={`vision-${id}`} className="text-[10px] text-gray-300 cursor-pointer">
                Vision &amp; Multimodal Capable
              </label>
            </div>
          </div>
        )}
      </div>

      {/* Output Handle (right) */}
      <Handle
        type="source"
        position={Position.Right}
        className="w-3.5 h-3.5 bg-emerald-400 border-2 border-gray-900 rounded-full !-right-2 shadow-[0_0_8px_rgba(16,185,129,0.8)]"
      />
    </div>
  );
}
