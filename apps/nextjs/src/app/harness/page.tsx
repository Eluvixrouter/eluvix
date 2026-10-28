"use client";

import { Suspense } from 'react';
import { useSearchParams } from 'next/navigation';
import Link from 'next/link';
import HarnessWorkbench from '@/components/harness/HarnessWorkbench';

function HarnessStudioContent() {
  const searchParams = useSearchParams();
  const initialSessionId = searchParams.get('session') || undefined;
  const initialKind = searchParams.get('kind') || 'opencode';
  const initialEndpoint = searchParams.get('endpoint') || undefined;
  const initialAgentId = searchParams.get('agent') || undefined;
  const initialNodeId = searchParams.get('node') || undefined;

  return (
    <div className="w-full h-screen flex flex-col bg-slate-950 text-slate-100 overflow-hidden font-sans">
      <header className="px-6 py-3 border-b border-slate-800 bg-slate-900/95 flex justify-between items-center shrink-0">
        <div className="flex items-center gap-3">
          <Link
            href="/editor"
            className="text-xs font-semibold text-slate-300 hover:text-indigo-300 bg-slate-800 hover:bg-slate-700 px-3 py-1.5 rounded-lg border border-slate-700 transition flex items-center gap-1.5"
          >
            <span>←</span>
            <span>Node Editor</span>
          </Link>
          <div className="h-4 w-px bg-slate-700" />
          <div className="flex items-center gap-2">
            <span className="text-xl">⚙️</span>
            <div>
              <h1 className="text-sm font-bold text-slate-100 flex items-center gap-2">
                Multi-Harness Deep Conversation Studio
                <span className="bg-indigo-500/20 text-indigo-300 border border-indigo-500/30 text-[10px] font-mono px-2 py-0.5 rounded-full">
                  OpenCode Fork · TrueForge · Aider · SWE-agent · Cline · Plandex
                </span>
              </h1>
              <p className="text-[11px] text-slate-400">
                Persistent multi-turn agent trajectories with Switchyard per-step tiering, KV prefix pinning &amp; mid-loop DLP.
              </p>
            </div>
          </div>
        </div>

        <div className="flex items-center gap-2">
          <Link
            href="/playground"
            className="text-xs bg-slate-800 hover:bg-slate-700 text-emerald-300 px-3 py-1.5 rounded-lg border border-slate-700 transition"
          >
            🧪 Playground
          </Link>
          <Link
            href="/observability"
            className="text-xs bg-slate-800 hover:bg-slate-700 text-purple-300 px-3 py-1.5 rounded-lg border border-slate-700 transition"
          >
            📊 Observability
          </Link>
          <Link
            href="/"
            className="text-xs bg-slate-800 hover:bg-slate-700 text-slate-200 px-3 py-1.5 rounded-lg border border-slate-700 transition"
          >
            ⚡ Dashboard
          </Link>
        </div>
      </header>

      <div className="flex-1 min-h-0">
        <HarnessWorkbench
          variant="fullscreen"
          initialKind={initialKind}
          initialEndpoint={initialEndpoint}
          initialAgentId={initialAgentId}
          initialNodeId={initialNodeId}
          initialSessionId={initialSessionId}
        />
      </div>
    </div>
  );
}

export default function HarnessStudioPage() {
  return (
    <Suspense
      fallback={
        <div className="w-full h-screen flex items-center justify-center bg-slate-950 text-slate-400 font-mono text-sm">
          Loading Eluvix Harness Studio...
        </div>
      }
    >
      <HarnessStudioContent />
    </Suspense>
  );
}
