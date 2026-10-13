'use client';

import { useState, useEffect } from 'react';
import Link from 'next/link';
import { MockupDashboard } from '@/components/mockup/MockupDashboard';
import { MockupEditor } from '@/components/mockup/MockupEditor';
import { MockupPlayground } from '@/components/mockup/MockupPlayground';
import { MockupObservability } from '@/components/mockup/MockupObservability';
import { MockupConfigurator } from '@/components/mockup/MockupConfigurator';
import { MockupProvider } from '@/components/mockup/MockupProvider';

type AppTab = 'dashboard' | 'editor' | 'playground' | 'observability' | 'configurator' | 'provider';

const TABS: { id: AppTab; label: string; icon: string; badge?: string }[] = [
  { id: 'dashboard', label: 'Dashboard & Upstreams', icon: '🎛️' },
  { id: 'editor', label: 'Visual Flow Editor', icon: '⚡', badge: '12 Presets' },
  { id: 'playground', label: 'Chat Playground', icon: '💬', badge: 'PII Shield' },
  { id: 'observability', label: 'Observability & Traces', icon: '📊' },
  { id: 'configurator', label: 'Client Configurator', icon: '⚙️' },
  { id: 'provider', label: 'GPU Provider Mode', icon: '⛏️', badge: 'RTX 4090' },
];

export default function AppMockupPage() {
  const [activeTab, setActiveTab] = useState<AppTab>('dashboard');

  // Handle URL hash on mount (e.g. /app#editor or /app#playground)
  useEffect(() => {
    if (typeof window !== 'undefined') {
      const hash = window.location.hash.replace('#', '') as AppTab;
      if (TABS.some((t) => t.id === hash)) {
        setActiveTab(hash);
      }
    }
  }, []);

  function handleSelectTab(tabId: AppTab) {
    setActiveTab(tabId);
    if (typeof window !== 'undefined') {
      window.history.replaceState(null, '', `#${tabId}`);
    }
  }

  return (
    <div className="container mx-auto px-4 md:px-6 py-6 space-y-6">
      {/* Top Simulator Header Banner */}
      <div className="flex flex-col md:flex-row md:items-center justify-between p-4 rounded-2xl border border-sky-500/30 bg-gradient-to-r from-sky-950/40 via-slate-900/60 to-slate-950/80 shadow-[0_0_30px_rgba(56,189,248,0.1)] gap-4">
        <div className="flex items-center gap-3">
          <span className="text-2xl">⚡</span>
          <div>
            <div className="flex items-center gap-2">
              <h1 className="text-base font-bold text-white">
                Eluvix Application Suite (Live Interactive Simulator)
              </h1>
              <span className="rounded-full bg-emerald-500/20 px-2 py-0.5 text-[10px] font-mono font-bold text-emerald-400 border border-emerald-500/30 flex items-center gap-1">
                <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse" />
                SIMULATOR LIVE
              </span>
            </div>
            <p className="text-xs text-slate-400 mt-0.5">
              Experience the entire Eluvix system directly in your browser. All tabs are interactive with zero installation required.
            </p>
          </div>
        </div>

        <div className="flex items-center gap-3 text-xs">
          <div className="flex items-center gap-2 px-3 py-1.5 rounded-xl bg-slate-900 border border-slate-800 font-mono text-slate-300">
            <span className="w-2 h-2 rounded-full bg-emerald-400" />
            <span>PROXY: 127.0.0.1:3000</span>
          </div>
          <Link
            href="/docs/getting-started"
            className="px-3.5 py-1.5 rounded-xl bg-slate-800 hover:bg-slate-700 text-slate-200 font-semibold transition"
          >
            Installation Docs ➔
          </Link>
        </div>
      </div>

      {/* Main Tab Navigation Bar */}
      <div className="flex items-center gap-1.5 overflow-x-auto pb-1 border-b border-slate-800/80 scrollbar-none">
        {TABS.map((tab) => {
          const isSelected = activeTab === tab.id;
          return (
            <button
              key={tab.id}
              type="button"
              onClick={() => handleSelectTab(tab.id)}
              className={`flex items-center gap-2 px-4 py-2.5 rounded-xl text-xs font-semibold whitespace-nowrap transition-all ${
                isSelected
                  ? 'bg-sky-500 text-slate-950 font-bold shadow-[0_0_15px_rgba(56,189,248,0.25)]'
                  : 'bg-slate-900/40 text-slate-400 hover:text-white hover:bg-slate-800/60'
              }`}
            >
              <span>{tab.icon}</span>
              <span>{tab.label}</span>
              {tab.badge && (
                <span className={`text-[10px] font-mono px-1.5 py-0.2 rounded font-semibold ${
                  isSelected
                    ? 'bg-slate-950 text-sky-300'
                    : 'bg-slate-800 text-slate-400'
                }`}>
                  {tab.badge}
                </span>
              )}
            </button>
          );
        })}
      </div>

      {/* Active Tab Content Render */}
      <div className="animate-in fade-in duration-150">
        {activeTab === 'dashboard' && <MockupDashboard />}
        {activeTab === 'editor' && <MockupEditor />}
        {activeTab === 'playground' && <MockupPlayground />}
        {activeTab === 'observability' && <MockupObservability />}
        {activeTab === 'configurator' && <MockupConfigurator />}
        {activeTab === 'provider' && <MockupProvider />}
      </div>
    </div>
  );
}
