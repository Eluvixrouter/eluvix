"use client";

import { useState, useCallback, useRef, useEffect } from 'react';
import { Handle, Position, useReactFlow } from '@xyflow/react';

export default function MemoryNode({ id, data }: { id: string; data: any }) {
  const { updateNodeData } = useReactFlow();
  const [provider, setProvider] = useState(data?.provider || 'builtin');
  const [endpoint, setEndpoint] = useState(
    data?.endpoint || (data?.provider === 'mem0' ? 'http://localhost:8888' : 'http://localhost:1933')
  );
  const [recallBudgetTokens, setRecallBudgetTokens] = useState(data?.recallBudgetTokens ?? 600);
  const [readingLevel, setReadingLevel] = useState(data?.readingLevel || 'L1');
  const [writeBack, setWriteBack] = useState(data?.writeBack !== false);
  const [allowCloudEgress, setAllowCloudEgress] = useState(Boolean(data?.allowCloudEgress));
  const [cloudMode, setCloudMode] = useState(data?.cloudMode || 'filter');

  useEffect(() => {
    if (data?.provider !== undefined) setProvider(data.provider);
    if (data?.endpoint !== undefined) setEndpoint(data.endpoint);
    if (data?.recallBudgetTokens !== undefined) setRecallBudgetTokens(data.recallBudgetTokens);
    if (data?.readingLevel !== undefined) setReadingLevel(data.readingLevel);
    if (data?.writeBack !== undefined) setWriteBack(data.writeBack !== false);
    if (data?.allowCloudEgress !== undefined) setAllowCloudEgress(Boolean(data.allowCloudEgress));
    if (data?.cloudMode !== undefined) setCloudMode(data.cloudMode);
  }, [
    data?.provider,
    data?.endpoint,
    data?.recallBudgetTokens,
    data?.readingLevel,
    data?.writeBack,
    data?.allowCloudEgress,
    data?.cloudMode
  ]);

  const dataRef = useRef(data);
  dataRef.current = data;

  const syncData = useCallback(
    (updated: any) => {
      if (dataRef.current) {
        Object.assign(dataRef.current, updated);
      }
      if (id) {
        updateNodeData(id, updated);
      }
    },
    [id, updateNodeData]
  );

  return (
    <div className="bg-gray-900 border-2 border-purple-500 rounded-lg p-3.5 min-w-[280px] max-w-[320px] shadow-2xl transition hover:shadow-purple-500/10">
      <Handle type="target" position={Position.Left} className="w-3.5 h-3.5 bg-purple-500 -left-2" />

      <div className="flex items-center justify-between pb-2 mb-2 border-b border-gray-800">
        <div className="flex items-center gap-1.5">
          <span className="text-lg">🧠</span>
          <div>
            <div className="font-bold text-purple-400 text-sm">Context &amp; Memory Engine</div>
            <div className="text-[10px] text-gray-400 font-mono">OpenViking / Graphiti / LightRAG / Mem0</div>
          </div>
        </div>
        <span className="text-[10px] bg-purple-500/20 text-purple-300 px-1.5 py-0.5 rounded font-mono uppercase">
          {provider}
        </span>
      </div>

      <div className="text-xs text-gray-300 space-y-2.5">
        <div className="grid grid-cols-2 gap-2">
          <div>
            <label className="block text-[10px] font-semibold text-gray-400 mb-1">Provider</label>
            <select
              className="nodrag w-full bg-gray-950 border border-gray-700 focus:border-purple-500 rounded p-1.5 text-white text-[11px] outline-none"
              value={provider}
              onChange={(e) => {
                const next = e.target.value;
                const defaultUrl =
                  next === 'openviking'
                    ? 'http://localhost:1933'
                    : next === 'mem0'
                    ? 'http://localhost:8888'
                    : next === 'graphiti'
                    ? 'http://localhost:8004'
                    : next === 'lightrag'
                    ? 'http://localhost:9621'
                    : next === 'cognee'
                    ? 'http://localhost:8005'
                    : next === 'supermemory'
                    ? 'http://localhost:6767'
                    : '';
                setProvider(next);
                if (defaultUrl) setEndpoint(defaultUrl);
                syncData({ provider: next, ...(defaultUrl ? { endpoint: defaultUrl } : {}) });
              }}
            >
              <option value="builtin">SQLite Builtin (Zero-Dep)</option>
              <option value="openviking">OpenViking (:1933)</option>
              <option value="graphiti">Graphiti Temporal Graph (:8004)</option>
              <option value="lightrag">LightRAG Hybrid Graph (:9621)</option>
              <option value="mem0">Mem0 REST (:8888)</option>
              <option value="cognee">Cognee ECL Graph (:8005)</option>
              <option value="supermemory">Supermemory (:6767)</option>
            </select>
          </div>
          <div>
            <label className="block text-[10px] font-semibold text-gray-400 mb-1">Tier Depth</label>
            <select
              className="nodrag w-full bg-gray-950 border border-gray-700 focus:border-purple-500 rounded p-1.5 text-white text-[11px] outline-none"
              value={readingLevel}
              onChange={(e) => {
                setReadingLevel(e.target.value);
                syncData({ readingLevel: e.target.value });
              }}
            >
              <option value="L0">L0 Abstract (~100 tok)</option>
              <option value="L1">L1 Overview (~600 tok)</option>
              <option value="L2">L2 Full Details</option>
            </select>
          </div>
        </div>

        {provider !== 'builtin' && (
          <div>
            <label className="block text-[10px] font-semibold text-gray-400 mb-1">Endpoint URL</label>
            <input
              type="text"
              className="nodrag w-full bg-gray-950 border border-gray-700 focus:border-purple-500 rounded p-1.5 text-white text-[11px] font-mono outline-none"
              value={endpoint}
              onChange={(e) => {
                setEndpoint(e.target.value);
                syncData({ endpoint: e.target.value });
              }}
            />
          </div>
        )}

        <div className="grid grid-cols-2 gap-2">
          <div>
            <label className="block text-[10px] font-semibold text-gray-400 mb-1">Recall Budget (tok)</label>
            <input
              type="number"
              className="nodrag w-full bg-gray-950 border border-gray-700 focus:border-purple-500 rounded p-1.5 text-white text-[11px] font-mono outline-none"
              value={recallBudgetTokens}
              onChange={(e) => {
                const v = Math.max(100, parseInt(e.target.value || '600', 10));
                setRecallBudgetTokens(v);
                syncData({ recallBudgetTokens: v });
              }}
            />
          </div>
          <div>
            <label className="block text-[10px] font-semibold text-gray-400 mb-1">Cloud Egress Guard</label>
            <select
              className="nodrag w-full bg-gray-950 border border-gray-700 focus:border-purple-500 rounded p-1.5 text-white text-[11px] outline-none"
              value={allowCloudEgress ? 'allow' : cloudMode}
              onChange={(e) => {
                const v = e.target.value;
                if (v === 'allow') {
                  setAllowCloudEgress(true);
                  syncData({ allowCloudEgress: true });
                } else {
                  setAllowCloudEgress(false);
                  setCloudMode(v);
                  syncData({ allowCloudEgress: false, cloudMode: v });
                }
              }}
            >
              <option value="filter">🔒 Local-Only (Filter Cloud)</option>
              <option value="strip">✂️ Strip Memory for Cloud</option>
              <option value="allow">☁️ Allow Cloud Egress</option>
            </select>
          </div>
        </div>

        <label className="flex items-center gap-1.5 cursor-pointer text-[11px] bg-gray-950/80 p-2 rounded border border-gray-800">
          <input
            type="checkbox"
            checked={writeBack}
            onChange={(e) => {
              setWriteBack(e.target.checked);
              syncData({ writeBack: e.target.checked });
            }}
            className="accent-purple-500"
          />
          <span>Async Write-Back &amp; Session Auto-Commit</span>
        </label>
      </div>

      <Handle type="source" position={Position.Right} className="w-3.5 h-3.5 bg-purple-500 -right-2" />
    </div>
  );
}
