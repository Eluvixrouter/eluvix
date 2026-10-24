"use client";

import { useState, useCallback, useRef, useEffect } from 'react';
import { Handle, Position, useReactFlow } from '@xyflow/react';

export default function KnowledgeBaseNode({ id, data }: { id: string; data: any }) {
  const { setNodes } = useReactFlow();
  const [backend, setBackend] = useState(data?.backend || 'openviking-resources');
  const [collectionUri, setCollectionUri] = useState(data?.collectionUri || 'viking://resources/repo-docs');
  const [topK, setTopK] = useState(data?.topK ?? 4);
  const [maxTokens, setMaxTokens] = useState(data?.maxTokens ?? 1000);
  const [citationMode, setCitationMode] = useState(data?.citationMode || 'inline-uris');

  useEffect(() => {
    if (data?.backend !== undefined) setBackend(data.backend);
    if (data?.collectionUri !== undefined) setCollectionUri(data.collectionUri);
    if (data?.topK !== undefined) setTopK(data.topK);
    if (data?.maxTokens !== undefined) setMaxTokens(data.maxTokens);
    if (data?.citationMode !== undefined) setCitationMode(data.citationMode);
  }, [data?.backend, data?.collectionUri, data?.topK, data?.maxTokens, data?.citationMode]);

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
    <div className="bg-gray-900 border-2 border-sky-500 rounded-lg p-3.5 min-w-[280px] max-w-[320px] shadow-2xl transition hover:shadow-sky-500/10">
      <Handle type="target" position={Position.Left} className="w-3.5 h-3.5 bg-sky-500 -left-2" />

      <div className="flex items-center justify-between pb-2 mb-2 border-b border-gray-800">
        <div className="flex items-center gap-1.5">
          <span className="text-lg">📚</span>
          <div>
            <div className="font-bold text-sky-400 text-sm">Knowledge Base &amp; RAG</div>
            <div className="text-[10px] text-gray-400 font-mono">OpenViking Resources / LightRAG / FTS5</div>
          </div>
        </div>
        <span className="text-[10px] bg-sky-500/20 text-sky-300 px-1.5 py-0.5 rounded font-mono uppercase">
          RAG
        </span>
      </div>

      <div className="text-xs text-gray-300 space-y-2.5">
        <div className="grid grid-cols-2 gap-2">
          <div>
            <label className="block text-[10px] font-semibold text-gray-400 mb-1">Index Backend</label>
            <select
              className="nodrag w-full bg-gray-950 border border-gray-700 focus:border-sky-500 rounded p-1.5 text-white text-[11px] outline-none"
              value={backend}
              onChange={(e) => {
                const next = e.target.value;
                const defaultEp =
                  next === 'openviking-resources'
                    ? 'http://localhost:1933'
                    : next === 'lightrag'
                    ? 'http://localhost:9621'
                    : '';
                setBackend(next);
                syncData({ backend: next, ...(defaultEp ? { endpoint: defaultEp } : {}) });
              }}
            >
              <option value="openviking-resources">OpenViking (:1933)</option>
              <option value="lightrag">LightRAG (:9621)</option>
              <option value="local-fts">SQLite Local FTS5</option>
            </select>
          </div>
          <div>
            <label className="block text-[10px] font-semibold text-gray-400 mb-1">Citations</label>
            <select
              className="nodrag w-full bg-gray-950 border border-gray-700 focus:border-sky-500 rounded p-1.5 text-white text-[11px] outline-none"
              value={citationMode}
              onChange={(e) => {
                setCitationMode(e.target.value);
                syncData({ citationMode: e.target.value });
              }}
            >
              <option value="inline-uris">Inline Source URIs</option>
              <option value="silent">Silent Context</option>
            </select>
          </div>
        </div>

        <div>
          <label className="block text-[10px] font-semibold text-gray-400 mb-1">Collection URI / Namespace</label>
          <input
            type="text"
            className="nodrag w-full bg-gray-950 border border-gray-700 focus:border-sky-500 rounded p-1.5 text-white text-[11px] font-mono outline-none"
            value={collectionUri}
            onChange={(e) => {
              setCollectionUri(e.target.value);
              syncData({ collectionUri: e.target.value });
            }}
          />
        </div>

        <div className="grid grid-cols-2 gap-2">
          <div>
            <label className="block text-[10px] font-semibold text-gray-400 mb-1">Top-K Chunks</label>
            <input
              type="number"
              className="nodrag w-full bg-gray-950 border border-gray-700 focus:border-sky-500 rounded p-1.5 text-white text-[11px] font-mono outline-none"
              value={topK}
              onChange={(e) => {
                const v = Math.max(1, Math.min(20, parseInt(e.target.value || '4', 10)));
                setTopK(v);
                syncData({ topK: v });
              }}
            />
          </div>
          <div>
            <label className="block text-[10px] font-semibold text-gray-400 mb-1">Max Budget (tok)</label>
            <input
              type="number"
              className="nodrag w-full bg-gray-950 border border-gray-700 focus:border-sky-500 rounded p-1.5 text-white text-[11px] font-mono outline-none"
              value={maxTokens}
              onChange={(e) => {
                const v = Math.max(100, parseInt(e.target.value || '1000', 10));
                setMaxTokens(v);
                syncData({ maxTokens: v });
              }}
            />
          </div>
        </div>
      </div>

      <Handle type="source" position={Position.Right} className="w-3.5 h-3.5 bg-sky-500 -right-2" />
    </div>
  );
}
