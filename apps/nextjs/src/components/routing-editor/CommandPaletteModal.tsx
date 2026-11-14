"use client";

import { useState, useEffect, useMemo, useRef } from 'react';
import type { LayoutMetadata } from '@/lib/layouts/types';

export interface PaletteNodeSpec {
  type: string;
  title: string;
  subtitle: string;
  icon: string;
  category: string;
  keywords: string;
  customData?: Record<string, any>;
}

export const PALETTE_NODE_CATALOG: PaletteNodeSpec[] = [
  // Local Inference & Media Engines
  { type: 'lemonadeNode', title: 'Lemonade Engine', subtitle: 'Local NPU / GPU Server (:13305)', icon: '🍋', category: 'Local Engine', keywords: 'amd ryzen npu flm gguf fast local' },
  { type: 'ramalamaNode', title: 'RamaLama OCI Engine', subtitle: 'Rootless Podman / Docker Container (:8080)', icon: '🦙', category: 'Local Engine', keywords: 'containers oci llama.cpp vllm mlx selinux airgap' },
  { type: 'ollamaNode', title: 'Ollama Engine', subtitle: 'Local Model Runner (:11434)', icon: '🦙', category: 'Local Engine', keywords: 'gguf llama qwen llava vision local' },
  { type: 'vllmNode', title: 'vLLM Engine', subtitle: 'PagedAttention GPU Server (:8000)', icon: '⚡', category: 'Local Engine', keywords: 'cuda rocm speculative decoding nvfp4 fa3' },
  { type: 'sglangNode', title: 'SGLang Engine', subtitle: 'RadixAttention & Mooncake RDMA (:30000)', icon: '🚀', category: 'Local Engine', keywords: 'disaggregated prefill decode kv cache blackwell' },
  { type: 'comfyuiNode', title: 'ComfyUI Media DAG Engine', subtitle: 'Flux.1 / SDXL / Wan 2.1 Video / Hunyuan3D (:8188)', icon: '🎬', category: 'Media Synthesis', keywords: 'diffusion image video 3d mesh glb artcraft' },
  { type: 'audioVoiceNode', title: 'Sovereign Audio & Voice Engine', subtitle: 'Headless Whisper STT (:8005) + Kokoro/Piper TTS (:8880)', icon: '🎙️', category: 'Media Synthesis', keywords: 'audio voice whisper speaches kokoro piper stt tts transcription speech' },

  // Frontier & Autonomous Agent Harnesses
  { type: 'antigravityNode', title: 'Google Antigravity Agent (Gemini 4 Carbon)', subtitle: 'Autonomous CLI & Extended Thinking (cli://agy)', icon: '🚀', category: 'Agent CLI', keywords: 'gemini 4 carbon argon flash agy subagents', customData: { model: 'gemini-4-carbon' } },
  { type: 'claudeCodeNode', title: 'Anthropic Claude Code Agent', subtitle: 'Terminal Pair-Programmer CLI', icon: '🧠', category: 'Agent CLI', keywords: 'claude opus sonnet coding terminal' },
  { type: 'codexNode', title: 'OpenAI Codex CLI Agent', subtitle: 'Sandboxed Terminal Reasoning Agent', icon: '💻', category: 'Agent CLI', keywords: 'o3 o1 codex bash sandbox' },
  { type: 'harnessNode', title: 'Agent Harness (TrueForge / OpenCode / Aider)', subtitle: 'Multi-Step Coding & ACP Harness (:8790)', icon: '🛠️', category: 'Agent Harness', keywords: 'trueforge opencode aider swe-agent cline plandex acp' },
  { type: 'openaiNode', title: 'OpenAI Frontier Provider', subtitle: 'HTTPS Cloud API (GPT-4o / o3)', icon: '🌐', category: 'Cloud Provider', keywords: 'cloud gpt-4o frontier fallback' },
  { type: 'claudeNode', title: 'Anthropic Claude Provider', subtitle: 'HTTPS Cloud API (Claude Sonnet / Opus)', icon: '✨', category: 'Cloud Provider', keywords: 'cloud anthropic sonnet opus' },
  { type: 'billamaNode', title: 'Billama Decentralized GPU Mesh', subtitle: 'Community P2P Inference Marketplace', icon: '🕸️', category: 'Cloud Mesh', keywords: 'decentralized p2p gpu marketplace' },
  { type: 'agentNode', title: 'Custom Prompt Agent', subtitle: 'Generic System-Prompted Persona Node', icon: '🤖', category: 'Custom Agent', keywords: 'persona prompt custom llm' },

  // Balancers, Routers & Gateways
  { type: 'inputNode', title: 'Client Input Entrypoint', subtitle: 'OpenAI /v1/chat & /v1/images Gateway (:3588)', icon: '🔌', category: 'Entrypoint', keywords: 'client request input sdk' },
  { type: 'switchyardNode', title: 'Switchyard Balancer', subtitle: 'Cost, Complexity & Modality Router', icon: '🔀', category: 'Balancer', keywords: 'router tiers failover kv affinity modality thompson bandit' },
  { type: 'speculativeCascadeNode', title: 'Speculative Cascade (Buffer-Verify)', subtitle: '$0 Local Draft Verification ➔ Frontier Escalation & Shadow DPO', icon: '⚡', category: 'Balancer', keywords: 'speculative cascade draft verifier buffer verify shadow student distillation dpo sft' },
  { type: 'consensusNode', title: 'Consensus Judge / Arena', subtitle: 'Parallel N-Model Fan-Out & Rubric Judge', icon: '🏛️', category: 'Balancer', keywords: 'ensemble quorum judge voting arena' },
  { type: 'fallbackChainNode', title: 'Resilient Fallback Chain', subtitle: 'Circuit Breaker & Hedged Retries', icon: '⛓️', category: 'Balancer', keywords: 'retry circuit breaker hedging 429 5xx' },
  { type: 'taskRouterNode', title: 'Task Router', subtitle: 'Intent Classification Dispatcher', icon: '🧭', category: 'Gateway', keywords: 'intent code math creative' },
  { type: 'modelGatewayNode', title: 'Model Gateway (Bifrost)', subtitle: 'Rate Limits & Semantic Prefix Adapter', icon: '🚪', category: 'Gateway', keywords: 'bifrost rate limit primary model' },
  { type: 'agentGatewayNode', title: 'Agent Gateway (MCP Multiplexer)', subtitle: 'Unified Tool & Subagent Broker', icon: '🛰️', category: 'Gateway', keywords: 'mcp broker multiplexer tools' },

  // Security, Zero-Trust TEE, CRS & Creative MCPs
  { type: 'privacyGuardNode', title: 'Privacy & PII Guard', subtitle: 'In-Flight Regex, Token & SHA-256 Redactor', icon: '🛡️', category: 'Security', keywords: 'pii hipaa gdpr ssn email api key redact' },
  { type: 'semanticGuardNode', title: 'Semantic Injection Guard', subtitle: 'DeBERTa-v3 Jailbreak & Leak Firewall', icon: '🎯', category: 'Security', keywords: 'prompt injection jailbreak dan firewall' },
  { type: 'confidentialEnclaveNode', title: 'Confidential Silicon Enclave (TEE)', subtitle: 'AMD SEV-SNP / Intel TDX + H100 CC / B200 RATS', icon: '🔐', category: 'Security', keywords: 'tee confidential enclave attestation spdm' },
  { type: 'crsNode', title: 'Neuro-Symbolic CRS Verifier', subtitle: 'Backward Slicer + SymCC/Z3 + ASan Shadow Triage', icon: '🧬', category: 'Verification', keywords: 'crs symbolic z3 asan sanitizer vulnerability' },
  { type: 'sandboxNode', title: 'Isolated Execution Sandbox', subtitle: 'Zero-Egress Ephemeral Code Container (:3986)', icon: '📦', category: 'Security', keywords: 'docker sandbox isolation code execution' },

  // Memory, RAG, Caching, Tools & Observability
  { type: 'memoryNode', title: 'OpenViking Context & Memory', subtitle: 'Scoped L0/L1/L2 Episodic Memory (:1933)', icon: '🧠', category: 'Context & RAG', keywords: 'memory openviking graphiti recall' },
  { type: 'knowledgeBaseNode', title: 'Knowledge Base (Hybrid RAG)', subtitle: 'LightRAG / Vector Citation Injector (:9621)', icon: '📚', category: 'Context & RAG', keywords: 'rag citations vector search documents' },
  { type: 'paperclipBridgeNode', title: 'Paperclip Bridge', subtitle: 'Company Priority & Delegation Policy (:3100)', icon: '📎', category: 'Context & RAG', keywords: 'paperclip company agent delegation priority budget' },
  { type: 'semanticCacheNode', title: 'Semantic & Exact Cache', subtitle: 'Per-User Zero-Latency Response Cache', icon: '⚡', category: 'Context & RAG', keywords: 'cache sqlite fts qdrant ttl' },
  { type: 'mcpToolNode', title: 'MCP Tool Server', subtitle: 'Model Context Protocol Tool Provider', icon: '🔧', category: 'Tools & Creative', keywords: 'mcp filesystem postgres github brave' },
  { type: 'vectorcraftNode', title: 'VectorCraft / ArtCraft Creative Suite', subtitle: '14-App Local Creative MCP Suite (SVG, Photo, Video, 3D)', icon: '🎨', category: 'Tools & Creative', keywords: 'vectorcraft artcraft photocraft filmcraft svg bezier' },
  { type: 'observabilityNode', title: 'Observability & Telemetry Sink', subtitle: 'SQLite Metrics, Latency & Cost Ledger', icon: '📊', category: 'Observability', keywords: 'logs metrics prometheus trace latency' },
];

