"use client";

import { useState } from 'react';
import type { Node, Edge } from '@xyflow/react';

export interface SimulatedExplanation {
  model: string;
  strategy: string;
  egressPolicy?: string;
  modality?: {
    hasVisionInput: boolean;
    hasAudioInput: boolean;
    hasToolDefinitions: boolean;
    synthesisIntent: 'text' | 'image-gen' | 'video-gen' | '3d-gen';
    matchedTrigger?: string;
  };
  complexity: {
    score: number;
    label: string;
    tokenEstimate: number;
    hasImages: boolean;
    hasTools: boolean;
  };
  steps: Array<{
    stage: string;
    detail: string;
    kept: string[];
    removed?: string[];
  }>;
  rankedUpstreams: Array<{ id: string; name: string; type: string }>;
  chosenUpstreamId: string | null;
  error?: string;
}

const SAMPLE_PROMPTS: Array<{
  label: string;
  prompt: string;
  vision?: boolean;
  model?: string;
}> = [
  {
    label: '💬 Simple Local ($0)',
    prompt: 'Summarize the difference between TCP and UDP in two bullet points.',
  },
  {
    label: '🧠 Deep Architecture',
    prompt:
      'Design a lock-free multi-producer ring buffer in Rust with formal memory-ordering invariants (Acquire/Release vs SeqCst) and prove ABA safety.',
  },
  {
    label: '👁️ Vision VLM',
    prompt: 'What exception stack trace is shown in this terminal screenshot?',
    vision: true,
  },
  {
    label: '🎨 Flux Image DAG',
    prompt: '/imagine an architectural glass observatory suspended above bioluminescent clouds',
  },
  {
    label: '🎬 Wan 2.1 Video',
    prompt: 'Generate a short video animation of aurora borealis shimmering above basalt cliffs',
  },
];

/**
 * Computes visual simulation highlights on ReactFlow edges without mutating saved edge data.
 * Illuminates the shortest/all directed pipeline paths from `inputNode` through intermediate
 * guards/routers into `chosenUpstreamId` (and onward to `observabilityNode`), plus amber
 * dashed failover edges for `#2` and `#3` backup upstreams.
 */
