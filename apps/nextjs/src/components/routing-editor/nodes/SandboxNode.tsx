"use client";

import { useState, useCallback, useRef, useEffect } from 'react';
import { Handle, Position, useReactFlow } from '@xyflow/react';

export default function SandboxNode({ id, data }: { id: string; data: any }) {
  const { setNodes } = useReactFlow();
  const [runtime, setRuntime] = useState(data?.runtime || 'docker-local');
  const [endpoint, setEndpoint] = useState(data?.endpoint || 'http://localhost:3986');
  const [image, setImage] = useState(data?.image || 'python:3.12-slim');
  const [networkPolicy, setNetworkPolicy] = useState(data?.networkPolicy || 'none');
  const [timeoutSec, setTimeoutSec] = useState(data?.timeoutSec ?? 30);
  const [memoryLimitMb, setMemoryLimitMb] = useState(data?.memoryLimitMb ?? 512);

  useEffect(() => {
    if (data?.runtime !== undefined) setRuntime(data.runtime);
    if (data?.endpoint !== undefined) setEndpoint(data.endpoint);
    if (data?.image !== undefined) setImage(data.image);
    if (data?.networkPolicy !== undefined) setNetworkPolicy(data.networkPolicy);
    if (data?.timeoutSec !== undefined) setTimeoutSec(data.timeoutSec);
    if (data?.memoryLimitMb !== undefined) setMemoryLimitMb(data.memoryLimitMb);
  }, [data?.runtime, data?.endpoint, data?.image, data?.networkPolicy, data?.timeoutSec, data?.memoryLimitMb]);

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
    <div className="bg-gray-900 border-2 border-teal-500 rounded-lg p-3.5 min-w-[280px] max-w-[320px] shadow-2xl transition hover:shadow-teal-500/10">
      <Handle type="target" position={Position.Left} className="w-3.5 h-3.5 bg-teal-500 -left-2" />

      <div className="flex items-center justify-between pb-2 mb-2 border-b border-gray-800">
        <div className="flex items-center gap-1.5">
          <span className="text-lg">📦</span>
          <div>
            <div className="font-bold text-teal-400 text-sm">Code Execution Sandbox</div>
            <div className="text-[10px] text-gray-400 font-mono">Docker / Daytona / E2B</div>
          </div>
        </div>
        <span className="text-[10px] bg-teal-500/20 text-teal-300 px-1.5 py-0.5 rounded font-mono uppercase">
          {runtime}
        </span>
      </div>

      <div className="text-xs text-gray-300 space-y-2.5">
        <div className="grid grid-cols-2 gap-2">
          <div>
            <label className="block text-[10px] font-semibold text-gray-400 mb-1">Runtime Engine</label>
            <select
              className="nodrag w-full bg-gray-950 border border-gray-700 focus:border-teal-500 rounded p-1.5 text-white text-[11px] outline-none"
              value={runtime}
              onChange={(e) => {
                const next = e.target.value;
                setRuntime(next);
                syncData({ runtime: next });
              }}
            >
              <option value="docker-local">Local Container (:3986)</option>
              <option value="daytona">Daytona Workspace</option>
              <option value="e2b">E2B Code Sandbox</option>
            </select>
          </div>
          <div>
            <label className="block text-[10px] font-semibold text-gray-400 mb-1">Network Egress</label>
            <select
              className="nodrag w-full bg-gray-950 border border-gray-700 focus:border-teal-500 rounded p-1.5 text-white text-[11px] outline-none"
              value={networkPolicy}
              onChange={(e) => {
                setNetworkPolicy(e.target.value);
                syncData({ networkPolicy: e.target.value });
              }}
            >
              <option value="none">🔒 Air-Gapped (None)</option>
              <option value="local-only">🏠 Local LAN Only</option>
              <option value="bridge">🌐 Bridge Network</option>
            </select>
          </div>
        </div>

        <div>
          <label className="block text-[10px] font-semibold text-gray-400 mb-1">Sandbox Endpoint</label>
          <input
            type="text"
            className="nodrag w-full bg-gray-950 border border-gray-700 focus:border-teal-500 rounded p-1.5 text-white text-[11px] font-mono outline-none"
            value={endpoint}
            onChange={(e) => {
              setEndpoint(e.target.value);
              syncData({ endpoint: e.target.value });
            }}
          />
        </div>

        <div className="grid grid-cols-3 gap-2">
          <div>
            <label className="block text-[10px] font-semibold text-gray-400 mb-1">Base Image</label>
            <input
              type="text"
              className="nodrag w-full bg-gray-950 border border-gray-700 focus:border-teal-500 rounded p-1.5 text-white text-[10px] font-mono outline-none"
              value={image}
              onChange={(e) => {
                setImage(e.target.value);
                syncData({ image: e.target.value });
              }}
            />
          </div>
          <div>
            <label className="block text-[10px] font-semibold text-gray-400 mb-1">Timeout (s)</label>
            <input
              type="number"
              className="nodrag w-full bg-gray-950 border border-gray-700 focus:border-teal-500 rounded p-1.5 text-white text-[11px] font-mono outline-none"
              value={timeoutSec}
              onChange={(e) => {
                const v = Math.max(1, parseInt(e.target.value || '30', 10));
                setTimeoutSec(v);
                syncData({ timeoutSec: v });
              }}
            />
          </div>
          <div>
            <label className="block text-[10px] font-semibold text-gray-400 mb-1">RAM (MB)</label>
            <input
              type="number"
              className="nodrag w-full bg-gray-950 border border-gray-700 focus:border-teal-500 rounded p-1.5 text-white text-[11px] font-mono outline-none"
              value={memoryLimitMb}
              onChange={(e) => {
                const v = Math.max(64, parseInt(e.target.value || '512', 10));
                setMemoryLimitMb(v);
                syncData({ memoryLimitMb: v });
              }}
            />
          </div>
        </div>
      </div>

      <Handle type="source" position={Position.Right} className="w-3.5 h-3.5 bg-teal-500 -right-2" />
    </div>
  );
}
