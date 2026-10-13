"use client";

import { useState, useCallback } from 'react';
import { Handle, Position, useReactFlow } from '@xyflow/react';

export interface AntigravityNodeData {
  label?: string;
  model?: string;
  customModel?: string;
  executionMode?: 'cli' | 'agent-router' | 'custom-http';
  cliPath?: string;
  endpoint?: string;
  sandboxMode?: 'standard' | 'bypass' | 'read-only';
  agentBehavior?: 'autonomous' | 'interactive' | 'planning';
  networkAccess?: boolean;
  workspaceIsolation?: boolean;
  enableWriteTools?: boolean;
  enableMcpTools?: boolean;
  enableSubagents?: boolean;
  maxSubagentDepth?: number;
  enableWebTools?: boolean;
  enableGenerativeUI?: boolean;
  extendedThinking?: boolean;
  thinkingBudget?: number;
  persona?: string;
  systemInstructions?: string;
}

const MODEL_PRESETS = [
  { id: 'gemini-3.8-flash', name: 'Gemini 3.8 Flash (Default - Fast & Reasoning)', tier: 'Standard' },
  { id: 'gemini-3.1-pro', name: 'Gemini 3.1 Pro (Deep Coding & Architecture)', tier: 'Frontier' },
  { id: 'gemini-3.1-flash-lite', name: 'Gemini 3.1 Flash-Lite (Low Latency / Cost)', tier: 'Economy' },
  { id: 'gemini-2.5-pro', name: 'Gemini 2.5 Pro (Deep Analysis)', tier: 'Frontier' },
  { id: 'gemini-2.5-flash', name: 'Gemini 2.5 Flash (Lightweight)', tier: 'Economy' },
  { id: 'claude-3-7-sonnet', name: 'Claude 3.7 Sonnet (Hybrid Reasoning)', tier: 'External' },
  { id: 'custom', name: '✏️ Custom / Local Identifier...', tier: 'Custom' }
];

