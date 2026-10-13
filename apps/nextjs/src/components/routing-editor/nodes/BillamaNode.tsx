"use client";

import { useState, useEffect, useCallback, useRef } from 'react';
import { Handle, Position, useReactFlow } from '@xyflow/react';

const BILLAMA_DEFAULT_MODELS = [
  'llama-3.3-70b',
  'deepseek-r1',
  'qwen-2.5-72b',
  'mistral-large',
  'llama-3.1-8b',
  '*'
];

export default function BillamaNode({ id, data }: { id: string; data: any }) {
  const { updateNodeData } = useReactFlow();
  const [endpoint, setEndpoint] = useState<string>(data?.endpoint || 'https://api.billama.dev');
  const [apiKey, setApiKey] = useState<string>(data?.apiKey || '');
  const [priority, setPriority] = useState<number>(data?.priority ?? 15);
  const [costPer1kTokens, setCostPer1kTokens] = useState<number>(data?.costPer1kTokens ?? 0.002);
  const [visionCapable, setVisionCapable] = useState<boolean>(data?.visionCapable ?? true);
  const [selectedModel, setSelectedModel] = useState<string>(data?.selectedModel || '*');
  const [models, setModels] = useState<string[]>(
    Array.isArray(data?.models) && data.models.length > 0 ? data.models : BILLAMA_DEFAULT_MODELS
  );
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
          id: id || data?.id || 'billama-cloud',
          name: data?.label || 'Billama Cloud',
          type: 'billama',
          endpoint: targetEndpoint,
          apiKey: targetKey || undefined
        })
      });

      const json = await res.json();
      if (json.success && Array.isArray(json.models) && json.models.length > 0) {
        setModels(json.models);
        setStatus('online');
        syncData({
          endpoint: targetEndpoint,
          apiKey: targetKey,
          models: json.models,
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
      setSelectedModel(customModel || 'custom-model');
      syncData({ selectedModel: customModel || 'custom-model' });
    } else {
      setSelectedModel(val);
      syncData({ selectedModel: val });
    }
  };

  const handleCustomModelAdd = () => {
    if (!customModel.trim()) return;
    const trimmed = customModel.trim();
    if (!models.includes(trimmed)) {
      const updated = [trimmed, ...models];
      setModels(updated);
      setSelectedModel(trimmed);
      syncData({ models: updated, selectedModel: trimmed });
    } else {
      setSelectedModel(trimmed);
      syncData({ selectedModel: trimmed });
    }
  };

  return (
    <div className="bg-gray-900 border-2 border-blue-500/80 rounded-xl p-3.5 min-w-[300px] max-w-[360px] shadow-2xl transition hover:shadow-blue-500/20 hover:border-blue-400">
      {/* Target input handle (left) */}
      <Handle
        type="target"
        position={Position.Left}
        className="w-3.5 h-3.5 bg-blue-400 border-2 border-gray-900 rounded-full !-left-2 shadow-[0_0_8px_rgba(59,130,246,0.8)]"
      />

      {/* Node Header */}
      <div className="flex items-center justify-between pb-2 mb-2.5 border-b border-gray-800">
        <div className="flex items-center gap-2">
          <span className="text-xl">🌟</span>
          <div>
            <div className="font-bold text-blue-300 text-sm flex items-center gap-1.5">
              <span>{data?.label || 'Billama Cloud'}</span>
            </div>
            <div className="text-[10px] text-gray-400 font-mono">Distributed Cloud LLM Grid</div>
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
            <span className="text-[9px] bg-blue-500/20 text-blue-300 border border-blue-500/40 px-1.5 py-0.5 rounded font-mono">
              Cloud
            </span>
          )}
          <button
            type="button"
            onClick={() => detectModels(endpoint, apiKey)}
            title="Probe Billama Cloud endpoint"
            className="nodrag p-1 text-gray-400 hover:text-blue-300 hover:bg-gray-800 rounded transition"
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
          Target Model
        </label>
        <select
          value={models.includes(selectedModel) ? selectedModel : '__custom__'}
          onChange={handleModelSelect}
          className="nodrag w-full bg-gray-950 border border-gray-700 text-white rounded px-2 py-1.5 text-xs focus:outline-none focus:border-blue-400"
        >
          <option value="*">* (All Billama Models / Dynamic)</option>
          {models.filter(m => m !== '*').map(m => (
            <option key={m} value={m}>
              {m}
            </option>
          ))}
          <option value="__custom__">✏️ Custom Model...</option>
        </select>
      </div>

      {/* Custom Model Input when Custom Selected */}
      {(!models.includes(selectedModel) || selectedModel === '__custom__') && (
        <div className="mb-2.5 flex gap-1">
          <input
            type="text"
            value={customModel}
            onChange={(e) => setCustomModel(e.target.value)}
            placeholder="e.g. meta-llama/Llama-3.3-70B-Instruct"
            className="nodrag flex-1 bg-gray-950 border border-blue-500/50 text-white rounded px-2 py-1 text-xs focus:outline-none"
          />
          <button
            type="button"
            onClick={handleCustomModelAdd}
            className="nodrag px-2 py-1 bg-blue-600 hover:bg-blue-500 text-white rounded text-xs font-semibold"
          >
            Set
          </button>
        </div>
      )}

      {/* API Key Field */}
      <div className="mb-2.5">
        <div className="flex items-center justify-between mb-1">
          <label className="text-[11px] font-semibold text-gray-300">
            Billama API Key
          </label>
          <span className="text-[9px] text-gray-500 font-mono">BILLAMA_API_KEY</span>
        </div>
        <input
          type="password"
          value={apiKey}
          onChange={handleApiKeyChange}
          placeholder="sk-bl-... (or system env)"
          className="nodrag w-full bg-gray-950 border border-gray-700 text-white rounded px-2 py-1 text-xs focus:outline-none focus:border-blue-400 font-mono"
        />
      </div>

      {/* Quick Metrics Bar */}
      <div className="grid grid-cols-2 gap-2 text-[10px] text-gray-400 bg-gray-950/60 p-2 rounded border border-gray-800/80 mb-2">
        <div>
          <span className="text-gray-500">Tier: </span>
          <span className="text-blue-300 font-medium">Tier 3 (Cloud)</span>
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
          className="nodrag text-[10px] text-blue-400 hover:text-blue-300 flex items-center gap-1 font-medium transition"
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
                className="nodrag w-full bg-gray-950 border border-gray-700 text-white rounded px-2 py-1 text-xs font-mono focus:outline-none focus:border-blue-400"
              />
            </div>
            <div className="grid grid-cols-2 gap-2">
              <div>
                <label className="block text-[10px] text-gray-400 mb-0.5">Router Priority</label>
                <input
                  type="number"
                  value={priority}
                  onChange={handlePriorityChange}
                  className="nodrag w-full bg-gray-950 border border-gray-700 text-white rounded px-2 py-1 text-xs focus:outline-none focus:border-blue-400"
                />
              </div>
              <div>
                <label className="block text-[10px] text-gray-400 mb-0.5">Cost / 1k Tokens ($)</label>
                <input
                  type="number"
                  step="0.001"
                  value={costPer1kTokens}
                  onChange={handleCostChange}
                  className="nodrag w-full bg-gray-950 border border-gray-700 text-white rounded px-2 py-1 text-xs focus:outline-none focus:border-blue-400"
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
                className="nodrag rounded border-gray-700 text-blue-500 focus:ring-0"
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
        className="w-3.5 h-3.5 bg-blue-400 border-2 border-gray-900 rounded-full !-right-2 shadow-[0_0_8px_rgba(59,130,246,0.8)]"
      />
    </div>
  );
}
