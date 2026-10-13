"use client";

import { Handle, Position } from '@xyflow/react';

export default function InputNode() {
  return (
    <div className="bg-gradient-to-br from-emerald-950/40 via-slate-900/90 to-slate-900 border-2 border-emerald-500/80 rounded-xl p-3.5 min-w-[200px] shadow-2xl transition hover:shadow-emerald-500/10 hover:border-emerald-400">
      <div className="flex items-center justify-between pb-2 mb-2 border-b border-slate-800">
        <div className="flex items-center gap-2">
          <span className="text-xl">📥</span>
          <div>
            <div className="font-bold text-emerald-400 text-sm flex items-center gap-1.5">
              <span>User Input</span>
            </div>
            <div className="text-[10px] text-slate-400 font-mono">Client Ingress • OpenAI API</div>
          </div>
        </div>
        <span className="text-[9px] bg-emerald-500/20 text-emerald-300 border border-emerald-500/40 px-1.5 py-0.5 rounded font-mono">
          Ingress
        </span>
      </div>
      <div className="text-xs text-slate-300 flex items-center justify-between">
        <span>Entrypoint Stream</span>
        <span className="text-[10px] text-emerald-400 font-mono">/v1/chat/completions</span>
      </div>
      <Handle type="source" position={Position.Right} className="bg-emerald-500" />
    </div>
  );
}
