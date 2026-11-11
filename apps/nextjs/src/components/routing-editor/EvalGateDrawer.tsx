"use client";

import { useState } from 'react';
import {
  STARTER_GOLDEN_EVAL_SUITES,
  type EvalRunMode,
  type EvalSuite,
  type EvalSuiteResult,
} from '@eluvix/router-core/eval-types';

export interface EvalGateDrawerProps {
  isOpen: boolean;
  onClose: () => void;
  onRunSuite: (suite: EvalSuite, mode: EvalRunMode) => Promise<EvalSuiteResult | null>;
  running: boolean;
  lastResult: EvalSuiteResult | null;
  verifyBeforeApply: boolean;
  onToggleVerifyBeforeApply: (next: boolean) => void;
}

export default function EvalGateDrawer({
  isOpen,
  onClose,
  onRunSuite,
  running,
  lastResult,
  verifyBeforeApply,
  onToggleVerifyBeforeApply,
}: EvalGateDrawerProps) {
  const [selectedSuiteId, setSelectedSuiteId] = useState<string>(
    STARTER_GOLDEN_EVAL_SUITES[0].id || 'sovereign-safety-and-tiering'
  );
  const [mode, setMode] = useState<EvalRunMode>('dry-run');
  const [showJsonEditor, setShowJsonEditor] = useState<boolean>(false);
  const [customJson, setCustomJson] = useState<string>(() =>
    JSON.stringify(STARTER_GOLDEN_EVAL_SUITES[0], null, 2)
  );
  const [jsonError, setJsonError] = useState<string | null>(null);

  if (!isOpen) return null;

  const activePreset =
    STARTER_GOLDEN_EVAL_SUITES.find((s) => s.id === selectedSuiteId) ||
    STARTER_GOLDEN_EVAL_SUITES[0];

  const handleSelectPreset = (id: string) => {
    setSelectedSuiteId(id);
    const found = STARTER_GOLDEN_EVAL_SUITES.find((s) => s.id === id);
    if (found) {
      setCustomJson(JSON.stringify(found, null, 2));
      setJsonError(null);
    }
  };

  const handleExecute = async () => {
    setJsonError(null);
    let suiteToRun: EvalSuite = activePreset;
    if (showJsonEditor) {
      try {
        const parsed = JSON.parse(customJson);
        if (!parsed || !Array.isArray(parsed.cases) || parsed.cases.length === 0) {
          setJsonError('Suite JSON must contain a non-empty "cases" array.');
          return;
        }
        suiteToRun = parsed as EvalSuite;
      } catch (err: any) {
        setJsonError(err?.message || 'Invalid JSON syntax.');
        return;
      }
    }
    await onRunSuite(suiteToRun, mode);
  };

  return (
    <div className="absolute top-3 right-3 bottom-3 w-[430px] max-w-[calc(100vw-24px)] z-30 bg-slate-950/95 backdrop-blur-md border border-violet-500/40 rounded-2xl shadow-2xl flex flex-col overflow-hidden text-slate-100">
      {/* Header */}
      <div className="px-4 py-3 border-b border-slate-800 bg-gradient-to-r from-violet-950/60 to-slate-900 flex items-center justify-between">
        <div className="flex items-center gap-2">
          <span className="text-lg">🧪</span>
          <div>
            <h3 className="text-xs font-bold uppercase tracking-wider text-violet-200">
              Golden Eval Gate
            </h3>
            <p className="text-[11px] text-slate-400">
              Verify unsaved canvas topology against regression assertions
            </p>
          </div>
        </div>
        <button
          type="button"
          onClick={onClose}
          className="px-2 py-1 rounded-lg text-xs text-slate-400 hover:text-white hover:bg-slate-800 transition"
          aria-label="Close Golden Eval Gate"
        >
          ✕
        </button>
      </div>

      {/* Controls */}
      <div className="p-3.5 border-b border-slate-800/80 space-y-3 bg-slate-900/50">
        <div>
          <label className="block text-[11px] font-semibold text-slate-300 mb-1">
            Golden Eval Suite Template
          </label>
          <select
            value={selectedSuiteId}
            onChange={(e) => handleSelectPreset(e.target.value)}
            className="w-full px-2.5 py-1.5 rounded-lg bg-slate-950 border border-slate-700 text-xs text-slate-100 focus:outline-none focus:border-violet-400"
          >
            {STARTER_GOLDEN_EVAL_SUITES.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name} ({s.cases.length} cases)
              </option>
            ))}
          </select>
          {activePreset.description && (
            <p className="mt-1 text-[11px] text-slate-400 leading-snug">
              {activePreset.description}
            </p>
          )}
        </div>

        <div className="flex items-center justify-between gap-2">
          <div className="inline-flex rounded-lg bg-slate-950 p-0.5 border border-slate-800">
            <button
              type="button"
              onClick={() => setMode('dry-run')}
              className={`px-2.5 py-1 rounded-md text-[11px] font-medium transition ${
                mode === 'dry-run'
                  ? 'bg-emerald-600/30 text-emerald-200 border border-emerald-500/40'
                  : 'text-slate-400 hover:text-slate-200'
              }`}
            >
              $0.00 Dry-Run
            </button>
            <button
              type="button"
              onClick={() => setMode('live')}
              className={`px-2.5 py-1 rounded-md text-[11px] font-medium transition ${
                mode === 'live'
                  ? 'bg-amber-600/30 text-amber-200 border border-amber-500/40'
                  : 'text-slate-400 hover:text-slate-200'
              }`}
            >
              Live Models
            </button>
          </div>

          <button
            type="button"
            onClick={() => setShowJsonEditor((v) => !v)}
            className="text-[11px] text-violet-300 hover:text-violet-200 underline"
          >
            {showJsonEditor ? 'Hide Suite JSON' : 'Edit Suite JSON'}
          </button>
        </div>

        {showJsonEditor && (
          <div>
            <textarea
              value={customJson}
              onChange={(e) => setCustomJson(e.target.value)}
              rows={7}
              spellCheck={false}
              className="w-full p-2 rounded-lg bg-slate-950 border border-slate-700 font-mono text-[11px] text-slate-200 focus:outline-none focus:border-violet-400"
            />
            {jsonError && <p className="mt-1 text-[11px] text-rose-400">{jsonError}</p>}
          </div>
        )}

        <label className="flex items-center justify-between gap-2 px-2.5 py-2 rounded-lg bg-slate-950/80 border border-slate-800 cursor-pointer">
          <div>
            <div className="text-xs font-medium text-slate-200">Verify Before Apply</div>
            <div className="text-[10px] text-slate-400">
              Require $0.00 Golden Eval pass before deploying canvas to live router
            </div>
          </div>
          <input
            type="checkbox"
            checked={verifyBeforeApply}
            onChange={(e) => onToggleVerifyBeforeApply(e.target.checked)}
            className="h-4 w-4 accent-violet-500 rounded"
          />
        </label>

        <button
          type="button"
          disabled={running}
          onClick={handleExecute}
          className="w-full py-2 px-3 rounded-lg text-xs font-semibold bg-violet-600 hover:bg-violet-500 disabled:opacity-50 text-white shadow transition flex items-center justify-center gap-1.5"
        >
          <span>{running ? '⏳' : '▶'}</span>
          <span>
            {running
              ? 'Running Golden Evals...'
              : `Run ${mode === 'dry-run' ? '$0.00 Dry-Run' : 'Live'} Eval Suite`}
          </span>
        </button>
      </div>

      {/* Results Stream */}
      <div className="flex-1 overflow-y-auto p-3.5 space-y-2.5">
        {!lastResult ? (
          <div className="text-center py-8 px-3 space-y-2 text-slate-400">
            <div className="text-2xl">🛡️</div>
            <p className="text-xs font-medium text-slate-300">
              Zero-Regression Topology Verification
            </p>
            <p className="text-[11px] leading-relaxed">
              Run Golden Evals against your unsaved canvas to verify complexity tiering, vendor
              aliasing, PII redaction, and PromptGuard enforcement in &lt;5ms.
            </p>
            <div className="pt-2">
              <code className="block px-2.5 py-1.5 rounded bg-slate-900 border border-slate-800 text-[10px] text-violet-300 font-mono">
                npx eluvix-eval --suite {selectedSuiteId} --mode dry-run
              </code>
            </div>
          </div>
        ) : (
          <>
            <div
              className={`p-2.5 rounded-xl border flex items-center justify-between ${
                lastResult.passed
                  ? 'bg-emerald-950/40 border-emerald-500/40 text-emerald-200'
                  : 'bg-rose-950/40 border-rose-500/40 text-rose-200'
              }`}
            >
              <div>
                <div className="text-xs font-bold">
                  {lastResult.passed ? '✅ ALL ASSERTIONS PASSED' : '❌ REGRESSION DETECTED'}
                </div>
                <div className="text-[11px] opacity-80">
                  {lastResult.passedCases}/{lastResult.totalCases} cases passed ·{' '}
                  {lastResult.totalDurationMs}ms ({lastResult.mode})
                </div>
              </div>
              <span className="px-2 py-0.5 rounded text-[10px] font-mono uppercase bg-black/30">
                {lastResult.mode}
              </span>
            </div>

            {lastResult.results.map((c) => (
              <div
                key={c.id}
                className={`p-2.5 rounded-xl border space-y-1.5 ${
                  c.passed
                    ? 'bg-slate-900/70 border-slate-800'
                    : 'bg-rose-950/20 border-rose-500/40'
                }`}
              >
                <div className="flex items-start justify-between gap-2">
                  <div className="text-xs font-semibold text-slate-100 leading-snug">
                    {c.passed ? '✓ ' : '✗ '}
                    {c.name}
                  </div>
                  <span className="text-[10px] font-mono text-slate-400 shrink-0">
                    {c.durationMs}ms
                  </span>
                </div>

                <div className="flex flex-wrap gap-1.5 text-[10px]">
                  <span className="px-1.5 py-0.5 rounded bg-slate-800 text-slate-300 font-mono">
                    tier:{c.complexityTier}
                  </span>
                  <span className="px-1.5 py-0.5 rounded bg-slate-800 text-sky-300 font-mono">
                    upstream:{c.selectedUpstreamId || 'blocked'}
                  </span>
                  {c.piiRedacted && (
                    <span className="px-1.5 py-0.5 rounded bg-amber-950/60 border border-amber-500/30 text-amber-200">
                      PII Scrubbed
                    </span>
                  )}
                  {c.blockedByGuard && (
                    <span className="px-1.5 py-0.5 rounded bg-violet-950/60 border border-violet-500/30 text-violet-200">
                      Guard Blocked
                    </span>
                  )}
                </div>

                <div className="space-y-1 pt-0.5">
                  {c.assertions.map((a, idx) => (
                    <div
                      key={`${c.id}-a-${idx}`}
                      className={`text-[10px] font-mono flex items-center justify-between gap-2 px-2 py-1 rounded ${
                        a.passed
                          ? 'bg-emerald-950/25 text-emerald-300'
                          : 'bg-rose-950/40 text-rose-300'
                      }`}
                    >
                      <span>
                        {a.passed ? 'PASS' : 'FAIL'} {a.check}
                      </span>
                      <span className="truncate max-w-[210px]" title={`expected ${a.expected}, got ${a.actual}`}>
                        {a.passed ? a.actual : `exp ${a.expected} != ${a.actual}`}
                      </span>
                    </div>
                  ))}
                </div>
              </div>
            ))}
          </>
        )}
      </div>
    </div>
  );
}