export interface CommandPaletteAction {
  id: string;
  group: 'Canvas Actions' | 'Spawn Node' | 'Switch Layout';
  title: string;
  subtitle: string;
  icon: string;
  shortcut?: string;
  badge?: string;
  searchText: string;
  onSelect: () => void;
}

interface CommandPaletteModalProps {
  isOpen: boolean;
  onClose: () => void;
  layouts: LayoutMetadata[];
  canUndo: boolean;
  canRedo: boolean;
  diagnosticsCount: number;
  simulatorOpen: boolean;
  evalGateOpen?: boolean;
  onAddNode: (type: string, customData?: Record<string, any>) => void;
  onLoadLayout: (slug: string) => void;
  onAutoLayout: () => void;
  onToggleSimulator: () => void;
  onToggleEvalGate?: () => void;
  onAutoFixAll: () => void;
  onSyncLiveConfig: () => void;
  onSave: () => void;
  onApplyToRouter: () => void;
  onExportJson: () => void;
  onNewCanvas: () => void;
  onUndo: () => void;
  onRedo: () => void;
}

export default function CommandPaletteModal({
  isOpen,
  onClose,
  layouts,
  canUndo,
  canRedo,
  diagnosticsCount,
  simulatorOpen,
  evalGateOpen,
  onAddNode,
  onLoadLayout,
  onAutoLayout,
  onToggleSimulator,
  onToggleEvalGate,
  onAutoFixAll,
  onSyncLiveConfig,
  onSave,
  onApplyToRouter,
  onExportJson,
  onNewCanvas,
  onUndo,
  onRedo,
}: CommandPaletteModalProps) {
  const [query, setQuery] = useState('');
  const [activeIndex, setActiveIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  // Reset the palette when it opens, and reset the highlighted row when the
  // query changes. Both are "adjust state when a prop changes", done during
  // render instead of in effects (react-hooks/set-state-in-effect): React
  // discards the render and re-renders with the new state before committing.
  const [prevIsOpen, setPrevIsOpen] = useState(isOpen);
  if (isOpen !== prevIsOpen) {
    setPrevIsOpen(isOpen);
    if (isOpen) {
      setQuery('');
      setActiveIndex(0);
    }
  }
  const [prevQuery, setPrevQuery] = useState(query);
  if (query !== prevQuery) {
    setPrevQuery(query);
    setActiveIndex(0);
  }

  // Focus the input once the palette opens (a timer callback, not a
  // synchronous setState — the effect sets no state itself).
  useEffect(() => {
    if (isOpen) {
      setTimeout(() => inputRef.current?.focus(), 20);
    }
  }, [isOpen]);

  const allItems = useMemo<CommandPaletteAction[]>(() => {
    const actions: CommandPaletteAction[] = [
      {
        id: 'act-autolayout',
        group: 'Canvas Actions',
        title: 'Auto-Layout DAG (Sugiyama Topological)',
        subtitle: 'Align pipeline ranks left-to-right & eliminate edge crossings and overlaps',
        icon: '✨',
        shortcut: '⇧⌘L',
        badge: 'Layout',
        searchText: 'auto layout tidy arrange clean align sugiyama dag topological',
        onSelect: () => {
          onAutoLayout();
          onClose();
        },
      },
      {
        id: 'act-simulator',
        group: 'Canvas Actions',
        title: simulatorOpen ? 'Hide Live Route Simulator' : 'Open Live Route Simulator',
        subtitle: 'Test prompts & illuminate chosen upstream + failover paths on the canvas',
        icon: '🧭',
        badge: 'Trace',
        searchText: 'simulate route trace explain test prompt pathmodality',
        onSelect: () => {
          onToggleSimulator();
          onClose();
        },
      },
      ...(onToggleEvalGate
        ? [
            {
              id: 'act-eval-gate',
              group: 'Canvas Actions' as const,
              title: evalGateOpen ? 'Hide Golden Eval Gate' : 'Open Golden Eval Gate',
              subtitle: 'Run $0.00 deterministic or live Golden Eval assertions against unsaved canvas',
              icon: '🧪',
              badge: 'Evals',
              searchText: 'golden eval suite regression gate assertions dry-run verify',
              onSelect: () => {
                onToggleEvalGate();
                onClose();
              },
            },
          ]
        : []),
      ...(diagnosticsCount > 0
        ? [
            {
              id: 'act-autofix',
              group: 'Canvas Actions' as const,
              title: `Auto-Fix All Canvas Diagnostics (${diagnosticsCount})`,
              subtitle: 'Resolve port collisions, ComfyUI VRAM contention, and orphaned engines in one click',
              icon: '🩺',
              badge: `${diagnosticsCount} issue${diagnosticsCount > 1 ? 's' : ''}`,
              searchText: 'fix diagnostics port collision vram overcommit unconnected repair',
              onSelect: () => {
                onAutoFixAll();
                onClose();
              },
            },
          ]
        : []),
      {
        id: 'act-apply',
        group: 'Canvas Actions',
        title: 'Apply Graph to Live Router',
        subtitle: 'Compile canvas topology & synchronize active Eluvix router configuration',
        icon: '🚀',
        badge: 'Deploy',
        searchText: 'apply deploy router compile live config',
        onSelect: () => {
          onClose();
          onApplyToRouter();
        },
      },
      {
        id: 'act-save',
        group: 'Canvas Actions',
        title: 'Save Current Layout',
        subtitle: 'Persist layout JSON to XDG_CONFIG_HOME/eluvix/layouts',
        icon: '💾',
        shortcut: '⌘S',
        searchText: 'save write persist layout',
        onSelect: () => {
          onClose();
          onSave();
        },
      },
      {
        id: 'act-sync-live',
        group: 'Canvas Actions',
        title: 'Sync Canvas from Live eluvix.json',
        subtitle: 'Decompile active router configuration onto a clean topological canvas',
        icon: '🔄',
        searchText: 'sync import decompile live eluvix.json config',
        onSelect: () => {
          onClose();
          onSyncLiveConfig();
        },
      },
      {
        id: 'act-export',
        group: 'Canvas Actions',
        title: 'Export Layout JSON',
        subtitle: 'Download current nodes, edges, and viewport as a portable .json file',
        icon: '⬇️',
        searchText: 'export download json backup',
        onSelect: () => {
          onClose();
          onExportJson();
        },
      },
      {
        id: 'act-new',
        group: 'Canvas Actions',
        title: 'New Clean Canvas',
        subtitle: 'Reset workspace to a minimal Client Input → Switchyard starter graph',
        icon: '➕',
        searchText: 'new blank clean reset starter canvas',
        onSelect: () => {
          onClose();
          onNewCanvas();
        },
      },
    ];

    if (canUndo) {
      actions.push({
        id: 'act-undo',
        group: 'Canvas Actions',
        title: 'Undo Last Graph Edit',
        subtitle: 'Step backward in canvas edit history',
        icon: '↶',
        shortcut: '⌘Z',
        searchText: 'undo revert back history',
        onSelect: () => {
          onUndo();
          onClose();
        },
      });
    }
    if (canRedo) {
      actions.push({
        id: 'act-redo',
        group: 'Canvas Actions',
        title: 'Redo Graph Edit',
        subtitle: 'Step forward in canvas edit history',
        icon: '↷',
        shortcut: '⇧⌘Z',
        searchText: 'redo forward history',
        onSelect: () => {
          onRedo();
          onClose();
        },
      });
    }

    const nodeItems: CommandPaletteAction[] = PALETTE_NODE_CATALOG.map((spec) => ({
      id: `node-${spec.type}-${spec.title}`,
      group: 'Spawn Node',
      title: `Add ${spec.title}`,
      subtitle: spec.subtitle,
      icon: spec.icon,
      badge: spec.category,
      searchText: `${spec.title} ${spec.subtitle} ${spec.category} ${spec.type} ${spec.keywords}`.toLowerCase(),
      onSelect: () => {
        onAddNode(spec.type, spec.customData);
        onClose();
      },
    }));

    const layoutItems: CommandPaletteAction[] = layouts.map((l) => ({
      id: `layout-${l.id}`,
      group: 'Switch Layout',
      title: l.name,
      subtitle: l.description || `${l.nodeCount ?? 0} nodes · ${l.id}.json`,
      icon: l.isExample ? '📐' : '📂',
      badge: l.category || (l.isExample ? 'Template' : 'Custom'),
      searchText: `${l.name} ${l.id} ${l.description || ''} ${(l.tags || []).join(' ')} ${l.category || ''}`.toLowerCase(),
      onSelect: () => {
        onClose();
        onLoadLayout(l.id);
      },
    }));

    return [...actions, ...nodeItems, ...layoutItems];
  }, [
    layouts,
    canUndo,
    canRedo,
    diagnosticsCount,
    simulatorOpen,
    evalGateOpen,
    onAddNode,
    onLoadLayout,
    onAutoLayout,
    onToggleSimulator,
    onToggleEvalGate,
    onAutoFixAll,
    onSyncLiveConfig,
    onSave,
    onApplyToRouter,
    onExportJson,
    onNewCanvas,
    onUndo,
    onRedo,
    onClose,
  ]);

  const filtered = useMemo(() => {
    const tokens = query
      .toLowerCase()
      .trim()
      .split(/\s+/)
      .filter(Boolean);
    if (tokens.length === 0) return allItems.slice(0, 40);

    const scored: Array<{ item: CommandPaletteAction; score: number }> = [];
    for (const item of allItems) {
      const hay = `${item.title.toLowerCase()} ${item.subtitle.toLowerCase()} ${item.searchText}`;
      if (!tokens.every((tok) => hay.includes(tok))) continue;
      let score = 10;
      const lowerTitle = item.title.toLowerCase();
      if (lowerTitle.startsWith(tokens[0])) score += 30;
      else if (lowerTitle.includes(tokens[0])) score += 15;
      if (item.group === 'Canvas Actions') score += 5;
      scored.push({ item, score });
    }
    scored.sort((a, b) => b.score - a.score);
    return scored.map((s) => s.item);
  }, [allItems, query]);

  useEffect(() => {
    const activeEl = listRef.current?.querySelector(`[data-palette-idx="${activeIndex}"]`);
    if (activeEl && typeof (activeEl as HTMLElement).scrollIntoView === 'function') {
      (activeEl as HTMLElement).scrollIntoView({ block: 'nearest' });
    }
  }, [activeIndex]);

  if (!isOpen) return null;

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      onClose();
      return;
    }
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setActiveIndex((prev) => (filtered.length > 0 ? (prev + 1) % filtered.length : 0));
      return;
    }
    if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActiveIndex((prev) =>
        filtered.length > 0 ? (prev - 1 + filtered.length) % filtered.length : 0
      );
      return;
    }
    if (e.key === 'Enter') {
      e.preventDefault();
      const target = filtered[activeIndex];
      if (target) target.onSelect();
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 bg-black/70 backdrop-blur-sm flex items-start justify-center pt-[12vh] px-4"
      onClick={onClose}
    >
      <div
        className="w-full max-w-2xl bg-slate-900 border border-slate-700 rounded-2xl shadow-2xl overflow-hidden text-slate-100"
        onClick={(e) => e.stopPropagation()}
        onKeyDown={handleKeyDown}
      >
        {/* Search Input Header */}
        <div className="flex items-center gap-3 px-4 py-3.5 border-b border-slate-800 bg-slate-950/70">
          <span className="text-sky-400 text-lg">🔎</span>
          <input
            ref={inputRef}
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search nodes (Gemini 4 Carbon, ComfyUI, RamaLama...), layouts, or actions..."
            className="flex-1 bg-transparent text-sm text-white placeholder-slate-500 outline-none"
          />
          <kbd className="text-[10px] font-mono px-2 py-0.5 rounded bg-slate-800 border border-slate-700 text-slate-400">
            ESC
          </kbd>
        </div>

        {/* Results List */}
        <div ref={listRef} className="max-h-[58vh] overflow-y-auto p-2 space-y-1">
          {filtered.length === 0 ? (
            <div className="py-10 text-center text-xs text-slate-500">
              No matching nodes, templates, or actions for &ldquo;{query}&rdquo;.
            </div>
          ) : (
            filtered.map((item, idx) => {
              const prevGroup = idx > 0 ? filtered[idx - 1].group : null;
              const showGroupHeader = item.group !== prevGroup;
              const isActive = idx === activeIndex;

              return (
                <div key={item.id}>
                  {showGroupHeader && (
                    <div className="px-2.5 pt-2 pb-1 text-[10px] font-bold uppercase tracking-wider text-slate-500">
                      {item.group}
                    </div>
                  )}
                  <button
                    type="button"
                    data-palette-idx={idx}
                    onMouseEnter={() => setActiveIndex(idx)}
                    onClick={item.onSelect}
                    className={`w-full text-left px-3 py-2 rounded-xl flex items-center justify-between gap-3 transition ${
                      isActive
                        ? 'bg-sky-600/25 border border-sky-500/50 text-white'
                        : 'border border-transparent hover:bg-slate-800/70 text-slate-200'
                    }`}
                  >
                    <div className="flex items-center gap-3 min-w-0">
                      <span className="text-lg shrink-0">{item.icon}</span>
                      <div className="min-w-0">
                        <div className="text-xs font-semibold truncate">{item.title}</div>
                        <div className="text-[11px] text-slate-400 truncate font-mono">
                          {item.subtitle}
                        </div>
                      </div>
                    </div>
                    <div className="flex items-center gap-2 shrink-0">
                      {item.badge && (
                        <span className="text-[10px] font-mono px-2 py-0.5 rounded-full bg-slate-800 border border-slate-700 text-sky-300">
                          {item.badge}
                        </span>
                      )}
                      {item.shortcut && (
                        <kbd className="text-[10px] font-mono px-1.5 py-0.5 rounded bg-slate-950 border border-slate-700 text-slate-400">
                          {item.shortcut}
                        </kbd>
                      )}
                    </div>
                  </button>
                </div>
              );
            })
          )}
        </div>

        {/* Footer Hints */}
        <div className="px-4 py-2 border-t border-slate-800 bg-slate-950/60 flex items-center justify-between text-[10px] text-slate-400 font-mono">
          <div className="flex items-center gap-3">
            <span>↑↓ Navigate</span>
            <span>↵ Execute</span>
            <span>ESC Close</span>
          </div>
          <span>Eluvix Visual Node Routing Editor · {PALETTE_NODE_CATALOG.length} Nodes</span>
        </div>
      </div>
    </div>
  );
}
