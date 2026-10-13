'use client';

import { useState } from 'react';

interface MockJob {
  id: string;
  timestamp: string;
  model: string;
  tokens: number;
  durationMs: number;
  earnedUsd: string;
}

export function MockupProvider() {
  const [pricingMode, setPricingMode] = useState<'market' | 'floor'>('market');
  const [floorPriceIn, setFloorPriceIn] = useState<number>(0.25);
  const [floorPriceOut, setFloorPriceOut] = useState<number>(0.50);
  const [pauseOnUser, setPauseOnUser] = useState<boolean>(true);
  const [isServing, setIsServing] = useState<boolean>(true);
  const [earnedTotal, setEarnedTotal] = useState<number>(42.85);

  const [jobs, setJobs] = useState<MockJob[]>([
    { id: 'job_4891', timestamp: '11:42:04', model: 'meta-llama/Llama-3-8b', tokens: 1240, durationMs: 42, earnedUsd: '$0.00031' },
    { id: 'job_4890', timestamp: '11:41:49', model: 'qwen2.5-coder:7b', tokens: 2410, durationMs: 88, earnedUsd: '$0.00060' },
    { id: 'job_4889', timestamp: '11:41:31', model: 'mistral:latest', tokens: 980, durationMs: 34, earnedUsd: '$0.00025' },
    { id: 'job_4888', timestamp: '11:41:05', model: 'meta-llama/Llama-3-8b', tokens: 3200, durationMs: 110, earnedUsd: '$0.00080' },
  ]);

  function handleSimulateJob() {
    const newJob: MockJob = {
      id: 'job_' + Math.floor(1000 + Math.random() * 9000),
      timestamp: new Date().toLocaleTimeString(),
      model: 'meta-llama/Llama-3-8b',
      tokens: Math.floor(800 + Math.random() * 2500),
      durationMs: Math.floor(30 + Math.random() * 60),
      earnedUsd: '$0.000' + Math.floor(20 + Math.random() * 60),
    };
    setJobs((prev) => [newJob, ...prev.slice(0, 5)]);
    setEarnedTotal((prev) => parseFloat((prev + 0.00045).toFixed(4)));
  }

  return (
    <div className="space-y-6">
      {/* Hardware Telemetry & Network Status */}
      <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
        <div className="p-4 rounded-xl border border-slate-800 bg-slate-900/70">
          <div className="text-[11px] font-mono text-slate-400 uppercase tracking-wider">GPU Silicon</div>
          <div className="text-sm font-bold text-white mt-1">NVIDIA RTX 4090</div>
          <div className="text-[11px] text-emerald-400 mt-1 font-mono">24GB VRAM • 64°C • 245W</div>
        </div>

        <div className="p-4 rounded-xl border border-slate-800 bg-slate-900/70">
          <div className="text-[11px] font-mono text-slate-400 uppercase tracking-wider">Node Status</div>
          <div className="text-sm font-bold text-white mt-1 flex items-center gap-2">
            <span>{isServing ? 'SERVING JOBS' : 'PAUSED'}</span>
            <span className={`w-2.5 h-2.5 rounded-full ${isServing ? 'bg-emerald-400 animate-pulse' : 'bg-amber-400'}`} />
          </div>
          <div className="text-[11px] text-sky-400 mt-1 font-mono">Reputation: 99.4% (Tier 1)</div>
        </div>

        <div className="p-4 rounded-xl border border-slate-800 bg-slate-900/70">
          <div className="text-[11px] font-mono text-slate-400 uppercase tracking-wider">Completed Jobs</div>
          <div className="text-2xl font-black text-white mt-1">1,482</div>
          <div className="text-[11px] text-slate-400 mt-1">3.4M tokens served</div>
        </div>

        <div className="p-4 rounded-xl border border-emerald-500/30 bg-emerald-950/20">
          <div className="text-[11px] font-mono text-emerald-400 uppercase tracking-wider">Total Earned (USD)</div>
          <div className="text-2xl font-black text-emerald-400 mt-1">${earnedTotal.toFixed(2)}</div>
          <div className="text-[11px] text-emerald-400 mt-1">Payout via Billama Mesh</div>
        </div>
      </div>

      {/* Provider Controls & Configuration */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* Left 2 Cols: Jobs Feed */}
        <div className="lg:col-span-2 rounded-2xl border border-slate-800 bg-slate-950/80 p-5 space-y-4">
          <div className="flex items-center justify-between pb-3 border-b border-slate-800/80">
            <div>
              <h3 className="text-sm font-bold text-white flex items-center gap-2">
                <span>⛏️ Live Distributed Compute Jobs</span>
                <span className="text-[10px] font-mono px-2 py-0.5 rounded bg-emerald-500/10 text-emerald-400">
                  P2P Mesh Connected
                </span>
              </h3>
              <p className="text-xs text-slate-400 mt-0.5">
                Batch inference requests dispatched to your GPU when idle.
              </p>
            </div>

            <button
              type="button"
              onClick={handleSimulateJob}
              className="px-3 py-1.5 rounded-lg bg-sky-500/20 hover:bg-sky-500/30 border border-sky-500/30 text-xs font-semibold text-sky-400 transition"
            >
              + Simulate Job
            </button>
          </div>

          <div className="divide-y divide-slate-850">
            {jobs.map((job) => (
              <div key={job.id} className="py-3 flex items-center justify-between text-xs font-mono">
                <div className="space-y-0.5">
                  <div className="flex items-center gap-2">
                    <span className="font-bold text-white">{job.id}</span>
                    <span className="text-slate-400">{job.model}</span>
                  </div>
                  <div className="text-[11px] text-slate-500">
                    {job.tokens} tokens • completed in {job.durationMs}ms at {job.timestamp}
                  </div>
                </div>

                <div className="text-right">
                  <div className="font-bold text-emerald-400">{job.earnedUsd}</div>
                  <div className="text-[10px] text-slate-400 font-semibold">PAID</div>
                </div>
              </div>
            ))}
          </div>
        </div>

        {/* Right Col: Pricing & Governance Settings */}
        <div className="rounded-2xl border border-slate-800 bg-slate-900/70 p-5 space-y-4">
          <div className="pb-3 border-b border-slate-800">
            <h4 className="text-xs font-mono uppercase tracking-wider text-slate-400 font-bold">
              Worker Node Policies
            </h4>
            <div className="text-sm font-bold text-white mt-1">Autonomous Monetization</div>
          </div>

          <div className="space-y-3.5 text-xs">
            <div>
              <label className="text-[11px] font-mono text-slate-400 uppercase">Pricing Engine</label>
              <div className="grid grid-cols-2 gap-2 mt-1.5">
                <button
                  type="button"
                  onClick={() => setPricingMode('market')}
                  className={`py-1.5 rounded-lg font-semibold transition ${
                    pricingMode === 'market'
                      ? 'bg-sky-500 text-slate-950 shadow-sm'
                      : 'bg-slate-950 border border-slate-800 text-slate-400 hover:text-white'
                  }`}
                >
                  Market Dynamic
                </button>
                <button
                  type="button"
                  onClick={() => setPricingMode('floor')}
                  className={`py-1.5 rounded-lg font-semibold transition ${
                    pricingMode === 'floor'
                      ? 'bg-sky-500 text-slate-950 shadow-sm'
                      : 'bg-slate-950 border border-slate-800 text-slate-400 hover:text-white'
                  }`}
                >
                  Floor Price
                </button>
              </div>
            </div>

            {pricingMode === 'floor' && (
              <div className="p-3 rounded-xl bg-slate-950 border border-slate-800 space-y-2">
                <div className="flex items-center justify-between text-[11px] font-mono">
                  <span className="text-slate-400">Prompt Floor ($/1M):</span>
                  <span className="text-white">${floorPriceIn.toFixed(2)}</span>
                </div>
                <input
                  type="range"
                  min="0.10"
                  max="1.50"
                  step="0.05"
                  value={floorPriceIn}
                  onChange={(e) => setFloorPriceIn(parseFloat(e.target.value))}
                  className="w-full"
                />

                <div className="flex items-center justify-between text-[11px] font-mono pt-1">
                  <span className="text-slate-400">Completion Floor ($/1M):</span>
                  <span className="text-white">${floorPriceOut.toFixed(2)}</span>
                </div>
                <input
                  type="range"
                  min="0.20"
                  max="3.00"
                  step="0.10"
                  value={floorPriceOut}
                  onChange={(e) => setFloorPriceOut(parseFloat(e.target.value))}
                  className="w-full"
                />
              </div>
            )}

            <div className="p-3 rounded-xl bg-slate-950 border border-slate-800 space-y-2">
              <div className="flex items-center justify-between">
                <span className="text-slate-300 font-semibold">User Preemption Guard</span>
                <input
                  type="checkbox"
                  checked={pauseOnUser}
                  onChange={(e) => setPauseOnUser(e.target.checked)}
                  className="rounded text-sky-500"
                />
              </div>
              <p className="text-[11px] text-slate-400">
                Instantly pauses background worker batch jobs when you type a personal prompt or run local software.
              </p>
            </div>

            <button
              type="button"
              onClick={() => setIsServing(!isServing)}
              className={`w-full py-2 rounded-xl text-xs font-bold transition ${
                isServing
                  ? 'bg-amber-500/20 hover:bg-amber-500/30 text-amber-400 border border-amber-500/30'
                  : 'bg-emerald-500 hover:bg-emerald-400 text-slate-950 shadow-md'
              }`}
            >
              {isServing ? 'Pause Worker Daemon' : 'Resume Serving'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
