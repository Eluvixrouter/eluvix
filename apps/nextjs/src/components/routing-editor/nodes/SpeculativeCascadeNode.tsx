"use client";

import { useState, useCallback, useRef, useEffect } from 'react';
import { Handle, Position, useReactFlow } from '@xyflow/react';

export default function SpeculativeCascadeNode({ id, data }: { id: string; data: any }) {
  const { setNodes } = useReactFlow();
  const [confidenceThreshold, setConfidenceThreshold] = useState<number>(
    typeof data?.confidenceThreshold === 'number' ? data.confidenceThreshold : 0.78
  );
  const [maxDraftLatencyMs, setMaxDraftLatencyMs] = useState<number>(
    typeof data?.maxDraftLatencyMs === 'number' ? data.maxDraftLatencyMs : 2500
  );
  const [validateJsonSchema, setValidateJsonSchema] = useState<boolean>(
    data?.validateJsonSchema !== false
  );
  const [validateCodeFences, setValidateCodeFences] = useState<boolean>(
    data?.validateCodeFences !== false
  );
  const [shadowSampleRate, setShadowSampleRate] = useState<number>(
    typeof data?.shadowSampleRate === 'number' ? data.shadowSampleRate : 0.05
  );

  // Keep local editable state in sync when the node data reference changes
  // (layout load, undo/redo, decompile). Adjusting state during render is the
  // React-sanctioned replacement for a resync effect: React discards this
  // render and re-renders with the new state before committing.
  const [prevData, setPrevData] = useState(data);
  if (data !== prevData) {
    setPrevData(data);
    if (data) {
      if (typeof data?.confidenceThreshold === 'number') setConfidenceThreshold(data.confidenceThreshold);
      if (typeof data?.maxDraftLatencyMs === 'number') setMaxDraftLatencyMs(data.maxDraftLatencyMs);
      if (data?.validateJsonSchema !== undefined) setValidateJsonSchema(data.validateJsonSchema !== false);
      if (data?.validateCodeFences !== undefined) setValidateCodeFences(data.validateCodeFences !== false);
      if (typeof data?.shadowSampleRate === 'number') setShadowSampleRate(data.shadowSampleRate);
    }
  }

  const dataRef = useRef(data);
  // Keep the ref current after render; assigning it during render is what
  // react-hooks/refs forbids.
  useEffect(() => {
    dataRef.current = data;
  });

  const syncData = useCallback(
    (updated: Record<string, any>) => {
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
    <div className="bg-gray-900 border-2 border-emerald-500 rounded-lg p-3.5 min-w-[285px] max-w-[330px] shadow-2xl transition hover:shadow-emerald-500/15">
      <Handle
        type="target"
        position={Position.Left}
        className="w-3.5 h-3.5 bg-emerald-500 -left-2"
      />

      <div className="flex items-center justify-between pb-2 mb-2 border-b border-gray-800">
        <div className="flex items-center gap-1.5">
          <span className="text-lg">⚡</span>
          <div>
            <div className="font-bold text-emerald-400 text-sm">Speculative Cascade</div>
            <div className="text-[10px] text-gray-400 font-mono">
              Buffer-Verify $0 Draft ➔ Frontier
            </div>
          </div>
        </div>
        <span className="text-[10px] bg-emerald-500/20 text-emerald-300 px-1.5 py-0.5 rounded font-mono uppercase">
          Cascade
        </span>
      </div>

      <div className="text-xs text-gray-300 space-y-2.5">
        <div>
          <div className="flex items-center justify-between text-[10px] font-semibold text-gray-400 mb-1">
            <span>Confidence Gate</span>
            <span className="font-mono text-emerald-300">{Math.round(confidenceThreshold * 100)}%</span>
          </div>
          <input
            type="range"
            min="0.50"
            max="0.98"
            step="0.02"
            value={confidenceThreshold}
            onChange={(e) => {
              const v = parseFloat(e.target.value);
              setConfidenceThreshold(v);
              syncData({ confidenceThreshold: v });
            }}
            className="nodrag w-full accent-emerald-500 cursor-pointer"
          />
        </div>

        <div className="grid grid-cols-2 gap-2">
          <div>
            <label className="block text-[10px] font-semibold text-gray-400 mb-1">
              Draft Budget (ms)
            </label>
            <input
              type="number"
              min="250"
              max="15000"
              step="250"
              value={maxDraftLatencyMs}
              onChange={(e) => {
                const v = Math.max(250, parseInt(e.target.value || '2500', 10));
                setMaxDraftLatencyMs(v);
                syncData({ maxDraftLatencyMs: v });
              }}
              className="nodrag w-full bg-gray-950 border border-gray-700 focus:border-emerald-500 rounded p-1.5 text-white text-[11px] font-mono outline-none"
            />
          </div>
          <div>
            <label className="block text-[10px] font-semibold text-gray-400 mb-1">
              Shadow Distill
            </label>
            <select
              value={String(shadowSampleRate)}
              onChange={(e) => {
                const v = parseFloat(e.target.value);
                setShadowSampleRate(v);
                syncData({ shadowSampleRate: v });
              }}
              className="nodrag w-full bg-gray-950 border border-gray-700 focus:border-amber-500 rounded p-1.5 text-white text-[11px] font-mono outline-none"
            >
              <option value="0">Off (0%)</option>
              <option value="0.05">5% Sample</option>
              <option value="0.1">10% Sample</option>
              <option value="0.25">25% Sample</option>
              <option value="1">100% Mirror</option>
            </select>
          </div>
        </div>

        <div className="flex items-center justify-between gap-2 pt-1 text-[10px] text-gray-300">
          <label className="flex items-center gap-1.5 cursor-pointer">
            <input
              type="checkbox"
              checked={validateJsonSchema}
              onChange={(e) => {
                setValidateJsonSchema(e.target.checked);
                syncData({ validateJsonSchema: e.target.checked });
              }}
              className="nodrag rounded bg-gray-950 border-gray-700 accent-emerald-500"
            />
            <span>JSON Schema Gate</span>
          </label>
          <label className="flex items-center gap-1.5 cursor-pointer">
            <input
              type="checkbox"
              checked={validateCodeFences}
              onChange={(e) => {
                setValidateCodeFences(e.target.checked);
                syncData({ validateCodeFences: e.target.checked });
              }}
              className="nodrag rounded bg-gray-950 border-gray-700 accent-emerald-500"
            />
            <span>Code Fence Gate</span>
          </label>
        </div>

        <div className="pt-1.5 border-t border-gray-800 space-y-1.5 font-mono text-[10px]">
          <div className="relative flex items-center justify-between px-2 py-1 rounded bg-emerald-950/40 border border-emerald-700/40 text-emerald-300">
            <span>#draft ($0 Local Buffer)</span>
            <Handle
              type="source"
              position={Position.Right}
              id="draft"
              className="w-3 h-3 bg-emerald-400 -right-2"
              title="#draft ($0 Local Fast Model)"
            />
          </div>
          <div className="relative flex items-center justify-between px-2 py-1 rounded bg-sky-950/40 border border-sky-700/40 text-sky-300">
            <span>#verifier (Frontier Escalate)</span>
            <Handle
              type="source"
              position={Position.Right}
              id="verifier"
              className="w-3 h-3 bg-sky-400 -right-2"
              title="#verifier (Frontier Verifier)"
            />
          </div>
          <div className="relative flex items-center justify-between px-2 py-1 rounded bg-amber-950/40 border border-amber-700/40 text-amber-300">
            <span>#shadow-student (DPO/SFT)</span>
            <Handle
              type="source"
              position={Position.Right}
              id="shadow-student"
              className="w-3 h-3 bg-amber-400 -right-2"
              title="#shadow-student (Async Shadow Student)"
            />
          </div>
        </div>
      </div>
    </div>
  );
}
