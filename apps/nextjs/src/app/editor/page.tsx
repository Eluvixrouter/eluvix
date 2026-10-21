'use client';

import { useState, useEffect } from 'react';
import RoutingEditor from '@/components/routing-editor/RoutingEditor';
import Link from 'next/link';

export default function RoutingEditorPage() {
  const [baseUrl, setBaseUrl] = useState('http://localhost:3588');
  const [layoutsDir, setLayoutsDir] = useState('~/.config/eluvix/layouts');

  useEffect(() => {
    if (typeof window !== 'undefined') {
      setBaseUrl(window.location.origin);
      fetch('/api/v1/layouts')
        .then((res) => res.json())
        .then((data) => {
          if (data?.layoutsDir) setLayoutsDir(data.layoutsDir);
        })
        .catch(() => {});
    }
  }, []);
  return (
    <div className="w-full h-screen flex flex-col bg-slate-950 text-slate-100 overflow-hidden font-sans">
      {/* Top Navigation Bar */}
      <header className="px-6 py-3.5 border-b border-slate-800 bg-slate-900/90 flex justify-between items-center z-20">
        <div className="flex items-center gap-4">
          <Link
            href="/"
            className="flex items-center gap-1.5 text-xs font-semibold text-slate-400 hover:text-sky-400 bg-slate-800/80 hover:bg-slate-800 px-3 py-1.5 rounded-lg border border-slate-700 transition"
          >
            <span>←</span> Upstream Settings
          </Link>
          <div className="h-4 w-px bg-slate-700" />
          <div className="flex items-center gap-2">
            <span className="text-xl">⚡</span>
            <div>
              <h1 className="text-sm font-bold text-slate-100 flex items-center gap-2">
                Visual Node Routing Editor
                <span className="bg-sky-500/10 text-sky-400 border border-sky-500/30 text-[10px] font-mono px-2 py-0.5 rounded-full">
                  Eluvix v0.1
                </span>
              </h1>
              <p className="text-[11px] text-slate-400">
                Drag, connect, and compile execution graphs using Switchyard, Semantic Router, and Gateways.
              </p>
            </div>
          </div>
        </div>

        <div className="flex items-center gap-2">
          <div className="hidden xl:flex items-center gap-1.5 px-3 py-1 rounded-full bg-slate-800/80 border border-slate-700/80 text-[11px] text-slate-300 font-mono" title={`Layouts directory: ${layoutsDir}`}>
            <span>📁</span>
            <span className="max-w-[200px] truncate">{layoutsDir}</span>
          </div>
          <div className="hidden md:flex items-center gap-2 px-3 py-1 rounded-full bg-emerald-950/60 border border-emerald-600/40 text-[11px] text-emerald-400">
            <span className="w-2 h-2 rounded-full bg-emerald-400 animate-pulse" />
            <span>Proxy Active: {baseUrl}/api/v1</span>
          </div>
          <Link
            href="/playground"
            className="bg-emerald-600/20 hover:bg-emerald-600 text-emerald-300 hover:text-white border border-emerald-500/40 font-semibold text-xs px-3 py-1.5 rounded-lg transition flex items-center gap-1.5"
          >
            <span>🧪</span> Playground
          </Link>
          <Link
            href="/observability"
            className="bg-purple-600/20 hover:bg-purple-600 text-purple-300 hover:text-white border border-purple-500/40 font-semibold text-xs px-3 py-1.5 rounded-lg transition flex items-center gap-1.5"
          >
            <span>📊</span> Observability
          </Link>
          <Link
            href="/configurator"
            className="bg-sky-600/20 hover:bg-sky-600 text-sky-300 hover:text-white border border-sky-500/40 font-semibold text-xs px-3 py-1.5 rounded-lg transition flex items-center gap-1.5"
          >
            <span>⚙️</span> Configurator
          </Link>
          <Link
            href="/"
            className="bg-slate-800 hover:bg-slate-700 text-slate-200 font-medium text-xs px-3 py-1.5 rounded-lg transition border border-slate-700 flex items-center gap-1"
          >
            <span>⚡</span> Settings
          </Link>
        </div>
      </header>

      {/* Visual Canvas Area */}
      <div className="flex-1 relative w-full min-h-0">
        <RoutingEditor />
      </div>
    </div>
  );
}
