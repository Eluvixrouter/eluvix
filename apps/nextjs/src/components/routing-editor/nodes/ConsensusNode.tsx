"use client";

import { useState, useCallback, useRef, useEffect } from 'react';
import { Handle, Position, useReactFlow } from '@xyflow/react';

export default function ConsensusNode({ id, data }: { id: string; data: any }) {
  const { setNodes } = useReactFlow();
  const [strategy, setStrategy] = useState(data?.strategy || 'judge-synthesize');
  const [judgeModel, setJudgeModel] = useState(data?.judgeModel || 'auto');
  const [minQuorum, setMinQuorum] = useState(data?.minQuorum ?? 2);

  useEffect(() => {
    if (data?.strategy !== undefined) setStrategy(data.strategy);
    if (data?.judgeModel !== undefined) setJudgeModel(data.judgeModel);
    if (data?.minQuorum !== undefined) setMinQuorum(data.minQuorum);
  }, [data?.strategy, data?.judgeModel, data?.minQuorum]);

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
    <div className="bg-gray-900 border-2 border-amber-500 rounded-lg p-3.5 min-w-[270px] max-w-[310px] shadow-2xl transition hover:shadow-amber-500/10">
      <Handle type="target" position={Position.Left} className="w-3.5 h-3.5 bg-amber-500 -left-2" />

      <div className="flex items-center justify-between pb-2 mb-2 border-b border-gray-800">
        <div className="flex items-center gap-1.5">
          <span className="text-lg">🤝</span>
          <div>
            <div className="font-bold text-amber-400 text-sm">Multi-Agent Consensus</div>
            <div className="text-[10px] text-gray-400 font-mono">Mixture-of-Agents / Judge / Hedged</div>
          </div>
        </div>
        <span className="text-[10px] bg-amber-500/20 text-amber-300 px-1.5 py-0.5 rounded font-mono uppercase">
          MoA
        </span>
      </div>

      <div className="text-xs text-gray-300 space-y-2.5">
        <div>
          <label className="block text-[10px] font-semibold text-gray-400 mb-1">Consensus Strategy</label>
          <select
            className="nodrag w-full bg-gray-950 border border-gray-700 focus:border-amber-500 rounded p-1.5 text-white text-[11px] outline-none"
            value={strategy}
            onChange={(e) => {
              setStrategy(e.target.value);
              syncData({ strategy: e.target.value });
            }}
          >
            <option value="judge-synthesize">⚖️ Judge Synthesis (MoA)</option>
            <option value="majority-vote">🗳️ Majority Similarity Vote</option>
            <option value="fastest-first">🏎️ Fastest-First (Hedged Race)</option>
          </select>
        </div>

        <div className="grid grid-cols-2 gap-2">
          <div>
            <label className="block text-[10px] font-semibold text-gray-400 mb-1">Judge Model</label>
            <input
              type="text"
              className="nodrag w-full bg-gray-950 border border-gray-700 focus:border-amber-500 rounded p-1.5 text-white text-[11px] font-mono outline-none"
              value={judgeModel}
              onChange={(e) => {
                setJudgeModel(e.target.value);
                syncData({ judgeModel: e.target.value });
              }}
            />
          </div>
          <div>
            <label className="block text-[10px] font-semibold text-gray-400 mb-1">Min Quorum</label>
            <input
              type="number"
              min="1"
              max="5"
              className="nodrag w-full bg-gray-950 border border-gray-700 focus:border-amber-500 rounded p-1.5 text-white text-[11px] font-mono outline-none"
              value={minQuorum}
              onChange={(e) => {
                const v = Math.max(1, parseInt(e.target.value || '2', 10));
                setMinQuorum(v);
                syncData({ minQuorum: v });
              }}
            />
          </div>
        </div>
      </div>

      <Handle type="source" position={Position.Right} className="w-3.5 h-3.5 bg-amber-500 -right-2" />
    </div>
  );
}
