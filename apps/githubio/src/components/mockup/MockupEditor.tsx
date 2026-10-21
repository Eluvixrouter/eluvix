'use client';

import { useState, useRef, useCallback, useEffect, useMemo } from 'react';
import { EXAMPLE_LAYOUTS, Layout } from './mockup-layouts';

interface CanvasNode {
  id: string;
  type: string;
  position: { x: number; y: number };
  data: Record<string, any>;
  selected?: boolean;
}

interface CanvasEdge {
  id: string;
  source: string;
  target: string;
  sourceHandle?: string;
  targetHandle?: string;
  animated?: boolean;
  style?: { stroke?: string };
}

export function MockupEditor() {
  const [currentLayout, setCurrentLayout] = useState<Layout>(EXAMPLE_LAYOUTS[0]);
  const [nodes, setNodes] = useState<CanvasNode[]>(EXAMPLE_LAYOUTS[0].nodes);
  const [edges, setEdges] = useState<CanvasEdge[]>(EXAMPLE_LAYOUTS[0].edges);
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  const [zoom, setZoom] = useState<number>(0.85);
  const [pan, setPan] = useState<{ x: number; y: number }>({ x: 30, y: 30 });
  const [isDraggingCanvas, setIsDraggingCanvas] = useState(false);
  const [dragStart, setDragStart] = useState<{ x: number; y: number }>({ x: 0, y: 0 });

  // Node Dragging State
  const [draggingNodeId, setDraggingNodeId] = useState<string | null>(null);
  const [nodeDragOffset, setNodeDragOffset] = useState<{ x: number; y: number }>({ x: 0, y: 0 });

  // Layout Browser Modal State
  const [isBrowserOpen, setIsBrowserOpen] = useState(false);
  const [browserCategory, setBrowserCategory] = useState<string>('all');
  const [browserSearch, setBrowserSearch] = useState<string>('');
  const [toastMessage, setToastMessage] = useState<string | null>(null);

  const canvasRef = useRef<HTMLDivElement>(null);

  function showToast(msg: string) {
    setToastMessage(msg);
    setTimeout(() => setToastMessage(null), 3000);
  }

  // Load a layout template
  const handleSelectTemplate = useCallback((layout: Layout) => {
    setCurrentLayout(layout);
    setNodes(JSON.parse(JSON.stringify(layout.nodes)));
    setEdges(JSON.parse(JSON.stringify(layout.edges)));
    setSelectedNodeId(null);
    setIsBrowserOpen(false);
    showToast(`Loaded template: "${layout.name}" (${layout.nodes.length} nodes)`);
  }, []);

  // Node Dragging handlers
  function handleNodeMouseDown(e: React.MouseEvent, nodeId: string) {
    e.stopPropagation();
    setSelectedNodeId(nodeId);
    setDraggingNodeId(nodeId);
    const node = nodes.find((n) => n.id === nodeId);
    if (node) {
      setNodeDragOffset({
        x: e.clientX / zoom - node.position.x,
        y: e.clientY / zoom - node.position.y,
      });
    }
  }

  function handleCanvasMouseDown(e: React.MouseEvent) {
    if (e.button === 0) {
      setIsDraggingCanvas(true);
      setDragStart({ x: e.clientX - pan.x, y: e.clientY - pan.y });
    }
  }

  function handleMouseMove(e: React.MouseEvent) {
    if (draggingNodeId) {
      const newX = Math.round(e.clientX / zoom - nodeDragOffset.x);
      const newY = Math.round(e.clientY / zoom - nodeDragOffset.y);
      setNodes((prev) =>
        prev.map((n) => (n.id === draggingNodeId ? { ...n, position: { x: newX, y: newY } } : n))
      );
    } else if (isDraggingCanvas) {
      setPan({
        x: e.clientX - dragStart.x,
        y: e.clientY - dragStart.y,
      });
    }
  }

  function handleMouseUp() {
    setDraggingNodeId(null);
    setIsDraggingCanvas(false);
  }

  // Add Node from Toolbox
  function handleAddNode(type: string, label: string) {
    const newId = `${type.replace('Node', '')}-${Date.now().toString().slice(-4)}`;
    const newNode: CanvasNode = {
      id: newId,
      type,
      position: { x: Math.round(-pan.x / zoom + 350), y: Math.round(-pan.y / zoom + 200) },
      data: { label, endpoint: 'http://localhost:3588', priority: 20 },
    };
    setNodes((prev) => [...prev, newNode]);
    setSelectedNodeId(newId);
    showToast(`Added ${label} to canvas`);
  }

  // Delete Selected Node
  function handleDeleteSelected() {
    if (!selectedNodeId) return;
    setNodes((prev) => prev.filter((n) => n.id !== selectedNodeId));
    setEdges((prev) => prev.filter((e) => e.source !== selectedNodeId && e.target !== selectedNodeId));
    setSelectedNodeId(null);
    showToast('Deleted node from canvas');
  }

  // Filtered layouts for browser modal
  const filteredLayouts = useMemo(() => {
    return EXAMPLE_LAYOUTS.filter((l) => {
      const matchesCat = browserCategory === 'all' || l.category === browserCategory;
      const q = browserSearch.toLowerCase().trim();
      const matchesSearch =
        !q ||
        l.name.toLowerCase().includes(q) ||
        (l.description || '').toLowerCase().includes(q) ||
        (l.tags || []).some((t) => t.toLowerCase().includes(q));
      return matchesCat && matchesSearch;
    });
  }, [browserCategory, browserSearch]);

  return (
    <div
      className="flex flex-col h-[750px] w-full rounded-2xl border border-slate-800 bg-slate-950 text-slate-100 overflow-hidden font-sans relative select-none"
      onMouseMove={handleMouseMove}
      onMouseUp={handleMouseUp}
    >
      {/* Toast Notification */}
      {toastMessage && (
        <div className="absolute top-16 right-6 z-50 rounded-xl border border-sky-500/50 bg-slate-900/95 px-4 py-2.5 text-xs font-semibold text-sky-300 shadow-2xl backdrop-blur animate-in fade-in">
          ✓ {toastMessage}
        </div>
      )}

      {/* 1. Top Navigation & Action Bar (Matching real Router Editor) */}
      <header className="px-5 py-3 border-b border-slate-800 bg-slate-900/95 flex flex-wrap justify-between items-center gap-3 z-30">
        <div className="flex items-center gap-3">
          <div className="flex items-center gap-2">
            <span className="text-xl">⚡</span>
            <div>
              <div className="flex items-center gap-2">
                <span className="text-xs font-bold text-slate-100">
                  Visual Node Routing Editor
                </span>
                <span className="bg-sky-500/10 text-sky-400 border border-sky-500/30 text-[10px] font-mono px-2 py-0.2 rounded-full font-bold">
                  Eluvix v0.1
                </span>
              </div>
              <p className="text-[10px] text-slate-400">
                Drag, connect, and compile execution graphs using Switchyard, Semantic Router, and Gateways.
              </p>
            </div>
          </div>
        </div>

        <div className="flex items-center gap-2 text-xs">
          <div className="hidden xl:flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-slate-800/80 border border-slate-700/80 text-[10px] text-slate-300 font-mono">
            <span>📁</span>
            <span>~/.config/eluvix/layouts</span>
          </div>

          <div className="flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-emerald-950/60 border border-emerald-600/40 text-[10px] text-emerald-400 font-mono font-semibold">
            <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse" />
            <span>Proxy Active: :3588/api/v1</span>
          </div>
        </div>
      </header>

      {/* 2. Sub-Header: Template Bar & Controls */}
      <div className="px-5 py-2.5 border-b border-slate-800/90 bg-slate-950/90 flex flex-wrap items-center justify-between gap-3 z-20 text-xs">
        <div className="flex items-center gap-2.5">
          <span className="text-slate-400 font-mono text-[11px]">Layout:</span>
          <span className="font-bold text-white text-xs">{currentLayout.name}</span>
          <span className="text-[10px] font-mono px-1.5 py-0.2 rounded bg-slate-800 text-sky-400">
            {currentLayout.id}.json
          </span>
          <span className="text-[9px] font-mono px-1.5 py-0.2 rounded bg-emerald-500/20 text-emerald-400 font-bold">
            ACTIVE
          </span>
        </div>

        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => setIsBrowserOpen(true)}
            className="flex items-center gap-1.5 px-3 py-1 rounded-lg bg-sky-500/10 hover:bg-sky-500/20 border border-sky-500/30 text-sky-400 font-bold transition"
          >
            <span>📁</span>
            <span>Browse Templates (12)</span>
          </button>

          <button
            type="button"
            onClick={() => {
              setNodes([
                { id: 'input-1', type: 'inputNode', position: { x: 80, y: 200 }, data: { label: 'Client Input' } },
                { id: 'switchyard-1', type: 'switchyardNode', position: { x: 420, y: 180 }, data: { strategy: 'cost-complexity' } },
              ]);
              setEdges([{ id: 'e1', source: 'input-1', target: 'switchyard-1', animated: true, style: { stroke: '#3b82f6' } }]);
              showToast('Created new canvas');
            }}
            className="px-2.5 py-1 rounded-lg bg-slate-850 hover:bg-slate-800 text-slate-300 transition"
          >
            + New Canvas
          </button>

          <button
            type="button"
            onClick={() => showToast('Applied execution graph to live Switchyard daemon')}
            className="px-3 py-1 rounded-lg bg-emerald-500 hover:bg-emerald-400 text-slate-950 font-bold shadow-sm transition"
          >
            🚀 Apply to Switchyard
          </button>

          {selectedNodeId && (
            <button
              type="button"
              onClick={handleDeleteSelected}
              className="px-2.5 py-1 rounded-lg bg-red-500/10 hover:bg-red-500/20 border border-red-500/30 text-red-400 transition"
            >
              🗑 Delete Node
            </button>
          )}
        </div>
      </div>

      {/* 3. Main Body: Left Toolbox Sidebar + Center Infinite Canvas */}
      <div className="flex flex-1 overflow-hidden relative">
        {/* Left Sidebar: 🧰 Node Toolbox */}
        <div className="w-64 sm:w-72 border-r border-slate-800 bg-slate-900/95 p-3.5 flex flex-col gap-3.5 overflow-y-auto shrink-0 select-none z-20 text-xs">
          <div className="border-b border-slate-800 pb-2.5">
            <h2 className="font-bold text-xs text-white flex items-center gap-1.5 uppercase tracking-wider">
              <span>🧰</span> Node Toolbox
            </h2>
            <div className="text-[10px] text-slate-400 mt-0.5">Click &quot;+ Add&quot; to drop a node onto the canvas</div>
          </div>

          {/* Group 1: Security & Guardrails */}
          <div>
            <div className="flex items-center justify-between mb-1.5 text-[11px] font-semibold text-emerald-400 uppercase tracking-wider">
              <span>🛡️ Guardrails &amp; Filters</span>
              <span className="text-[9px] bg-emerald-500/20 text-emerald-300 px-1 py-0.2 rounded font-mono">Security</span>
            </div>

            <div className="space-y-1.5">
              <div
                onClick={() => handleAddNode('privacyGuardNode', 'Privacy & PII Guard')}
                className="p-2 border border-emerald-500/60 bg-emerald-950/20 hover:bg-emerald-900/30 rounded-lg cursor-pointer transition flex items-center justify-between group"
              >
                <div className="flex items-center gap-2">
                  <span className="text-base">🛡️</span>
                  <div>
                    <div className="font-semibold text-xs text-emerald-300">Privacy &amp; PII Guard</div>
                    <div className="text-[9px] text-slate-400 font-mono">Regex &amp; NER PII Redactor</div>
                  </div>
                </div>
                <span className="text-[10px] text-slate-400 group-hover:text-emerald-400 font-mono font-bold">+ Add</span>
              </div>

              <div
                onClick={() => handleAddNode('semanticGuardNode', 'Semantic Guard')}
                className="p-2 border border-orange-500/60 bg-orange-950/20 hover:bg-orange-900/30 rounded-lg cursor-pointer transition flex items-center justify-between group"
              >
                <div className="flex items-center gap-2">
                  <span className="text-base">🎯</span>
                  <div>
                    <div className="font-semibold text-xs text-orange-300">Semantic Guard</div>
                    <div className="text-[9px] text-slate-400 font-mono">Embedding Injection Filter</div>
                  </div>
                </div>
                <span className="text-[10px] text-slate-400 group-hover:text-orange-400 font-mono font-bold">+ Add</span>
              </div>

              <div
                onClick={() => handleAddNode('taskRouterNode', 'Task Router')}
                className="p-2 border border-amber-500/60 bg-amber-950/20 hover:bg-amber-900/30 rounded-lg cursor-pointer transition flex items-center justify-between group"
              >
                <div className="flex items-center gap-2">
                  <span className="text-base">🔀</span>
                  <div>
                    <div className="font-semibold text-xs text-amber-300">Task Router</div>
                    <div className="text-[9px] text-slate-400 font-mono">Complexity &amp; Intent Dispatch</div>
                  </div>
                </div>
                <span className="text-[10px] text-slate-400 group-hover:text-amber-400 font-mono font-bold">+ Add</span>
              </div>
            </div>
          </div>

          {/* Group 2: Local LLM Engines */}
          <div>
            <div className="flex items-center justify-between mb-1.5 text-[11px] font-semibold text-yellow-400 uppercase tracking-wider">
              <span>Local LLM Engines</span>
              <span className="text-[9px] bg-yellow-500/20 text-yellow-300 px-1 py-0.2 rounded font-mono">Self-Hosted</span>
            </div>

            <div className="space-y-1.5">
              <div
                onClick={() => handleAddNode('lemonadeNode', 'Lemonade Local')}
                className="p-2 border border-yellow-500/60 bg-yellow-950/20 hover:bg-yellow-900/30 rounded-lg cursor-pointer transition flex items-center justify-between group"
              >
                <div className="flex items-center gap-2">
                  <span className="text-base">🍋</span>
                  <div>
                    <div className="font-semibold text-xs text-yellow-300">Lemonade Local</div>
                    <div className="text-[9px] text-slate-400 font-mono">:13305 • Multi-Model</div>
                  </div>
                </div>
                <span className="text-[10px] text-slate-400 group-hover:text-yellow-400 font-mono font-bold">+ Add</span>
              </div>

              <div
                onClick={() => handleAddNode('vllmNode', 'vLLM Engine')}
                className="p-2 border border-cyan-500/60 bg-cyan-950/20 hover:bg-cyan-900/30 rounded-lg cursor-pointer transition flex items-center justify-between group"
              >
                <div className="flex items-center gap-2">
                  <span className="text-base">⚡</span>
                  <div>
                    <div className="font-semibold text-xs text-cyan-300">vLLM Engine</div>
                    <div className="text-[9px] text-slate-400 font-mono">:8000 • PagedAttention</div>
                  </div>
                </div>
                <span className="text-[10px] text-slate-400 group-hover:text-cyan-400 font-mono font-bold">+ Add</span>
              </div>

              <div
                onClick={() => handleAddNode('ollamaNode', 'Ollama Engine')}
                className="p-2 border border-purple-500/60 bg-purple-950/20 hover:bg-purple-900/30 rounded-lg cursor-pointer transition flex items-center justify-between group"
              >
                <div className="flex items-center gap-2">
                  <span className="text-base">🦙</span>
                  <div>
                    <div className="font-semibold text-xs text-purple-300">Ollama Engine</div>
                    <div className="text-[9px] text-slate-400 font-mono">:11434 • GGUF Runner</div>
                  </div>
                </div>
                <span className="text-[10px] text-slate-400 group-hover:text-purple-400 font-mono font-bold">+ Add</span>
              </div>
            </div>
          </div>

          {/* Group 3: Agentic Executors */}
          <div>
            <div className="flex items-center justify-between mb-1.5 text-[11px] font-semibold text-cyan-400 uppercase tracking-wider">
              <span>Autonomous Agents</span>
              <span className="text-[9px] bg-cyan-500/20 text-cyan-300 px-1 py-0.2 rounded font-mono">Agentic</span>
            </div>

            <div className="space-y-1.5">
              <div
                onClick={() => handleAddNode('antigravityNode', 'Google Antigravity Agent')}
                className="p-2 border border-cyan-500/60 bg-cyan-950/20 hover:bg-cyan-900/30 rounded-lg cursor-pointer transition flex items-center justify-between group"
              >
                <div className="flex items-center gap-2">
                  <span className="text-base">🚀</span>
                  <div>
                    <div className="font-semibold text-xs text-cyan-300">Antigravity (AGY)</div>
                    <div className="text-[9px] text-slate-400 font-mono">Gemini 3.8 • CLI agy</div>
                  </div>
                </div>
                <span className="text-[10px] text-slate-400 group-hover:text-cyan-400 font-mono font-bold">+ Add</span>
              </div>

              <div
                onClick={() => handleAddNode('claudeCodeNode', 'Claude Code Agent')}
                className="p-2 border border-amber-500/60 bg-amber-950/20 hover:bg-amber-900/30 rounded-lg cursor-pointer transition flex items-center justify-between group"
              >
                <div className="flex items-center gap-2">
                  <span className="text-base">🧠</span>
                  <div>
                    <div className="font-semibold text-xs text-amber-300">Claude Code</div>
                    <div className="text-[9px] text-slate-400 font-mono">Sonnet 3.7 • CLI</div>
                  </div>
                </div>
                <span className="text-[10px] text-slate-400 group-hover:text-amber-400 font-mono font-bold">+ Add</span>
              </div>

              <div
                onClick={() => handleAddNode('codexNode', 'OpenAI Codex')}
                className="p-2 border border-emerald-500/60 bg-emerald-950/20 hover:bg-emerald-900/30 rounded-lg cursor-pointer transition flex items-center justify-between group"
              >
                <div className="flex items-center gap-2">
                  <span className="text-base">🤖</span>
                  <div>
                    <div className="font-semibold text-xs text-emerald-300">OpenAI Codex</div>
                    <div className="text-[9px] text-slate-400 font-mono">o3-mini • Sandbox</div>
                  </div>
                </div>
                <span className="text-[10px] text-slate-400 group-hover:text-emerald-400 font-mono font-bold">+ Add</span>
              </div>
            </div>
          </div>

          {/* Group 4: Gateways & Tools */}
          <div>
            <div className="flex items-center justify-between mb-1.5 text-[11px] font-semibold text-sky-400 uppercase tracking-wider">
              <span>Gateways &amp; Sinks</span>
              <span className="text-[9px] bg-sky-500/20 text-sky-300 px-1 py-0.2 rounded font-mono">Infra</span>
            </div>

            <div className="space-y-1.5">
              <div
                onClick={() => handleAddNode('switchyardNode', 'Switchyard Engine')}
                className="p-2 border border-blue-500/60 bg-blue-950/20 hover:bg-blue-900/30 rounded-lg cursor-pointer transition flex items-center justify-between group"
              >
                <div className="flex items-center gap-2">
                  <span className="text-base">⚡</span>
                  <div>
                    <div className="font-semibold text-xs text-blue-300">Switchyard Router</div>
                    <div className="text-[9px] text-slate-400 font-mono">Cost &amp; Latency Arbiter</div>
                  </div>
                </div>
                <span className="text-[10px] text-slate-400 group-hover:text-blue-400 font-mono font-bold">+ Add</span>
              </div>

              <div
                onClick={() => handleAddNode('observabilityNode', 'Observability Sink')}
                className="p-2 border border-slate-600 bg-slate-900 hover:bg-slate-800 rounded-lg cursor-pointer transition flex items-center justify-between group"
              >
                <div className="flex items-center gap-2">
                  <span className="text-base">📊</span>
                  <div>
                    <div className="font-semibold text-xs text-slate-200">Observability Sink</div>
                    <div className="text-[9px] text-slate-400 font-mono">SQLite Cryptographic Log</div>
                  </div>
                </div>
                <span className="text-[10px] text-slate-400 group-hover:text-white font-mono font-bold">+ Add</span>
              </div>
            </div>
          </div>
        </div>

        {/* Center: Infinite Canvas */}
        <div
          ref={canvasRef}
          onMouseDown={handleCanvasMouseDown}
          className="flex-1 relative overflow-hidden bg-slate-950 cursor-grab active:cursor-grabbing"
          style={{
            backgroundImage: 'radial-gradient(circle, #334155 1px, transparent 1px)',
            backgroundSize: '24px 24px',
          }}
        >
          {/* Zoom & Canvas Controls */}
          <div className="absolute bottom-4 left-4 z-20 flex items-center gap-1.5 bg-slate-900/90 border border-slate-800 p-1.5 rounded-xl text-xs font-mono backdrop-blur shadow-lg">
            <button
              type="button"
              onClick={() => setZoom((z) => Math.max(0.4, z - 0.1))}
              className="w-7 h-7 flex items-center justify-center rounded hover:bg-slate-850 text-slate-300 font-bold"
            >
              -
            </button>
            <span className="px-1 text-slate-300 text-[11px]">{Math.round(zoom * 100)}%</span>
            <button
              type="button"
              onClick={() => setZoom((z) => Math.min(1.4, z + 0.1))}
              className="w-7 h-7 flex items-center justify-center rounded hover:bg-slate-850 text-slate-300 font-bold"
            >
              +
            </button>
            <button
              type="button"
              onClick={() => { setZoom(0.85); setPan({ x: 30, y: 30 }); }}
              className="px-2 py-1 rounded hover:bg-slate-850 text-slate-400 hover:text-white text-[10px]"
            >
              Reset
            </button>
          </div>

          {/* SVG Connecting Wires Layer */}
          <svg
            className="absolute inset-0 pointer-events-none w-full h-full overflow-visible"
            style={{
              transform: `translate(${pan.x}px, ${pan.y}px) scale(${zoom})`,
              transformOrigin: '0 0',
            }}
          >
            <defs>
              <linearGradient id="edge-grad" x1="0%" y1="0%" x2="100%" y2="0%">
                <stop offset="0%" stopColor="#38bdf8" />
                <stop offset="100%" stopColor="#10b981" />
              </linearGradient>
            </defs>

            {edges.map((edge) => {
              const srcNode = nodes.find((n) => n.id === edge.source);
              const tgtNode = nodes.find((n) => n.id === edge.target);
              if (!srcNode || !tgtNode) return null;

              // Node dimensions approx: w=290, h=160
              const x1 = srcNode.position.x + 290;
              const y1 = srcNode.position.y + 80;
              const x2 = tgtNode.position.x;
              const y2 = tgtNode.position.y + 80;

              const dx = Math.abs(x2 - x1) * 0.5;
              const pathData = `M ${x1} ${y1} C ${x1 + dx} ${y1}, ${x2 - dx} ${y2}, ${x2} ${y2}`;
              const strokeColor = edge.style?.stroke || '#38bdf8';

              return (
                <g key={edge.id}>
                  {/* Glowing background path */}
                  <path
                    d={pathData}
                    fill="none"
                    stroke={strokeColor}
                    strokeWidth="4"
                    strokeOpacity="0.25"
                  />
                  {/* Crisp foreground path */}
                  <path
                    d={pathData}
                    fill="none"
                    stroke={strokeColor}
                    strokeWidth="2"
                    strokeDasharray={edge.animated ? '6, 6' : undefined}
                    className={edge.animated ? 'animate-[dash_1.5s_linear_infinite]' : ''}
                  />
                </g>
              );
            })}
          </svg>

          {/* Canvas Nodes Layer */}
          <div
            className="absolute inset-0 pointer-events-none"
            style={{
              transform: `translate(${pan.x}px, ${pan.y}px) scale(${zoom})`,
              transformOrigin: '0 0',
            }}
          >
            {nodes.map((node) => {
              const isSelected = selectedNodeId === node.id;

              return (
                <div
                  key={node.id}
                  onMouseDown={(e) => handleNodeMouseDown(e, node.id)}
                  style={{
                    transform: `translate(${node.position.x}px, ${node.position.y}px)`,
                  }}
                  className={`absolute pointer-events-auto transition-shadow ${
                    isSelected ? 'ring-2 ring-sky-400 shadow-[0_0_25px_rgba(56,189,248,0.3)]' : ''
                  }`}
                >
                  {/* Render Exact Node Card based on node.type */}
                  {node.type === 'privacyGuardNode' && (
                    <div className="bg-gray-900 border-2 border-emerald-500 rounded-lg p-3.5 w-72 shadow-2xl">
                      <div className="flex items-center justify-between pb-2 mb-2 border-b border-gray-800">
                        <div className="flex items-center gap-1.5">
                          <span className="text-lg">🛡️</span>
                          <div>
                            <div className="font-bold text-emerald-400 text-xs">Privacy &amp; PII Guard</div>
                            <div className="text-[9px] text-gray-400 font-mono">Zero-Knowledge Token Sanitizer</div>
                          </div>
                        </div>
                        <span className="text-[9px] bg-emerald-500/20 text-emerald-300 px-1.5 py-0.2 rounded font-mono font-bold">
                          ANONYMIZE
                        </span>
                      </div>
                      <div className="text-xs text-gray-300 space-y-2">
                        <div className="grid grid-cols-2 gap-2 text-[10px]">
                          <div>
                            <span className="text-gray-400 font-mono">Action:</span>
                            <div className="p-1 rounded bg-gray-950 text-white font-mono mt-0.5">🎭 Redact In-Flight</div>
                          </div>
                          <div>
                            <span className="text-gray-400 font-mono">Style:</span>
                            <div className="p-1 rounded bg-gray-950 text-emerald-400 font-mono mt-0.5">🏷️ [TOKEN]</div>
                          </div>
                        </div>
                        <div className="grid grid-cols-3 gap-1 pt-1.5 border-t border-gray-800 text-[9px] font-mono text-gray-400">
                          <span className="text-emerald-400">✓ API Keys</span>
                          <span className="text-emerald-400">✓ SSN</span>
                          <span className="text-emerald-400">✓ Credit Card</span>
                          <span className="text-emerald-400">✓ Email</span>
                          <span className="text-emerald-400">✓ Phone</span>
                          <span className="text-emerald-400">✓ IP Addr</span>
                        </div>
                      </div>
                    </div>
                  )}

                  {node.type === 'semanticGuardNode' && (
                    <div className="bg-gray-900 border-2 border-orange-500 rounded-lg p-3.5 w-72 shadow-2xl">
                      <div className="flex items-center justify-between pb-2 mb-2 border-b border-gray-800">
                        <div className="flex items-center gap-1.5">
                          <span className="text-lg">🎯</span>
                          <div>
                            <div className="font-bold text-orange-400 text-xs">Semantic Guard</div>
                            <div className="text-[9px] text-gray-400 font-mono">Embedding Injection Filter</div>
                          </div>
                        </div>
                        <span className="text-[9px] bg-orange-500/20 text-orange-300 px-1.5 py-0.2 rounded font-mono font-bold">
                          0.85
                        </span>
                      </div>
                      <div className="text-xs text-gray-300 space-y-1.5 font-mono text-[10px]">
                        <div>Encoder: <strong className="text-white">deberta-v3-injection</strong></div>
                        <div>Action: <strong className="text-orange-400">BLOCK (400)</strong></div>
                        <div className="text-[9px] text-gray-400 pt-1 border-t border-gray-800">
                          ✓ Instruction Override • ✓ DAN Jailbreak • ✓ System Prompt Leak
                        </div>
                      </div>
                    </div>
                  )}

                  {node.type === 'switchyardNode' && (
                    <div className="bg-gray-900 border-2 border-blue-500 rounded-lg p-3.5 w-76 shadow-2xl">
                      <div className="flex items-center justify-between pb-2 mb-2 border-b border-gray-800">
                        <div className="flex items-center gap-1.5">
                          <span className="text-lg">⚡</span>
                          <div>
                            <div className="font-bold text-blue-400 text-xs">Switchyard Engine</div>
                            <div className="text-[9px] text-gray-400 font-mono">Cost &amp; Complexity Arbiter</div>
                          </div>
                        </div>
                        <span className="text-[9px] bg-blue-500/20 text-blue-300 px-1.5 py-0.2 rounded font-mono font-bold">
                          CASCADE
                        </span>
                      </div>
                      <div className="text-xs space-y-1 font-mono text-[10px]">
                        <div className="p-1 rounded bg-emerald-950/40 text-emerald-400 border border-emerald-500/30 flex justify-between">
                          <span>Tier 1: Local Fast (Lemonade)</span>
                          <strong>$0.00</strong>
                        </div>
                        <div className="p-1 rounded bg-yellow-950/40 text-yellow-400 border border-yellow-500/30 flex justify-between">
                          <span>Tier 2: Local Reasoning (Ollama)</span>
                          <strong>$0.00</strong>
                        </div>
                        <div className="p-1 rounded bg-cyan-950/40 text-cyan-400 border border-cyan-500/30 flex justify-between">
                          <span>Tier 3: Google Antigravity AGY</span>
                          <strong>$0.00</strong>
                        </div>
                        <div className="p-1 rounded bg-amber-950/40 text-amber-400 border border-amber-500/30 flex justify-between">
                          <span>Tier 4: Claude Code Frontier</span>
                          <strong>Frontier</strong>
                        </div>
                      </div>
                    </div>
                  )}

                  {node.type === 'lemonadeNode' && (
                    <div className="bg-gray-900 border-2 border-yellow-500 rounded-lg p-3 w-72 shadow-2xl">
                      <div className="flex items-center justify-between pb-1.5 mb-1.5 border-b border-gray-800">
                        <div className="flex items-center gap-1.5">
                          <span className="text-lg">🍋</span>
                          <div>
                            <div className="font-bold text-yellow-400 text-xs">{node.data?.label || 'Lemonade Engine'}</div>
                            <div className="text-[9px] text-gray-400 font-mono">{node.data?.endpoint || ':13305'}</div>
                          </div>
                        </div>
                        <span className="text-[9px] bg-yellow-500/20 text-yellow-300 px-1 py-0.2 rounded font-mono font-bold">
                          PRIORITY {node.data?.priority || 30}
                        </span>
                      </div>
                      <div className="text-[10px] font-mono text-slate-300">
                        Model: <strong className="text-yellow-300">{node.data?.selectedModel || '*'}</strong>
                        <div className="text-[9px] text-emerald-400 mt-1">✓ Zero-Cost Local Hardware</div>
                      </div>
                    </div>
                  )}

                  {node.type === 'ollamaNode' && (
                    <div className="bg-gray-900 border-2 border-purple-500 rounded-lg p-3 w-72 shadow-2xl">
                      <div className="flex items-center justify-between pb-1.5 mb-1.5 border-b border-gray-800">
                        <div className="flex items-center gap-1.5">
                          <span className="text-lg">🦙</span>
                          <div>
                            <div className="font-bold text-purple-400 text-xs">{node.data?.label || 'Ollama Engine'}</div>
                            <div className="text-[9px] text-gray-400 font-mono">{node.data?.endpoint || ':11434'}</div>
                          </div>
                        </div>
                        <span className="text-[9px] bg-purple-500/20 text-purple-300 px-1 py-0.2 rounded font-mono font-bold">
                          PRIORITY {node.data?.priority || 25}
                        </span>
                      </div>
                      <div className="text-[10px] font-mono text-slate-300">
                        Model: <strong className="text-purple-300">{node.data?.selectedModel || '*'}</strong>
                        <div className="text-[9px] text-emerald-400 mt-1">✓ GGUF Quantized Runner ($0)</div>
                      </div>
                    </div>
                  )}

                  {node.type === 'vllmNode' && (
                    <div className="bg-gray-900 border-2 border-cyan-500 rounded-lg p-3 w-72 shadow-2xl">
                      <div className="flex items-center justify-between pb-1.5 mb-1.5 border-b border-gray-800">
                        <div className="flex items-center gap-1.5">
                          <span className="text-lg">⚡</span>
                          <div>
                            <div className="font-bold text-cyan-400 text-xs">{node.data?.label || 'vLLM Engine'}</div>
                            <div className="text-[9px] text-gray-400 font-mono">{node.data?.endpoint || ':8000'}</div>
                          </div>
                        </div>
                        <span className="text-[9px] bg-cyan-500/20 text-cyan-300 px-1 py-0.2 rounded font-mono font-bold">
                          PAGED ATTN
                        </span>
                      </div>
                      <div className="text-[10px] font-mono text-slate-300">
                        Model: <strong className="text-cyan-300">{node.data?.selectedModel || '*'}</strong>
                        <div className="text-[9px] text-emerald-400 mt-1">✓ High Throughput Speculative ($0)</div>
                      </div>
                    </div>
                  )}

                  {node.type === 'antigravityNode' && (
                    <div className="bg-gray-900 border-2 border-cyan-400 rounded-lg p-3.5 w-76 shadow-2xl">
                      <div className="flex items-center justify-between pb-2 mb-2 border-b border-gray-800">
                        <div className="flex items-center gap-1.5">
                          <span className="text-lg">🚀</span>
                          <div>
                            <div className="font-bold text-cyan-300 text-xs">Google Antigravity Agent</div>
                            <div className="text-[9px] text-gray-400 font-mono">Autonomous Coding Suite</div>
                          </div>
                        </div>
                        <span className="text-[9px] bg-cyan-500/20 text-cyan-300 px-1.5 py-0.2 rounded font-mono font-bold">
                          AGY CLI
                        </span>
                      </div>
                      <div className="text-[10px] font-mono space-y-1 text-slate-300">
                        <div>Model: <strong className="text-white">{node.data?.model || 'gemini-3.8-flash'}</strong></div>
                        <div>Extended Thinking: <strong className="text-cyan-400">Budget 2048</strong></div>
                        <div>Subagents: <strong className="text-emerald-400">Enabled (Depth 2)</strong></div>
                      </div>
                    </div>
                  )}

                  {node.type === 'claudeCodeNode' && (
                    <div className="bg-gray-900 border-2 border-amber-500 rounded-lg p-3.5 w-76 shadow-2xl">
                      <div className="flex items-center justify-between pb-2 mb-2 border-b border-gray-800">
                        <div className="flex items-center gap-1.5">
                          <span className="text-lg">🧠</span>
                          <div>
                            <div className="font-bold text-amber-300 text-xs">Claude Code Agent</div>
                            <div className="text-[9px] text-gray-400 font-mono">Terminal Pair-Programmer</div>
                          </div>
                        </div>
                        <span className="text-[9px] bg-amber-500/20 text-amber-300 px-1.5 py-0.2 rounded font-mono font-bold">
                          FRONTIER
                        </span>
                      </div>
                      <div className="text-[10px] font-mono space-y-1 text-slate-300">
                        <div>Model: <strong className="text-white">{node.data?.model || 'claude-3-7-sonnet'}</strong></div>
                        <div>Permissions: <strong className="text-amber-400">Accept Non-Destructive</strong></div>
                        <div>Extended Thinking: <strong className="text-amber-300">Budget 4096</strong></div>
                      </div>
                    </div>
                  )}

                  {node.type === 'observabilityNode' && (
                    <div className="bg-gray-900 border-2 border-slate-600 rounded-lg p-3 w-72 shadow-2xl">
                      <div className="flex items-center justify-between pb-1.5 mb-1.5 border-b border-gray-800">
                        <div className="flex items-center gap-1.5">
                          <span className="text-lg">📊</span>
                          <div>
                            <div className="font-bold text-slate-200 text-xs">Observability Sink</div>
                            <div className="text-[9px] text-gray-400 font-mono">SQLite Exporter</div>
                          </div>
                        </div>
                        <span className="text-[9px] bg-slate-800 text-slate-300 px-1 py-0.2 rounded font-mono font-bold">
                          AUDIT
                        </span>
                      </div>
                      <div className="text-[10px] font-mono text-slate-400 space-y-0.5">
                        <div>Project: <strong className="text-white">{node.data?.projectName || 'eluvix-prod'}</strong></div>
                        <div>Capture Inputs: <strong className="text-emerald-400">Sanitized Only</strong></div>
                      </div>
                    </div>
                  )}

                  {node.type === 'inputNode' && (
                    <div className="bg-gray-900 border-2 border-slate-700 rounded-lg p-3 w-48 shadow-xl">
                      <div className="flex items-center gap-1.5 font-bold text-xs text-white">
                        <span>📥</span>
                        <span>Client Input</span>
                      </div>
                      <div className="text-[9px] font-mono text-sky-400 mt-1">
                        127.0.0.1:3588/v1
                      </div>
                    </div>
                  )}

                  {/* Fallback for other node types */}
                  {!['privacyGuardNode', 'semanticGuardNode', 'switchyardNode', 'lemonadeNode', 'ollamaNode', 'vllmNode', 'antigravityNode', 'claudeCodeNode', 'observabilityNode', 'inputNode'].includes(node.type) && (
                    <div className="bg-gray-900 border-2 border-slate-700 rounded-lg p-3 w-64 shadow-xl">
                      <div className="font-bold text-xs text-white">{node.data?.label || node.type}</div>
                      <div className="text-[10px] font-mono text-slate-400">{node.type}</div>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      </div>

      {/* 4. Layout Browser Modal (All 12 Real Production Templates) */}
      {isBrowserOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm p-4 animate-in fade-in">
          <div className="w-full max-w-4xl max-h-[85vh] rounded-2xl border border-slate-800 bg-slate-900 flex flex-col overflow-hidden shadow-2xl">
            {/* Modal Header */}
            <div className="p-5 border-b border-slate-800 flex items-center justify-between">
              <div>
                <h3 className="text-base font-bold text-white flex items-center gap-2">
                  <span>📁 Layout &amp; Topology Template Browser</span>
                  <span className="text-xs font-mono px-2 py-0.5 rounded bg-sky-500/20 text-sky-400 font-bold">
                    12 Templates Available
                  </span>
                </h3>
                <p className="text-xs text-slate-400 mt-0.5">
                  Browse and switch execution graphs across local, hybrid, airgapped, and multi-agent topologies.
                </p>
              </div>

              <button
                type="button"
                onClick={() => setIsBrowserOpen(false)}
                className="text-slate-400 hover:text-white text-lg font-bold"
              >
                ✕
              </button>
            </div>

            {/* Filter & Search Bar */}
            <div className="p-4 border-b border-slate-800 bg-slate-950/60 flex flex-col sm:flex-row items-center justify-between gap-3">
              {/* Category Pills */}
              <div className="flex items-center gap-1.5 overflow-x-auto w-full sm:w-auto pb-1 sm:pb-0 scrollbar-none text-xs">
                {[
                  { id: 'all', label: 'All Layouts' },
                  { id: 'starter', label: 'Starters' },
                  { id: 'local', label: 'Local Inference' },
                  { id: 'hybrid', label: 'Hybrid & Coding' },
                  { id: 'agent', label: 'Autonomous Agents' },
                  { id: 'cost', label: 'Cost Cascades' },
                  { id: 'privacy', label: 'Privacy & Airgap' },
                ].map((cat) => (
                  <button
                    key={cat.id}
                    type="button"
                    onClick={() => setBrowserCategory(cat.id)}
                    className={`px-2.5 py-1 rounded-lg font-semibold whitespace-nowrap transition ${
                      browserCategory === cat.id
                        ? 'bg-sky-500 text-slate-950 font-bold'
                        : 'bg-slate-900 border border-slate-800 text-slate-400 hover:text-white'
                    }`}
                  >
                    {cat.label}
                  </button>
                ))}
              </div>

              <input
                type="text"
                value={browserSearch}
                onChange={(e) => setBrowserSearch(e.target.value)}
                placeholder="Search templates by name, tags..."
                className="w-full sm:w-64 rounded-xl border border-slate-800 bg-slate-900 px-3 py-1.5 text-xs text-white placeholder-slate-500 focus:outline-none focus:border-sky-500"
              />
            </div>

            {/* Templates Grid List */}
            <div className="flex-1 overflow-y-auto p-5 grid grid-cols-1 md:grid-cols-2 gap-4">
              {filteredLayouts.map((tmpl) => {
                const isActive = currentLayout.id === tmpl.id;

                return (
                  <div
                    key={tmpl.id}
                    className={`p-4 rounded-xl border flex flex-col justify-between transition ${
                      isActive
                        ? 'border-sky-500 bg-sky-950/30'
                        : 'border-slate-800 bg-slate-950/60 hover:border-slate-700 hover:bg-slate-950/90'
                    }`}
                  >
                    <div>
                      <div className="flex items-center justify-between gap-2 mb-1.5">
                        <span className="font-bold text-sm text-white">{tmpl.name}</span>
                        <span className="text-[10px] font-mono px-2 py-0.5 rounded uppercase font-semibold bg-slate-800 text-slate-300">
                          {tmpl.category}
                        </span>
                      </div>

                      <p className="text-xs text-slate-400 leading-relaxed mb-3">
                        {tmpl.description}
                      </p>

                      <div className="flex flex-wrap items-center gap-1.5 mb-4">
                        {tmpl.tags?.map((t) => (
                          <span
                            key={t}
                            className="text-[10px] font-mono px-1.5 py-0.2 rounded bg-slate-900 border border-slate-800 text-slate-400"
                          >
                            #{t}
                          </span>
                        ))}
                      </div>
                    </div>

                    <div className="flex items-center justify-between pt-3 border-t border-slate-850">
                      <div className="text-[11px] font-mono text-slate-400">
                        {tmpl.nodes.length} nodes • {tmpl.edges.length} edges
                      </div>

                      <button
                        type="button"
                        onClick={() => handleSelectTemplate(tmpl)}
                        className={`px-3 py-1.5 rounded-lg text-xs font-bold transition ${
                          isActive
                            ? 'bg-slate-800 text-sky-400 cursor-default'
                            : 'bg-sky-500 hover:bg-sky-400 text-slate-950 shadow-sm'
                        }`}
                      >
                        {isActive ? 'Currently Active' : 'Open Layout ➔'}
                      </button>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