export function applySimulationOverlayToEdges(
  baseEdges: Edge[],
  nodes: Node[],
  explanation: SimulatedExplanation | null
): Edge[] {
  if (!explanation) return baseEdges;

  const chosenId = explanation.chosenUpstreamId;
  const backupIds = new Map<string, number>();
  explanation.rankedUpstreams.slice(1, 4).forEach((u, idx) => {
    backupIds.set(u.id, idx + 2); // Rank #2, #3, #4
  });

  const nodeTypeById = new Map<string, string>();
  nodes.forEach((n) => nodeTypeById.set(n.id, n.type || ''));

  // Backward reachability from chosenId to inputNode(s), plus forward hop from chosenId to observabilityNode / post-processors
  const primaryEdgeIds = new Set<string>();
  if (chosenId) {
    // 1. Reverse BFS from chosenId back to input/guards/switchyard
    const canReachChosen = new Set<string>([chosenId]);
    let changed = true;
    for (let pass = 0; pass < 8 && changed; pass++) {
      changed = false;
      for (const e of baseEdges) {
        if (canReachChosen.has(e.target) && !canReachChosen.has(e.source)) {
          const srcType = nodeTypeById.get(e.source) || '';
          // Only traverse pipeline ingress/guard/router nodes (or prompt enhancer LLM -> ComfyUI)
          if (srcType !== 'observabilityNode') {
            canReachChosen.add(e.source);
            changed = true;
          }
        }
      }
    }

    // Forward reachability from inputNode(s) (or all root nodes if no inputNode)
    const roots = nodes.filter((n) => n.type === 'inputNode').map((n) => n.id);
    const reachableFromRoot = new Set<string>(
      roots.length > 0 ? roots : Array.from(canReachChosen)
    );
    changed = true;
    for (let pass = 0; pass < 8 && changed; pass++) {
      changed = false;
      for (const e of baseEdges) {
        if (reachableFromRoot.has(e.source) && !reachableFromRoot.has(e.target)) {
          reachableFromRoot.add(e.target);
          changed = true;
        }
      }
    }

    for (const e of baseEdges) {
      if (
        reachableFromRoot.has(e.source) &&
        canReachChosen.has(e.source) &&
        canReachChosen.has(e.target)
      ) {
        primaryEdgeIds.add(e.id);
      }
      // Also highlight downstream sink edge from chosenId -> observabilityNode / vectorcraftNode
      if (
        e.source === chosenId &&
        (nodeTypeById.get(e.target) === 'observabilityNode' ||
          nodeTypeById.get(e.target) === 'vectorcraftNode' ||
          nodeTypeById.get(e.target) === 'artcraftNode')
      ) {
        primaryEdgeIds.add(e.id);
      }
    }
  }

  return baseEdges.map((e) => {
    if (primaryEdgeIds.has(e.id)) {
      const isDirectChosenHop = e.target === chosenId;
      return {
        ...e,
        animated: true,
        label: isDirectChosenHop ? '⚡ #1 Selected' : e.label,
        labelStyle: isDirectChosenHop
          ? { fill: '#ecfdf5', fontWeight: 700, fontSize: 10, fontFamily: 'monospace' }
          : e.labelStyle,
        labelBgStyle: isDirectChosenHop
          ? { fill: '#065f46', fillOpacity: 0.92 }
          : e.labelBgStyle,
        style: {
          ...(e.style || {}),
          stroke: '#10b981',
          strokeWidth: 5.5,
          opacity: 1,
        },
      };
    }

    const backupRank = backupIds.get(e.target);
    if (backupRank !== undefined) {
      return {
        ...e,
        animated: false,
        label: `Backup #${backupRank}`,
        labelStyle: { fill: '#fef3c7', fontWeight: 600, fontSize: 10, fontFamily: 'monospace' },
        labelBgStyle: { fill: '#78350f', fillOpacity: 0.9 },
        style: {
          ...(e.style || {}),
          stroke: '#f59e0b',
          strokeWidth: 3,
          strokeDasharray: '6 4',
          opacity: 0.85,
        },
      };
    }

    return {
      ...e,
      animated: false,
      style: {
        ...(e.style || {}),
        opacity: 0.2,
      },
    };
  });
}

interface RouteSimulatorDrawerProps {
  isOpen: boolean;
  onClose: () => void;
  explanation: SimulatedExplanation | null;
  onSimulate: (params: {
    prompt: string;
    model: string;
    includeVision: boolean;
    confidentialPolicy?: string;
  }) => Promise<void>;
  onClearOverlay: () => void;
  simulating: boolean;
}

