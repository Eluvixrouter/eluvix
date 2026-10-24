"use client";

import { useState, useCallback, useRef, useEffect } from 'react';
import { Handle, Position, useReactFlow } from '@xyflow/react';

export default function FallbackChainNode({ id, data }: { id: string; data: any }) {
  const { setNodes } = useReactFlow();
  const [failureThreshold, setFailureThreshold] = useState(data?.failureThreshold ?? 3);
  const [cooldownSeconds, setCooldownSeconds] = useState(data?.cooldownSeconds ?? 60);
  const [retryOn429, setRetryOn429] = useState(data?.retryOn429 !== false);

  useEffect(() => {
    if (data?.failureThreshold !== undefined) setFailureThreshold(data.failureThreshold);
    if (data?.cooldownSeconds !== undefined) setCooldownSeconds(data.cooldownSeconds);
    if (data?.retryOn429 !== undefined) setRetryOn429(data.retryOn429 !== false);
  }, [data?.failureThreshold, data?.cooldownSeconds, data?.retryOn429]);

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
    <div className="bg-gray-900 border-2 border-rose-500 rounded-lg p-3.5 min-w-[270px] max-w-[310px] shadow-2xl transition hover:shadow-rose-500/10 relative">
      <Handle type="target" position={Position.Left} className="w-3.5 h-3.5 bg-rose-500 -left-2" />

      <div className="flex items-center justify-between pb-2 mb-2 border-b border-gray-800">
        <div className="flex items-center gap-1.5">
          <span className="text-lg">🔁</span>
          <div>
            <div className="font-bold text-rose-400 text-sm">Failover &amp; Circuit Breaker</div>
            <div className="text-[10px] text-gray-400 font-mono">Primary → Secondary → Emergency</div>
          </div>
        </div>
        <span className="text-[10px] bg-rose-500/20 text-rose-300 px-1.5 py-0.5 rounded font-mono uppercase">
          CB
        </span>
      </div>

      <div className="text-xs text-gray-300 space-y-2.5 pr-4">
        <div className="grid grid-cols-2 gap-2">
          <div>
            <label className="block text-[10px] font-semibold text-gray-400 mb-1">Trip After Failures</label>
            <input
              type="number"
              min="1"
              max="20"
              className="nodrag w-full bg-gray-950 border border-gray-700 focus:border-rose-500 rounded p-1.5 text-white text-[11px] font-mono outline-none"
              value={failureThreshold}
              onChange={(e) => {
                const v = Math.max(1, parseInt(e.target.value || '3', 10));
                setFailureThreshold(v);
                syncData({ failureThreshold: v });
              }}
            />
          </div>
          <div>
            <label className="block text-[10px] font-semibold text-gray-400 mb-1">Cooldown (sec)</label>
            <input
              type="number"
              min="5"
              className="nodrag w-full bg-gray-950 border border-gray-700 focus:border-rose-500 rounded p-1.5 text-white text-[11px] font-mono outline-none"
              value={cooldownSeconds}
              onChange={(e) => {
                const v = Math.max(5, parseInt(e.target.value || '60', 10));
                setCooldownSeconds(v);
                syncData({ cooldownSeconds: v });
              }}
            />
          </div>
        </div>

        <label className="flex items-center gap-1.5 cursor-pointer text-[11px] bg-gray-950/80 p-2 rounded border border-gray-800">
          <input
            type="checkbox"
            checked={retryOn429}
            onChange={(e) => {
              setRetryOn429(e.target.checked);
              syncData({ retryOn429: e.target.checked });
            }}
            className="accent-rose-500"
          />
          <span>Instant Failover on HTTP 429</span>
        </label>

        <div className="flex justify-between text-[10px] font-mono text-gray-400 pt-1">
          <span className="text-emerald-400">1: Primary</span>
          <span className="text-amber-400">2: Backup</span>
          <span className="text-rose-400">3: Local</span>
        </div>
      </div>

      <Handle
        type="source"
        position={Position.Right}
        id="primary"
        style={{ top: '32%' }}
        className="w-3.5 h-3.5 bg-emerald-500 -right-2"
      />
      <Handle
        type="source"
        position={Position.Right}
        id="secondary"
        style={{ top: '56%' }}
        className="w-3.5 h-3.5 bg-amber-500 -right-2"
      />
      <Handle
        type="source"
        position={Position.Right}
        id="tertiary"
        style={{ top: '80%' }}
        className="w-3.5 h-3.5 bg-rose-500 -right-2"
      />
    </div>
  );
}