export default function AntigravityNode({ id, data }: { id: string; data: AntigravityNodeData }) {
  const { updateNodeData } = useReactFlow();
  const [activeTab, setActiveTab] = useState<'model' | 'access' | 'sandbox' | 'tools'>('model');

  const [model, setModel] = useState<string>(data?.model || 'gemini-3.8-flash');
  const [customModel, setCustomModel] = useState<string>(data?.customModel || '');
  const [executionMode, setExecutionMode] = useState<'cli' | 'agent-router' | 'custom-http'>(data?.executionMode || 'cli');
  const [cliPath, setCliPath] = useState<string>(data?.cliPath || 'agy');
  const [endpoint, setEndpoint] = useState<string>(data?.endpoint || 'http://localhost:8002/v1');
  const [sandboxMode, setSandboxMode] = useState<'standard' | 'bypass' | 'read-only'>(data?.sandboxMode || 'standard');
  const [agentBehavior, setAgentBehavior] = useState<'autonomous' | 'interactive' | 'planning'>(data?.agentBehavior || 'autonomous');
  const [networkAccess, setNetworkAccess] = useState<boolean>(data?.networkAccess || false);
  const [workspaceIsolation, setWorkspaceIsolation] = useState<boolean>(data?.workspaceIsolation !== false);
  
  const [enableWriteTools, setEnableWriteTools] = useState<boolean>(data?.enableWriteTools !== false);
  const [enableMcpTools, setEnableMcpTools] = useState<boolean>(data?.enableMcpTools !== false);
  const [enableSubagents, setEnableSubagents] = useState<boolean>(data?.enableSubagents !== false);
  const [maxSubagentDepth, setMaxSubagentDepth] = useState<number>(data?.maxSubagentDepth ?? 2);
  const [enableWebTools, setEnableWebTools] = useState<boolean>(data?.enableWebTools ?? true);
  const [enableGenerativeUI, setEnableGenerativeUI] = useState<boolean>(data?.enableGenerativeUI ?? true);

  const [extendedThinking, setExtendedThinking] = useState<boolean>(data?.extendedThinking ?? true);
  const [thinkingBudget, setThinkingBudget] = useState<number>(data?.thinkingBudget ?? 2048);
  const [persona, setPersona] = useState<string>(data?.persona || 'software-engineer');
  const [systemInstructions, setSystemInstructions] = useState<string>(
    data?.systemInstructions || 'You are an expert autonomous software engineer pair-programming to build production features.'
  );

  // Synchronize state with ReactFlow node data
  const syncData = useCallback((updates: Partial<AntigravityNodeData>) => {
    if (data) {
      Object.assign(data, updates);
    }
    if (id) {
      updateNodeData(id, updates);
    }
  }, [id, data, updateNodeData]);

  // Ensure defaults are assigned on initial render
  if (data) {
    if (!data.model) data.model = model;
    if (!data.executionMode) data.executionMode = executionMode;
    if (!data.cliPath) data.cliPath = cliPath;
    if (!data.endpoint) data.endpoint = endpoint;
    if (!data.sandboxMode) data.sandboxMode = sandboxMode;
    if (!data.agentBehavior) data.agentBehavior = agentBehavior;
    if (data.enableWriteTools === undefined) data.enableWriteTools = enableWriteTools;
  }

  const handleModelChange = (e: React.ChangeEvent<HTMLSelectElement>) => {
    const val = e.target.value;
    setModel(val);
    syncData({ model: val });
  };

  const handleSandboxChange = (e: React.ChangeEvent<HTMLSelectElement>) => {
    const val = e.target.value as 'standard' | 'bypass' | 'read-only';
    setSandboxMode(val);
    if (val === 'read-only') {
      setEnableWriteTools(false);
      setNetworkAccess(false);
      syncData({ sandboxMode: val, enableWriteTools: false, networkAccess: false });
    } else if (val === 'bypass') {
      setNetworkAccess(true);
      setEnableWriteTools(true);
      syncData({ sandboxMode: val, networkAccess: true, enableWriteTools: true });
    } else {
      setNetworkAccess(false);
      syncData({ sandboxMode: val, networkAccess: false });
    }
  };

  const handleBehaviorChange = (e: React.ChangeEvent<HTMLSelectElement>) => {
    const val = e.target.value as 'autonomous' | 'interactive' | 'planning';
    setAgentBehavior(val);
    syncData({ agentBehavior: val });
  };

  const getSandboxBadge = () => {
    switch (sandboxMode) {
      case 'standard':
        return <span className="text-[9px] bg-emerald-500/20 text-emerald-300 border border-emerald-500/40 px-1.5 py-0.5 rounded font-mono">🛡️ Standard Sandbox</span>;
      case 'bypass':
        return <span className="text-[9px] bg-red-500/20 text-red-300 border border-red-500/40 px-1.5 py-0.5 rounded font-mono">⚡ Bypass Sandbox</span>;
      case 'read-only':
        return <span className="text-[9px] bg-blue-500/20 text-blue-300 border border-blue-500/40 px-1.5 py-0.5 rounded font-mono">🔒 Read-Only</span>;
    }
  };

  return (
    <div className="bg-gray-900 border-2 border-cyan-500/80 rounded-xl p-3.5 min-w-[320px] max-w-[360px] shadow-2xl transition hover:shadow-cyan-500/20 hover:border-cyan-400">
      {/* Target input handle */}
      <Handle 
        type="target" 
        position={Position.Left} 
        className="w-3.5 h-3.5 bg-cyan-400 -left-2" 
      />

      {/* Header */}
      <div className="flex items-center justify-between pb-2 mb-2.5 border-b border-gray-800">
        <div className="flex items-center gap-2">
          <span className="text-xl">🪐</span>
          <div>
            <div className="font-bold text-cyan-300 text-sm flex items-center gap-1.5">
              <span>Antigravity Agent</span>
              <span className="text-[10px] bg-cyan-950 text-cyan-300 px-1 py-0.2 border border-cyan-800 rounded font-mono">
                agy
              </span>
            </div>
            <div className="text-[10px] text-gray-400 font-mono">Google AGY Autonomous Engine</div>
          </div>
        </div>
        {getSandboxBadge()}
      </div>

      {/* Navigation Tabs */}
      <div className="flex gap-1 mb-3 bg-gray-950 p-1 rounded-lg border border-gray-800 text-[11px]">
        <button
          type="button"
          onClick={() => setActiveTab('model')}
          className={`flex-1 py-1 px-1 rounded transition font-medium ${
            activeTab === 'model' ? 'bg-cyan-600 text-white shadow-sm' : 'text-gray-400 hover:text-gray-200'
          }`}
        >
          Model
        </button>
        <button
          type="button"
          onClick={() => setActiveTab('access')}
          className={`flex-1 py-1 px-1 rounded transition font-medium ${
            activeTab === 'access' ? 'bg-cyan-600 text-white shadow-sm' : 'text-gray-400 hover:text-gray-200'
          }`}
        >
          Access
        </button>
        <button
          type="button"
          onClick={() => setActiveTab('sandbox')}
          className={`flex-1 py-1 px-1 rounded transition font-medium ${
            activeTab === 'sandbox' ? 'bg-cyan-600 text-white shadow-sm' : 'text-gray-400 hover:text-gray-200'
          }`}
        >
          Sandbox
        </button>
        <button
          type="button"
          onClick={() => setActiveTab('tools')}
          className={`flex-1 py-1 px-1 rounded transition font-medium ${
            activeTab === 'tools' ? 'bg-cyan-600 text-white shadow-sm' : 'text-gray-400 hover:text-gray-200'
          }`}
        >
          Tools
        </button>
      </div>

      {/* Tab 1: Model & Reasoning */}
      {activeTab === 'model' && (
        <div className="space-y-2.5 text-xs text-gray-300">
          <div>
            <label className="block text-[11px] font-semibold text-gray-400 mb-1">Gemini / AGY Model</label>
            <select
              className="nodrag w-full bg-gray-950 border border-gray-700 focus:border-cyan-400 rounded p-1.5 text-white text-xs outline-none cursor-pointer"
              value={model}
              onChange={handleModelChange}
            >
              {MODEL_PRESETS.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
          </div>

          {model === 'custom' && (
            <div>
              <label className="block text-[11px] font-semibold text-cyan-400 mb-1">Custom Model Identifier</label>
              <input
                className="nodrag w-full bg-gray-950 border border-cyan-500/60 focus:border-cyan-400 rounded p-1.5 text-white text-xs outline-none font-mono"
                placeholder="e.g. gemma-4-26b or local-litert"
                value={customModel}
                onChange={(e) => {
                  setCustomModel(e.target.value);
                  syncData({ customModel: e.target.value });
                }}
              />
            </div>
          )}

          {/* Extended Thinking */}
          <div className="p-2 rounded bg-gray-950 border border-gray-800 space-y-1.5">
            <div className="flex items-center justify-between">
              <label className="text-[11px] font-semibold text-gray-300 flex items-center gap-1.5 cursor-pointer">
                <input
                  type="checkbox"
                  checked={extendedThinking}
                  onChange={(e) => {
                    setExtendedThinking(e.target.checked);
                    syncData({ extendedThinking: e.target.checked });
                  }}
                  className="rounded bg-gray-800 border-gray-700 text-cyan-500 focus:ring-0"
                />
                <span>Extended Thinking</span>
              </label>
              <span className="text-[10px] text-cyan-400 font-mono">{thinkingBudget} tokens</span>
            </div>
            {extendedThinking && (
              <input
                type="range"
                min="512"
                max="8192"
                step="512"
                value={thinkingBudget}
                onChange={(e) => {
                  const val = Number(e.target.value);
                  setThinkingBudget(val);
                  syncData({ thinkingBudget: val });
                }}
                className="w-full accent-cyan-400 cursor-pointer h-1.5 bg-gray-800 rounded-lg"
              />
            )}
          </div>

          {/* Persona & System Instructions */}
          <div>
            <label className="block text-[11px] font-semibold text-gray-400 mb-1">Agent Persona</label>
            <select
              className="nodrag w-full bg-gray-950 border border-gray-700 rounded p-1 text-white text-xs outline-none mb-1.5 cursor-pointer"
              value={persona}
              onChange={(e) => {
                const val = e.target.value;
                setPersona(val);
                let instr = systemInstructions;
                if (val === 'software-engineer') instr = 'You are an expert autonomous software engineer pair-programming to build production features.';
                if (val === 'architect') instr = 'You are a principal systems architect designing resilient microservices and distributed graphs.';
                if (val === 'security-auditor') instr = 'You are a cybersecurity expert auditing codebase security, sandbox boundaries, and sanitizing inputs.';
                if (val === 'data-scientist') instr = 'You are an advanced data scientist optimizing ML models, embeddings, and analytics pipelines.';
                setSystemInstructions(instr);
                syncData({ persona: val, systemInstructions: instr });
              }}
            >
              <option value="software-engineer">💻 Software Engineer (Full Stack)</option>
              <option value="architect">🏛️ Principal Systems Architect</option>
              <option value="security-auditor">🛡️ Security Auditor &amp; Red Team</option>
              <option value="data-scientist">📊 Data Scientist &amp; ML Engineer</option>
              <option value="custom">⚙️ Custom System Prompt</option>
            </select>
            <textarea
              rows={2}
              className="nodrag w-full bg-gray-950 border border-gray-800 rounded p-1.5 text-gray-300 text-[11px] outline-none resize-none font-mono"
              value={systemInstructions}
              onChange={(e) => {
                setSystemInstructions(e.target.value);
                syncData({ systemInstructions: e.target.value });
              }}
            />
          </div>
        </div>
      )}

      {/* Tab: Access & Connection Mode */}
      {activeTab === 'access' && (
        <div className="space-y-2.5 text-xs text-gray-300">
          <div>
            <label className="block text-[11px] font-semibold text-gray-400 mb-1">Access Method</label>
            <select
              className="nodrag w-full bg-gray-950 border border-gray-700 focus:border-cyan-400 rounded p-1.5 text-white text-xs outline-none cursor-pointer"
              value={executionMode}
              onChange={(e) => {
                const val = e.target.value as 'cli' | 'agent-router' | 'custom-http';
                setExecutionMode(val);
                const ep = val === 'cli' ? `cli://${cliPath}` : (val === 'agent-router' ? 'http://localhost:8002/v1' : endpoint);
                setEndpoint(ep);
                syncData({ executionMode: val, endpoint: ep });
              }}
            >
              <option value="cli">💻 CLI via agy (Recommended - Zero Daemon)</option>
              <option value="agent-router">🌐 Agent Router Daemon (Port 8002)</option>
              <option value="custom-http">🔗 Custom HTTP Proxy / Daemon</option>
            </select>
          </div>

          {executionMode === 'cli' ? (
            <div className="space-y-2 bg-gray-950 p-2 rounded border border-gray-800">
              <div>
                <label className="block text-[11px] font-semibold text-cyan-400 mb-1">CLI Command / Binary</label>
                <input
                  className="nodrag w-full bg-gray-900 border border-gray-700 focus:border-cyan-400 rounded p-1.5 text-white text-xs outline-none font-mono"
                  placeholder="agy"
                  value={cliPath}
                  onChange={(e) => {
                    const val = e.target.value;
                    setCliPath(val);
                    syncData({ cliPath: val, endpoint: `cli://${val}` });
                  }}
                />
              </div>
              <p className="text-[10px] text-gray-400 leading-relaxed">
                Executes non-interactively via <code className="text-cyan-300 font-mono">agy --print</code>. Does not bind to or require port 8080.
              </p>
            </div>
          ) : (
            <div className="space-y-2 bg-gray-950 p-2 rounded border border-gray-800">
              <div>
                <label className="block text-[11px] font-semibold text-cyan-400 mb-1">Daemon Endpoint</label>
                <input
                  className="nodrag w-full bg-gray-900 border border-gray-700 focus:border-cyan-400 rounded p-1.5 text-white text-xs outline-none font-mono"
                  placeholder="http://localhost:8002/v1"
                  value={endpoint}
                  onChange={(e) => {
                    const val = e.target.value;
                    setEndpoint(val);
                    syncData({ endpoint: val });
                  }}
                />
              </div>
              <p className="text-[10px] text-amber-400/90 leading-relaxed">
                ⚠️ Defaults to port 8002 (eluvix-agent-router). Note that port 8080 is reserved for Switchyard.
              </p>
            </div>
          )}
        </div>
      )}

      {/* Tab 2: Sandbox & Security */}
      {activeTab === 'sandbox' && (
        <div className="space-y-2.5 text-xs text-gray-300">
          <div>
            <label className="block text-[11px] font-semibold text-gray-400 mb-1">Terminal Sandbox Mode</label>
            <select
              className="nodrag w-full bg-gray-950 border border-gray-700 focus:border-cyan-400 rounded p-1.5 text-white text-xs outline-none cursor-pointer"
              value={sandboxMode}
              onChange={handleSandboxChange}
            >
              <option value="standard">🛡️ Standard Sandbox (Isolated, No Net)</option>
              <option value="bypass">⚡ Bypass Sandbox (Full Access, Direct OS)</option>
              <option value="read-only">🔒 Read-Only (Safe Codebase Review)</option>
            </select>
          </div>

          <div>
            <label className="block text-[11px] font-semibold text-gray-400 mb-1">Execution Behavior</label>
            <select
              className="nodrag w-full bg-gray-950 border border-gray-700 focus:border-cyan-400 rounded p-1.5 text-white text-xs outline-none cursor-pointer"
              value={agentBehavior}
              onChange={handleBehaviorChange}
            >
              <option value="autonomous">🤖 Autonomous (Self-directed, End-to-End)</option>
              <option value="interactive">💬 Interactive (Pair-Programming with User)</option>
              <option value="planning">📋 Planning Mode (Formal Plan Approval First)</option>
            </select>
          </div>

          <div className="p-2 rounded bg-gray-950 border border-gray-800 space-y-2">
            <div className="text-[11px] font-semibold text-gray-400">Security Guardrails</div>
            <label className="flex items-center justify-between text-[11px] text-gray-300 cursor-pointer">
              <span>Workspace Isolation (Boundary Lock)</span>
              <input
                type="checkbox"
                checked={workspaceIsolation}
                onChange={(e) => {
                  setWorkspaceIsolation(e.target.checked);
                  syncData({ workspaceIsolation: e.target.checked });
                }}
                className="rounded bg-gray-800 border-gray-700 text-cyan-500 focus:ring-0"
              />
            </label>
            <label className="flex items-center justify-between text-[11px] text-gray-300 cursor-pointer">
              <span>Network Access (Outbound Web/API)</span>
              <input
                type="checkbox"
                disabled={sandboxMode === 'read-only'}
                checked={networkAccess}
                onChange={(e) => {
                  setNetworkAccess(e.target.checked);
                  syncData({ networkAccess: e.target.checked });
                }}
                className="rounded bg-gray-800 border-gray-700 text-cyan-500 focus:ring-0"
              />
            </label>
          </div>
        </div>
      )}

      {/* Tab 3: Tools & Subagents */}
      {activeTab === 'tools' && (
        <div className="space-y-2 text-xs text-gray-300">
          <div className="p-2 rounded bg-gray-950 border border-gray-800 space-y-2">
            <div className="text-[11px] font-semibold text-gray-400">Agent Capabilities</div>

            <label className="flex items-center justify-between text-[11px] text-gray-300 cursor-pointer">
              <span>Filesystem Modifications &amp; Shell</span>
              <input
                type="checkbox"
                disabled={sandboxMode === 'read-only'}
                checked={enableWriteTools}
                onChange={(e) => {
                  setEnableWriteTools(e.target.checked);
                  syncData({ enableWriteTools: e.target.checked });
                }}
                className="rounded bg-gray-800 border-gray-700 text-cyan-500 focus:ring-0"
              />
            </label>

            <label className="flex items-center justify-between text-[11px] text-gray-300 cursor-pointer">
              <span>MCP Tools (Model Context Protocol)</span>
              <input
                type="checkbox"
                checked={enableMcpTools}
                onChange={(e) => {
                  setEnableMcpTools(e.target.checked);
                  syncData({ enableMcpTools: e.target.checked });
                }}
                className="rounded bg-gray-800 border-gray-700 text-cyan-500 focus:ring-0"
              />
            </label>

            <label className="flex items-center justify-between text-[11px] text-gray-300 cursor-pointer">
              <span>Web Browsing &amp; Research</span>
              <input
                type="checkbox"
                checked={enableWebTools}
                onChange={(e) => {
                  setEnableWebTools(e.target.checked);
                  syncData({ enableWebTools: e.target.checked });
                }}
                className="rounded bg-gray-800 border-gray-700 text-cyan-500 focus:ring-0"
              />
            </label>

            <label className="flex items-center justify-between text-[11px] text-gray-300 cursor-pointer">
              <span>Generative UI Artifacts</span>
              <input
                type="checkbox"
                checked={enableGenerativeUI}
                onChange={(e) => {
                  setEnableGenerativeUI(e.target.checked);
                  syncData({ enableGenerativeUI: e.target.checked });
                }}
                className="rounded bg-gray-800 border-gray-700 text-cyan-500 focus:ring-0"
              />
            </label>
          </div>

          {/* Subagents & Depth */}
          <div className="p-2 rounded bg-gray-950 border border-gray-800 space-y-1.5">
            <div className="flex items-center justify-between">
              <label className="text-[11px] font-semibold text-gray-300 flex items-center gap-1.5 cursor-pointer">
                <input
                  type="checkbox"
                  checked={enableSubagents}
                  onChange={(e) => {
                    setEnableSubagents(e.target.checked);
                    syncData({ enableSubagents: e.target.checked });
                  }}
                  className="rounded bg-gray-800 border-gray-700 text-cyan-500 focus:ring-0"
                />
                <span>Subagent Delegation</span>
              </label>
              {enableSubagents && (
                <span className="text-[10px] text-cyan-400 font-mono">Depth: {maxSubagentDepth}</span>
              )}
            </div>

            {enableSubagents && (
              <div className="flex items-center gap-2 pt-1">
                <span className="text-[10px] text-gray-400">Max Depth:</span>
                {[1, 2, 3].map((depth) => (
                  <button
                    key={depth}
                    type="button"
                    onClick={() => {
                      setMaxSubagentDepth(depth);
                      syncData({ maxSubagentDepth: depth });
                    }}
                    className={`px-2 py-0.5 rounded text-[10px] font-mono transition ${
                      maxSubagentDepth === depth
                        ? 'bg-cyan-600 text-white font-bold'
                        : 'bg-gray-800 text-gray-400 hover:text-white'
                    }`}
                  >
                    {depth}
                  </button>
                ))}
              </div>
            )}
          </div>
        </div>
      )}

      {/* Outputs */}
      <div className="mt-3 pt-2 border-t border-gray-800 flex justify-between items-center text-[10px] text-gray-400">
        <span className="flex items-center gap-1">
          <span className="w-1.5 h-1.5 rounded-full bg-cyan-400 animate-pulse" />
          <span>AGY Runtime Ready</span>
        </span>
        <span className="font-mono text-cyan-400/80">
          {model === 'custom' ? (customModel || 'custom') : model}
        </span>
      </div>

      {/* Primary Output Handle */}
      <Handle 
        type="source" 
        position={Position.Right} 
        id="output"
        className="w-3.5 h-3.5 bg-cyan-400 -right-2 top-1/2" 
      />

      {/* Subagent Output Handle */}
      {enableSubagents && (
        <Handle
          type="source"
          position={Position.Right}
          id="subagents"
          title="Subagent Delegation Handle"
          className="w-3 h-3 bg-purple-400 -right-2 top-3/4"
        />
      )}
    </div>
  );
}