export default function RouteSimulatorDrawer({
  isOpen,
  onClose,
  explanation,
  onSimulate,
  onClearOverlay,
  simulating,
}: RouteSimulatorDrawerProps) {
  const [prompt, setPrompt] = useState(
    'Design a lock-free ring buffer in Rust with formal Acquire/Release ordering.'
  );
  const [model, setModel] = useState('auto');
  const [includeVision, setIncludeVision] = useState(false);
  const [confidentialPolicy, setConfidentialPolicy] = useState('disabled');
  const [showSteps, setShowSteps] = useState(false);

  if (!isOpen) return null;

  const runSimulation = () => {
    if (!prompt.trim()) return;
    onSimulate({
      prompt,
      model,
      includeVision,
      confidentialPolicy: confidentialPolicy !== 'disabled' ? confidentialPolicy : undefined,
    });
  };

  return (
    <div className="absolute bottom-4 left-1/2 -translate-x-1/2 z-30 w-[min(920px,calc(100%-2rem))] bg-slate-900/95 backdrop-blur-md border border-sky-500/40 rounded-2xl shadow-2xl p-3.5 text-xs text-slate-100">
      {/* Header + Quick Sample Chips */}
      <div className="flex flex-wrap items-center justify-between gap-2 pb-2 mb-2.5 border-b border-slate-800">
        <div className="flex items-center gap-2">
          <span className="text-base">🧭</span>
          <span className="font-bold text-sky-300">Live Canvas Route Simulator</span>
          <span className="text-[10px] font-mono text-slate-400 hidden sm:inline">
            (Evaluates unsaved canvas graph in-memory via /api/v1/route-explain)
          </span>
        </div>

        <div className="flex items-center gap-1.5">
          {explanation && (
            <button
              type="button"
              onClick={onClearOverlay}
              className="px-2 py-0.5 rounded bg-slate-800 hover:bg-slate-700 border border-slate-700 text-[10px] font-mono text-amber-300"
            >
              Clear Path Overlay
            </button>
          )}
          <button
            type="button"
            onClick={onClose}
            className="px-2 py-0.5 rounded hover:bg-slate-800 text-slate-400 hover:text-white"
            title="Close Route Simulator"
          >
            ✕
          </button>
        </div>
      </div>

      {/* Preset Prompt Chips */}
      <div className="flex flex-wrap items-center gap-1.5 mb-2.5">
        <span className="text-[10px] text-slate-400 font-semibold mr-1">Presets:</span>
        {SAMPLE_PROMPTS.map((sample) => (
          <button
            key={sample.label}
            type="button"
            onClick={() => {
              setPrompt(sample.prompt);
              setIncludeVision(Boolean(sample.vision));
              if (sample.model) setModel(sample.model);
              onSimulate({
                prompt: sample.prompt,
                model: sample.model || model,
                includeVision: Boolean(sample.vision),
                confidentialPolicy:
                  confidentialPolicy !== 'disabled' ? confidentialPolicy : undefined,
              });
            }}
            className="px-2 py-0.5 rounded-full bg-slate-800 hover:bg-sky-900/50 border border-slate-700 hover:border-sky-500/50 text-[10px] text-slate-200 transition"
          >
            {sample.label}
          </button>
        ))}
      </div>

      {/* Input Controls Row */}
      <div className="flex flex-wrap sm:flex-nowrap items-center gap-2">
        <input
          type="text"
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') runSimulation();
          }}
          placeholder="Enter a test prompt (e.g. '/imagine neon library' or 'Implement Raft in Go')..."
          className="flex-1 min-w-[220px] bg-slate-950 border border-slate-700 focus:border-sky-500 rounded-lg px-3 py-1.5 text-xs text-white outline-none"
        />

        <select
          value={model}
          onChange={(e) => setModel(e.target.value)}
          className="bg-slate-950 border border-slate-700 rounded-lg px-2 py-1.5 text-[11px] font-mono text-sky-300 outline-none"
          title="Requested Model"
        >
          <option value="auto">model: auto</option>
          <option value="gemini-4-carbon">gemini-4-carbon</option>
          <option value="gemini-4-argon">gemini-4-argon</option>
          <option value="gemini-3.8-flash">gemini-3.8-flash</option>
          <option value="qwen2.5-coder:7b">qwen2.5-coder:7b</option>
          <option value="flux1-dev-fp8.safetensors">flux1-dev-fp8</option>
        </select>

        <label
          className={`flex items-center gap-1 px-2 py-1.5 rounded-lg border cursor-pointer text-[11px] font-mono ${
            includeVision
              ? 'bg-fuchsia-950/60 border-fuchsia-500/60 text-fuchsia-200'
              : 'bg-slate-950 border-slate-700 text-slate-400'
          }`}
          title="Attach simulated base64 image_url payload to test VLM vision filtering"
        >
          <input
            type="checkbox"
            className="accent-fuchsia-500 w-3 h-3"
            checked={includeVision}
            onChange={(e) => setIncludeVision(e.target.checked)}
          />
          <span>👁️ Vision</span>
        </label>

        <select
          value={confidentialPolicy}
          onChange={(e) => setConfidentialPolicy(e.target.value)}
          className="bg-slate-950 border border-slate-700 rounded-lg px-2 py-1.5 text-[11px] font-mono text-emerald-300 outline-none hidden md:block"
          title="Confidential Computing Policy Override"
        >
          <option value="disabled">TEE: Default</option>
          <option value="prefer-tee">TEE: Prefer</option>
          <option value="require-dual-attestation">TEE: Require Dual</option>
        </select>

        <button
          type="button"
          onClick={runSimulation}
          disabled={simulating}
          className="px-3.5 py-1.5 rounded-lg bg-emerald-600 hover:bg-emerald-500 disabled:opacity-50 text-white font-bold text-xs transition shrink-0 shadow"
        >
          {simulating ? 'Tracing...' : '⚡ Simulate'}
        </button>
      </div>

      {/* Explanation Summary Strip */}
      {explanation && (
        <div className="mt-2.5 pt-2.5 border-t border-slate-800 space-y-2">
          {explanation.error ? (
            <div className="px-3 py-1.5 rounded-lg bg-red-950/60 border border-red-500/50 text-red-200 font-mono text-[11px]">
              ❌ Blocked / No Route: {explanation.error}
            </div>
          ) : (
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="flex flex-wrap items-center gap-1.5 font-mono text-[11px]">
                <span className="px-2 py-0.5 rounded bg-emerald-950/80 border border-emerald-500/50 text-emerald-300 font-bold">
                  ✓ Winner: {explanation.chosenUpstreamId || 'none'}
                </span>
                <span className="px-2 py-0.5 rounded bg-indigo-950/70 border border-indigo-500/40 text-indigo-300">
                  Score {explanation.complexity?.score} ({explanation.complexity?.label}, ~{explanation.complexity?.tokenEstimate} tok)
                </span>
                {explanation.modality && (
                  <span className="px-2 py-0.5 rounded bg-fuchsia-950/70 border border-fuchsia-500/40 text-fuchsia-300">
                    Intent: {explanation.modality.synthesisIntent}
                    {explanation.modality.hasVisionInput ? ' + vision' : ''}
                  </span>
                )}
                {explanation.rankedUpstreams.length > 1 && (
                  <span className="px-2 py-0.5 rounded bg-amber-950/60 border border-amber-600/40 text-amber-300">
                    Failover:{' '}
                    {explanation.rankedUpstreams
                      .slice(1, 4)
                      .map((u, idx) => `#${idx + 2} ${u.id}`)
                      .join(' → ')}
                  </span>
                )}
              </div>

              <button
                type="button"
                onClick={() => setShowSteps((v) => !v)}
                className="text-[10px] font-mono text-sky-400 hover:text-sky-300 underline"
              >
                {showSteps
                  ? '▾ Hide Decision Stages'
                  : `▸ Decision Stages (${explanation.steps?.length || 0})`}
              </button>
            </div>
          )}

          {showSteps && Array.isArray(explanation.steps) && explanation.steps.length > 0 && (
            <div className="max-h-36 overflow-y-auto bg-slate-950/90 border border-slate-800 rounded-lg p-2 space-y-1 font-mono text-[10px]">
              {explanation.steps.map((step, i) => (
                <div key={`${step.stage}-${i}`} className="flex items-start gap-2">
                  <span className="px-1.5 py-0.2 rounded bg-slate-800 text-sky-300 shrink-0">
                    {step.stage}
                  </span>
                  <span className="text-slate-300">{step.detail}</span>
                  {step.removed && step.removed.length > 0 && (
                    <span className="text-rose-400 shrink-0">
                      [-{step.removed.join(', ')}]
                    </span>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
