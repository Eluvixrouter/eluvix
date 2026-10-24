"use client";

import { useState, useCallback, useRef, useEffect } from 'react';
import { Handle, Position, useReactFlow } from '@xyflow/react';

export default function SemanticCacheNode({ id, data }: { id: string; data: any }) {
  const { setNodes } = useReactFlow();
  const [mode, setMode] = useState(data?.mode || 'semantic');
  const [similarityThreshold, setSimilarityThreshold] = useState(data?.similarityThreshold ?? 0.92);
  const [scopeIsolation, setScopeIsolation] = useState(data?.scopeIsolation || 'user');
  const [ttlSeconds, setTtlSeconds] = useState(data?.ttlSeconds ?? 3600);
  const [bypassOnTools, setBypassOnTools] = useState(data?.bypassOnTools !== false);

  useEffect(() => {
    if (data?.mode !== undefined) setMode(data.mode);
    if (data?.similarityThreshold !== undefined) setSimilarityThreshold(data.similarityThreshold);
    if (data?.scopeIsolation !== undefined) setScopeIsolation(data.scopeIsolation);
    if (data?.ttlSeconds !== undefined) setTtlSeconds(data.ttlSeconds);
    if (data?.bypassOnTools !== undefined) setBypassOnTools(data.bypassOnTools !== false);
  }, [data?.mode, data?.similarityThreshold, data?.scopeIsolation, data?.ttlSeconds, data?.bypassOnTools]);

  const dataRef = useRef(data);
  dataRef.current = data;

  const syncData = useCallback(
    (updated: any) => {
      if (dataRef.current) {
        Object.assign(dataRef.current, updated);
      }
      if (id) {
        setNodes((nds) =>
          nds.map((node) => (node.id === id ? { ...node, data: { ...node.data, ...updated } } : node))
        );
      }
      dataRef.current?.onChange?.();
    },
    [id, setNodes]
  );

  return (
    <div className="bg-gray-900 border-2 border-emerald-500 rounded-lg p-3.5 min-w-[270px] max-w-[310px] shadow-2xl transition hover:shadow-emerald-500/10">
      <Handle type="target" position={Position.Left} className="w-3.5 h-3.5 bg-emerald-500 -left-2" />

      <div className="flex items-center justify-between pb-2 mb-2 border-b border-gray-800">
        <div className="flex items-center gap-1.5">
          <span className="text-lg">⚡</span>
          <div>
            <div className="font-bold text-emerald-400 text-sm">Semantic Response Cache</div>
            <div className="text-[10px] text-gray-400 font-mono">Scoped Exact + Similarity Cache</div>
          </div>
        </div>
        <span className="text-[10px] bg-emerald-500/20 text-emerald-300 px-1.5 py-0.5 rounded font-mono uppercase">
          {mode}
        </span>
      </div>

      <div className="text-xs text-gray-300 space-y-2.5">
        <div className="grid grid-cols-2 gap-2">
          <div>
            <label className="block text-[10px] font-semibold text-gray-400 mb-1">Match Mode</label>
            <select
              className="nodrag w-full bg-gray-950 border border-gray-700 focus:border-emerald-500 rounded p-1.5 text-white text-[11px] outline-none"
              value={mode}
              onChange={(e) => {
                setMode(e.target.value);
                syncData({ mode: e.target.value });
              }}
            >
              <option value="semantic">Semantic Similarity</option>
              <option value="exact">Exact Hash Match</option>
            </select>
          </div>
          <div>
            <label className="block text-[10px] font-semibold text-gray-400 mb-1">Scope Isolation</label>
            <select
              className="nodrag w-full bg-gray-950 border border-gray-700 focus:border-emerald-500 rounded p-1.5 text-white text-[11px] outline-none"
              value={scopeIsolation}
              onChange={(e) => {
                setScopeIsolation(e.target.value);
                syncData({ scopeIsolation: e.target.value });
              }}
            >
              <option value="user">🔒 Per-User + Memory</option>
              <option value="session">💬 Per-Session</option>
              <option value="global">🌐 Global Shared</option>
            </select>
          </div>
        </div>

        <div className="grid grid-cols-2 gap-2">
          <div>
            <label className="block text-[10px] font-semibold text-gray-400 mb-1">Similarity (0-1)</label>
            <input
              type="number"
              step="0.02"
              min="0.5"
              max="1.0"
              className="nodrag w-full bg-gray-950 border border-gray-700 focus:border-emerald-500 rounded p-1.5 text-white text-[11px] font-mono outline-none"
              value={similarityThreshold}
              onChange={(e) => {
                const v = Math.min(1, Math.max(0.5, parseFloat(e.target.value || '0.92')));
                setSimilarityThreshold(v);
                syncData({ similarityThreshold: v });
              }}
            />
          </div>
          <div>
            <label className="block text-[10px] font-semibold text-gray-400 mb-1">TTL (seconds)</label>
            <input
              type="number"
              className="nodrag w-full bg-gray-950 border border-gray-700 focus:border-emerald-500 rounded p-1.5 text-white text-[11px] font-mono outline-none"
              value={ttlSeconds}
              onChange={(e) => {
                const v = Math.max(10, parseInt(e.target.value || '3600', 10));
                setTtlSeconds(v);
                syncData({ ttlSeconds: v });
              }}
            />
          </div>
        </div>

        <label className="flex items-center gap-1.5 cursor-pointer text-[11px] bg-gray-950/80 p-2 rounded border border-gray-800">
          <input
            type="checkbox"
            checked={bypassOnTools}
            onChange={(e) => {
              setBypassOnTools(e.target.checked);
              syncData({ bypassOnTools: e.target.checked });
            }}
            className="accent-emerald-500"
          />
          <span>Bypass Cache on Tool Calls &amp; Harnesses</span>
        </label>
      </div>

      <Handle type="source" position={Position.Right} className="w-3.5 h-3.5 bg-emerald-500 -right-2" />
    </div>
  );
}
