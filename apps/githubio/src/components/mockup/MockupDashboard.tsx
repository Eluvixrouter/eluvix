'use client';

import { useState } from 'react';
import { MockUpstream, INITIAL_UPSTREAMS, INITIAL_DOCKER_SERVICES, MockDockerContainer } from './mockup-data';

export function MockupDashboard() {
  const [upstreams, setUpstreams] = useState<MockUpstream[]>(INITIAL_UPSTREAMS);
  const [fallbackStrategy, setFallbackStrategy] = useState<'priority' | 'round-robin'>('priority');
  const [dockerServices, setDockerServices] = useState<MockDockerContainer[]>(INITIAL_DOCKER_SERVICES);
  const [pingingId, setPingingId] = useState<string | null>(null);
  const [toastMessage, setToastMessage] = useState<string | null>(null);

  function showToast(msg: string) {
    setToastMessage(msg);
    setTimeout(() => setToastMessage(null), 3000);
  }

  function handleToggleUpstream(id: string) {
    setUpstreams((prev) =>
      prev.map((u) => (u.id === id ? { ...u, enabled: !u.enabled } : u))
    );
    showToast('Upstream configuration updated');
  }

  function handlePriorityChange(id: string, newPriority: number) {
    setUpstreams((prev) =>
      prev.map((u) => (u.id === id ? { ...u, priority: newPriority } : u))
    );
  }

  function handlePing(id: string) {
    setPingingId(id);
    setTimeout(() => {
      setPingingId(null);
      showToast(`Health check 200 OK: Node responded in ~14ms`);
    }, 500);
  }

  function handleToggleDocker(name: string) {
    setDockerServices((prev) =>
      prev.map((s) => (s.name === name ? { ...s, running: !s.running } : s))
    );
    const target = dockerServices.find((s) => s.name === name);
    showToast(`Container ${name} ${target?.running ? 'stopped' : 'started'}`);
  }

  const enabledCount = upstreams.filter((u) => u.enabled).length;
  const localCount = upstreams.filter((u) => u.costPer1k === 0).length;

  return (
    <div className="space-y-6">
      {/* Toast Notification */}
      {toastMessage && (
        <div className="fixed bottom-6 right-6 z-50 rounded-xl border border-sky-500/50 bg-slate-900/95 px-4 py-2.5 text-xs font-semibold text-sky-300 shadow-xl backdrop-blur">
          ✓ {toastMessage}
        </div>
      )}

      {/* Gateway Status & High-level Metrics */}
      <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
        <div className="p-4 rounded-xl border border-slate-800 bg-slate-900/70">
          <div className="text-[11px] font-mono text-slate-400 uppercase tracking-wider">Gateway Port</div>
          <div className="text-xl font-black text-white mt-1 flex items-center gap-2">
            <span>127.0.0.1:3588</span>
            <span className="w-2.5 h-2.5 rounded-full bg-emerald-400 animate-pulse" />
          </div>
          <div className="text-[11px] text-emerald-400 mt-1">OpenAI API Compatible • Online</div>
        </div>

        <div className="p-4 rounded-xl border border-slate-800 bg-slate-900/70">
          <div className="text-[11px] font-mono text-slate-400 uppercase tracking-wider">Active Upstreams</div>
          <div className="text-xl font-black text-white mt-1">{enabledCount} / {upstreams.length}</div>
          <div className="text-[11px] text-sky-400 mt-1">{localCount} zero-cost local engines</div>
        </div>

        <div className="p-4 rounded-xl border border-slate-800 bg-slate-900/70">
          <div className="text-[11px] font-mono text-slate-400 uppercase tracking-wider">Routing Strategy</div>
          <div className="flex items-center gap-2 mt-2">
            <button
              type="button"
              onClick={() => { setFallbackStrategy('priority'); showToast('Switched to Priority Fallback mode'); }}
              className={`px-2.5 py-1 rounded text-xs font-semibold transition ${
                fallbackStrategy === 'priority'
                  ? 'bg-sky-500 text-slate-950 shadow-sm'
                  : 'bg-slate-800 text-slate-400 hover:text-white'
              }`}
            >
              Priority
            </button>
            <button
              type="button"
              onClick={() => { setFallbackStrategy('round-robin'); showToast('Switched to Round-Robin mode'); }}
              className={`px-2.5 py-1 rounded text-xs font-semibold transition ${
                fallbackStrategy === 'round-robin'
                  ? 'bg-sky-500 text-slate-950 shadow-sm'
                  : 'bg-slate-800 text-slate-400 hover:text-white'
              }`}
            >
              Round-Robin
            </button>
          </div>
        </div>

        <div className="p-4 rounded-xl border border-emerald-500/30 bg-emerald-950/20">
          <div className="text-[11px] font-mono text-emerald-400 uppercase tracking-wider">Local Workload Ratio</div>
          <div className="text-xl font-black text-emerald-400 mt-1">88.4%</div>
          <div className="text-[11px] text-slate-400 mt-1">Average compute cost: $0.0000/req</div>
        </div>
      </div>

      {/* Upstreams Management Section */}
      <div className="rounded-2xl border border-slate-800 bg-slate-900/50 p-5">
        <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between pb-4 border-b border-slate-800/80 gap-3">
          <div>
            <h2 className="text-sm font-bold text-white flex items-center gap-2">
              <span>🔌 Upstream Engines &amp; Local Gateways</span>
              <span className="text-[10px] font-mono px-2 py-0.5 rounded bg-slate-800 text-slate-300">
                Sorted by Execution Priority
              </span>
            </h2>
            <p className="text-xs text-slate-400 mt-0.5">
              Eluvix queries local hardware first, falling back to lower-priority or cloud providers only when necessary.
            </p>
          </div>

          <button
            type="button"
            onClick={() => showToast('Simulated dialog: "New Upstream Endpoint" wizard')}
            className="px-3 py-1.5 rounded-lg bg-sky-500/10 hover:bg-sky-500/20 border border-sky-500/30 text-xs font-semibold text-sky-400 transition"
          >
            + Add Upstream
          </button>
        </div>

        <div className="grid grid-cols-1 gap-3.5 mt-4">
          {[...upstreams]
            .sort((a, b) => b.priority - a.priority)
            .map((u) => {
              const isPinging = pingingId === u.id;
              const isZeroCost = u.costPer1k === 0;

              return (
                <div
                  key={u.id}
                  className={`rounded-xl border p-4 transition-all ${
                    u.enabled
                      ? 'border-slate-800/90 bg-slate-950/60 hover:border-slate-700'
                      : 'border-slate-850 bg-slate-950/20 opacity-60'
                  }`}
                >
                  <div className="flex flex-col md:flex-row md:items-center justify-between gap-3">
                    {/* Left: Name, Badges, Endpoint */}
                    <div className="space-y-1">
                      <div className="flex items-center gap-2.5">
                        <span className="font-bold text-sm text-white">{u.name}</span>
                        <span className="text-[10px] font-mono px-2 py-0.5 rounded font-semibold bg-slate-800 text-slate-300 uppercase">
                          {u.type}
                        </span>
                        {isZeroCost ? (
                          <span className="text-[10px] font-mono px-2 py-0.5 rounded font-bold bg-emerald-500/20 text-emerald-400 border border-emerald-500/30">
                            $0.00 / 1k (Local)
                          </span>
                        ) : (
                          <span className="text-[10px] font-mono px-2 py-0.5 rounded font-semibold bg-amber-500/10 text-amber-400 border border-amber-500/20">
                            ${u.costPer1k.toFixed(5)} / 1k (Cloud)
                          </span>
                        )}
                      </div>

                      <div className="flex items-center gap-3 text-xs font-mono text-slate-400">
                        <span>{u.endpoint}</span>
                        <span>•</span>
                        <span className="text-emerald-400">{u.latencyMs}ms ping</span>
                      </div>
                    </div>

                    {/* Right: Controls & Toggles */}
                    <div className="flex items-center gap-3 self-end md:self-center">
                      <button
                        type="button"
                        onClick={() => handlePing(u.id)}
                        disabled={isPinging}
                        className="px-2.5 py-1 rounded bg-slate-800 hover:bg-slate-700 text-slate-300 text-xs font-medium transition"
                      >
                        {isPinging ? 'Pinging...' : 'Test Health'}
                      </button>

                      <div className="flex items-center gap-1.5 text-xs text-slate-300">
                        <span className="text-[11px] text-slate-400 font-mono">Priority:</span>
                        <input
                          type="number"
                          value={u.priority}
                          onChange={(e) => handlePriorityChange(u.id, parseInt(e.target.value) || 0)}
                          className="w-12 rounded border border-slate-700 bg-slate-900 px-1.5 py-0.5 text-center text-xs font-bold text-white focus:outline-none focus:border-sky-500"
                        />
                      </div>

                      <label className="relative inline-flex items-center cursor-pointer">
                        <input
                          type="checkbox"
                          checked={u.enabled}
                          onChange={() => handleToggleUpstream(u.id)}
                          className="sr-only peer"
                        />
                        <div className="w-9 h-5 bg-slate-800 peer-focus:outline-none rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:border-slate-300 after:border after:rounded-full after:h-4 after:w-4 after:transition-all peer-checked:bg-sky-500" />
                      </label>
                    </div>
                  </div>

                  {/* Models supported tags */}
                  <div className="flex flex-wrap items-center gap-1.5 pt-3 mt-3 border-t border-slate-900 text-xs">
                    <span className="text-[11px] text-slate-400 font-mono">Models:</span>
                    {u.models.map((m) => (
                      <span
                        key={m}
                        className="rounded px-2 py-0.5 text-[11px] font-mono bg-slate-900/90 text-slate-300 border border-slate-800"
                      >
                        {m}
                      </span>
                    ))}
                  </div>
                </div>
              );
            })}
        </div>
      </div>

      {/* Docker Engine Containers Simulator */}
      <div className="rounded-2xl border border-slate-800 bg-slate-900/50 p-5">
        <div className="flex items-center justify-between pb-3 border-b border-slate-800/80">
          <div>
            <h3 className="text-sm font-bold text-white flex items-center gap-2">
              <span>🐳 Local Docker Microservices</span>
              <span className="text-[10px] font-mono px-2 py-0.5 rounded bg-emerald-500/10 text-emerald-400 border border-emerald-500/20">
                Docker Daemon Connected
              </span>
            </h3>
            <p className="text-xs text-slate-400 mt-0.5">
              Manage containerized LLM inference engines with one click.
            </p>
          </div>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3.5 mt-4">
          {dockerServices.map((svc) => (
            <div
              key={svc.name}
              className="rounded-xl border border-slate-800 bg-slate-950/60 p-3.5 space-y-2.5"
            >
              <div className="flex items-center justify-between">
                <span className="text-xs font-bold text-white">{svc.service}</span>
                <span
                  className={`text-[10px] font-mono px-2 py-0.5 rounded font-semibold ${
                    svc.running
                      ? 'bg-emerald-500/20 text-emerald-400'
                      : 'bg-slate-800 text-slate-400'
                  }`}
                >
                  {svc.running ? 'Running' : 'Stopped'}
                </span>
              </div>

              <div className="text-[11px] font-mono text-slate-400 space-y-0.5">
                <div>Port: <strong className="text-slate-300">{svc.port}</strong></div>
                <div className="truncate" title={svc.image}>Img: {svc.image}</div>
              </div>

              <button
                type="button"
                onClick={() => handleToggleDocker(svc.name)}
                className={`w-full py-1 rounded text-xs font-semibold transition ${
                  svc.running
                    ? 'bg-red-500/10 hover:bg-red-500/20 text-red-400 border border-red-500/20'
                    : 'bg-emerald-500/10 hover:bg-emerald-500/20 text-emerald-400 border border-emerald-500/20'
                }`}
              >
                {svc.running ? 'Stop Container' : 'Start Container'}
              </button>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
