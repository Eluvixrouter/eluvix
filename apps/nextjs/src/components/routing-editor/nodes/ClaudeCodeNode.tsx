"use client";

import { useState, useCallback } from 'react';
import { Handle, Position, useReactFlow } from '@xyflow/react';

export interface ClaudeCodeNodeData {
  label?: string;
  model?: string;
  customModel?: string;
  extendedThinking?: boolean;
  thinkingBudget?: number;
  permissionMode?: 'prompt' | 'accept-non-destructive' | 'dangerously-skip-permissions';
  compactContext?: boolean;
  enableBashTool?: boolean;
  enableFileEditTool?: boolean;
  enableGrepTool?: boolean;
  enableWebFetchTool?: boolean;
  enableSubagents?: boolean;
  maxSubagentDepth?: number;
  persona?: string;
  systemInstructions?: string;
}

const CLAUDE_MODEL_PRESETS = [
  { id: 'claude-3-7-sonnet', name: 'Claude 3.7 Sonnet (Hybrid Reasoning Workhorse)', tier: 'Frontier' },
  { id: 'claude-3-5-sonnet', name: 'Claude 3.5 Sonnet (Coding Workhorse)', tier: 'Frontier' },
  { id: 'claude-3-5-haiku', name: 'Claude 3.5 Haiku (High Throughput & Speed)', tier: 'Economy' },
  { id: 'claude-3-opus', name: 'Claude 3 Opus (Complex Legacy Reasoning)', tier: 'Legacy Frontier' },
  { id: 'custom', name: '✏️ Custom / Bedrock / Vertex Identifier...', tier: 'Custom' }
];

export default function ClaudeCodeNode({ id, data }: { id: string; data: ClaudeCodeNodeData }) {
  const { updateNodeData } = useReactFlow();
  const [activeTab, setActiveTab] = useState<'model' | 'permissions' | 'tools'>('model');

  const [model, setModel] = useState<string>(data?.model || 'claude-3-7-sonnet');
  const [customModel, setCustomModel] = useState<string>(data?.customModel || '');
  const [extendedThinking, setExtendedThinking] = useState<boolean>(data?.extendedThinking ?? true);
  const [thinkingBudget, setThinkingBudget] = useState<number>(data?.thinkingBudget ?? 4096);
  
  const [permissionMode, setPermissionMode] = useState<'prompt' | 'accept-non-destructive' | 'dangerously-skip-permissions'>(
    data?.permissionMode || 'accept-non-destructive'
  );
  const [compactContext, setCompactContext] = useState<boolean>(data?.compactContext ?? true);

  const [enableBashTool, setEnableBashTool] = useState<boolean>(data?.enableBashTool !== false);
  const [enableFileEditTool, setEnableFileEditTool] = useState<boolean>(data?.enableFileEditTool !== false);
  const [enableGrepTool, setEnableGrepTool] = useState<boolean>(data?.enableGrepTool !== false);
  const [enableWebFetchTool, setEnableWebFetchTool] = useState<boolean>(data?.enableWebFetchTool ?? true);
  const [enableSubagents, setEnableSubagents] = useState<boolean>(data?.enableSubagents !== false);
  const [maxSubagentDepth, setMaxSubagentDepth] = useState<number>(data?.maxSubagentDepth ?? 2);

  const [persona, setPersona] = useState<string>(data?.persona || 'claude-architect');
  const [systemInstructions, setSystemInstructions] = useState<string>(
    data?.systemInstructions || 'You are Claude Code, an elite agentic software engineer using terminal, ripgrep, and file editing tools to solve complex code problems.'
  );

  // Synchronize state with ReactFlow node data
  const syncData = useCallback((updates: Partial<ClaudeCodeNodeData>) => {
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
    if (!data.permissionMode) data.permissionMode = permissionMode;
    if (data.extendedThinking === undefined) data.extendedThinking = extendedThinking;
    if (data.thinkingBudget === undefined) data.thinkingBudget = thinkingBudget;
  }

  const handleModelChange = (e: React.ChangeEvent<HTMLSelectElement>) => {
    const val = e.target.value;
    setModel(val);
    syncData({ model: val });
  };

  const handlePermissionChange = (e: React.ChangeEvent<HTMLSelectElement>) => {
    const val = e.target.value as 'prompt' | 'accept-non-destructive' | 'dangerously-skip-permissions';
    setPermissionMode(val);
    syncData({ permissionMode: val });
  };

  const getPermissionBadge = () => {
    switch (permissionMode) {
      case 'accept-non-destructive':
        return <span className="text-[9px] bg-amber-500/20 text-amber-300 border border-amber-500/40 px-1.5 py-0.5 rounded font-mono">🛡️ Non-Destructive</span>;
      case 'prompt':
        return <span className="text-[9px] bg-blue-500/20 text-blue-300 border border-blue-500/40 px-1.5 py-0.5 rounded font-mono">🔒 Prompt Every</span>;
      case 'dangerously-skip-permissions':
        return <span className="text-[9px] bg-red-500/20 text-red-300 border border-red-500/40 px-1.5 py-0.5 rounded font-mono">⚡ Skip Perms</span>;
    }
  };

  return (
    <div className="bg-gray-900 border-2 border-amber-500/80 rounded-xl p-3.5 min-w-[320px] max-w-[360px] shadow-2xl transition hover:shadow-amber-500/20 hover:border-amber-400">
      {/* Target input handle */}
      <Handle 
        type="target" 
        position={Position.Left} 
        className="w-3.5 h-3.5 bg-amber-400 border-2 border-gray-900 rounded-full !-left-2 shadow-[0_0_8px_rgba(245,158,11,0.8)]" 
      />

      {/* Primary output handle */}
      <Handle 
        type="source" 
        position={Position.Right} 
        id="output"
        className="w-3.5 h-3.5 bg-amber-400 border-2 border-gray-900 rounded-full !-right-2 shadow-[0_0_8px_rgba(245,158,11,0.8)]" 
      />

      {/* Subagent delegation handle */}
      <Handle 
        type="source" 
        position={Position.Right} 
        id="subagents"
        style={{ top: '80%' }}
        className="w-2.5 h-2.5 bg-purple-400 border-2 border-gray-900 rounded-full !-right-1.5 shadow-[0_0_8px_rgba(168,85,247,0.8)]" 
        title="Subagent Task Delegation"
      />

      {/* Header */}
      <div className="flex items-center justify-between border-b border-gray-800 pb-2 mb-3">
        <div className="flex items-center gap-2">
          <div className="w-6 h-6 rounded-lg bg-amber-500/20 border border-amber-500/40 flex items-center justify-center text-amber-400 font-bold text-xs">
            ✳️
          </div>
          <div>
            <div className="font-semibold text-gray-100 text-xs tracking-wide flex items-center gap-1.5">
              <span>Claude Code</span>
              <span className="text-[10px] text-gray-400 font-normal">CLI / Agent</span>
            </div>
            <div className="text-[10px] text-amber-400/90 font-mono">
              {model === 'custom' ? (customModel || 'custom') : model}
            </div>
          </div>
        </div>
        <div>
          {getPermissionBadge()}
        </div>
      </div>

      {/* Tab Navigation */}
      <div className="flex items-center justify-between bg-gray-950/70 p-1 rounded-lg border border-gray-800 mb-3 text-[10px]">
        <button
          type="button"
          onClick={() => setActiveTab('model')}
          className={`flex-1 py-1 px-1.5 text-center font-medium rounded transition ${
            activeTab === 'model'
              ? 'bg-amber-500/20 text-amber-300 border border-amber-500/40 shadow-sm'
              : 'text-gray-400 hover:text-gray-200'
          }`}
        >
          Model
        </button>
        <button
          type="button"
          onClick={() => setActiveTab('permissions')}
          className={`flex-1 py-1 px-1.5 text-center font-medium rounded transition ${
            activeTab === 'permissions'
              ? 'bg-amber-500/20 text-amber-300 border border-amber-500/40 shadow-sm'
              : 'text-gray-400 hover:text-gray-200'
          }`}
        >
          Safety
        </button>
        <button
          type="button"
          onClick={() => setActiveTab('tools')}
          className={`flex-1 py-1 px-1.5 text-center font-medium rounded transition ${
            activeTab === 'tools'
              ? 'bg-amber-500/20 text-amber-300 border border-amber-500/40 shadow-sm'
              : 'text-gray-400 hover:text-gray-200'
          }`}
        >
          Tools
        </button>
      </div>

      {/* Tab 1: Model & Extended Thinking */}
      {activeTab === 'model' && (
        <div className="space-y-2.5 text-[11px]">
          <div>
            <label className="block text-[10px] font-medium text-gray-400 mb-1">Anthropic Model</label>
            <select
              value={model}
              onChange={handleModelChange}
              className="w-full bg-gray-950 border border-gray-800 rounded px-2 py-1.5 text-gray-200 focus:outline-none focus:border-amber-500 transition text-[11px]"
            >
              {CLAUDE_MODEL_PRESETS.map(p => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
          </div>

          {model === 'custom' && (
            <div>
              <label className="block text-[10px] font-medium text-amber-400 mb-1">Custom Model Identifier</label>
              <input
                type="text"
                value={customModel}
                onChange={(e) => {
                  setCustomModel(e.target.value);
                  syncData({ customModel: e.target.value });
                }}
                placeholder="e.g. anthropic.claude-3-7-sonnet-v1"
                className="w-full bg-gray-950 border border-amber-500/40 rounded px-2 py-1 text-gray-200 text-[11px] focus:outline-none focus:border-amber-400"
              />
            </div>
          )}

          {/* Extended Thinking Slider */}
          <div className="bg-gray-950/60 p-2 rounded border border-gray-800/80">
            <div className="flex items-center justify-between mb-1.5">
              <span className="text-[10px] text-gray-300 font-medium">Extended Thinking</span>
              <input
                type="checkbox"
                checked={extendedThinking}
                onChange={(e) => {
                  setExtendedThinking(e.target.checked);
                  syncData({ extendedThinking: e.target.checked });
                }}
                className="rounded bg-gray-900 border-gray-700 text-amber-500 focus:ring-amber-500 h-3.5 w-3.5"
              />
            </div>
            {extendedThinking && (
              <div className="space-y-1">
                <div className="flex justify-between text-[10px] font-mono text-gray-400">
                  <span>Budget:</span>
                  <span className="text-amber-400 font-bold">{thinkingBudget.toLocaleString()} tokens</span>
                </div>
                <input
                  type="range"
                  min="1024"
                  max="64000"
                  step="1024"
                  value={thinkingBudget}
                  onChange={(e) => {
                    const val = parseInt(e.target.value, 10);
                    setThinkingBudget(val);
                    syncData({ thinkingBudget: val });
                  }}
                  className="w-full accent-amber-500 h-1 bg-gray-800 rounded-lg cursor-pointer"
                />
                <div className="flex justify-between text-[9px] text-gray-500">
                  <span>1k</span>
                  <span>16k</span>
                  <span>32k</span>
                  <span>64k</span>
                </div>
              </div>
            )}
          </div>

          {/* Persona & System Instructions */}
          <div>
            <div className="flex items-center justify-between mb-1">
              <label className="text-[10px] font-medium text-gray-400">Agent Persona</label>
              <select
                value={persona}
                onChange={(e) => {
                  const p = e.target.value;
                  setPersona(p);
                  let inst = '';
                  if (p === 'claude-architect') {
                    inst = 'You are Claude Code, an elite agentic software engineer using terminal, ripgrep, and file editing tools to solve complex code problems.';
                  } else if (p === 'code-reviewer') {
                    inst = 'You are a Senior Staff Code Reviewer. You analyze architecture, identify race conditions, security flaws, and performance bottlenecks.';
                  } else if (p === 'refactoring-specialist') {
                    inst = 'You are a Refactoring Specialist. You modernize codebases, migrate APIs cleanly, and ensure exhaustive unit test coverage.';
                  }
                  setSystemInstructions(inst);
                  syncData({ persona: p, systemInstructions: inst });
                }}
                className="bg-gray-950 border border-gray-800 rounded px-1.5 py-0.5 text-gray-300 text-[10px]"
              >
                <option value="claude-architect">Elite Software Engineer</option>
                <option value="code-reviewer">Staff Code Reviewer</option>
                <option value="refactoring-specialist">Refactoring Specialist</option>
              </select>
            </div>
            <textarea
              rows={2}
              value={systemInstructions}
              onChange={(e) => {
                setSystemInstructions(e.target.value);
                syncData({ systemInstructions: e.target.value });
              }}
              placeholder="System prompt instructions for Claude Code..."
              className="w-full bg-gray-950 border border-gray-800 rounded p-1.5 text-gray-300 text-[10px] font-mono focus:outline-none focus:border-amber-500 transition resize-none"
            />
          </div>
        </div>
      )}

      {/* Tab 2: Safety & Permissions */}
      {activeTab === 'permissions' && (
        <div className="space-y-2.5 text-[11px]">
          <div>
            <label className="block text-[10px] font-medium text-gray-400 mb-1">Permission Mode</label>
            <select
              value={permissionMode}
              onChange={handlePermissionChange}
              className="w-full bg-gray-950 border border-gray-800 rounded px-2 py-1.5 text-gray-200 focus:outline-none focus:border-amber-500 transition text-[11px]"
            >
              <option value="accept-non-destructive">Accept Non-Destructive (Auto-accept view/grep)</option>
              <option value="prompt">Prompt Every Action (Highest interactive safety)</option>
              <option value="dangerously-skip-permissions">Dangerously Skip Permissions (Headless/CI)</option>
            </select>
          </div>

          <div className="flex items-center justify-between bg-gray-950/60 p-2 rounded border border-gray-800/80">
            <div>
              <div className="text-[10px] text-gray-200 font-medium">Compact Context Mode</div>
              <div className="text-[9px] text-gray-400">Automatically summarize & prune long transcripts</div>
            </div>
            <input
              type="checkbox"
              checked={compactContext}
              onChange={(e) => {
                setCompactContext(e.target.checked);
                syncData({ compactContext: e.target.checked });
              }}
              className="rounded bg-gray-900 border-gray-700 text-amber-500 focus:ring-amber-500 h-3.5 w-3.5"
            />
          </div>
        </div>
      )}

      {/* Tab 3: Tools & Delegation */}
      {activeTab === 'tools' && (
        <div className="space-y-2 text-[11px]">
          <div className="flex items-center justify-between bg-gray-950/60 p-2 rounded border border-gray-800/80">
            <div>
              <div className="text-[10px] text-gray-200 font-medium">BashTool (Shell Terminal)</div>
              <div className="text-[9px] text-gray-400">Run builds, linters, git, and tests</div>
            </div>
            <input
              type="checkbox"
              checked={enableBashTool}
              onChange={(e) => {
                setEnableBashTool(e.target.checked);
                syncData({ enableBashTool: e.target.checked });
              }}
              className="rounded bg-gray-900 border-gray-700 text-amber-500 focus:ring-amber-500 h-3.5 w-3.5"
            />
          </div>

          <div className="flex items-center justify-between bg-gray-950/60 p-2 rounded border border-gray-800/80">
            <div>
              <div className="text-[10px] text-gray-200 font-medium">FileEdit & View Tools</div>
              <div className="text-[9px] text-gray-400">Targeted line replacement & viewing</div>
            </div>
            <input
              type="checkbox"
              checked={enableFileEditTool}
              onChange={(e) => {
                setEnableFileEditTool(e.target.checked);
                syncData({ enableFileEditTool: e.target.checked });
              }}
              className="rounded bg-gray-900 border-gray-700 text-amber-500 focus:ring-amber-500 h-3.5 w-3.5"
            />
          </div>

          <div className="flex items-center justify-between bg-gray-950/60 p-2 rounded border border-gray-800/80">
            <div>
              <div className="text-[10px] text-gray-200 font-medium">GrepTool & GlobTool</div>
              <div className="text-[9px] text-gray-400">Fast ripgrep regex searching across workspace</div>
            </div>
            <input
              type="checkbox"
              checked={enableGrepTool}
              onChange={(e) => {
                setEnableGrepTool(e.target.checked);
                syncData({ enableGrepTool: e.target.checked });
              }}
              className="rounded bg-gray-900 border-gray-700 text-amber-500 focus:ring-amber-500 h-3.5 w-3.5"
            />
          </div>

          <div className="flex items-center justify-between bg-gray-950/60 p-2 rounded border border-gray-800/80">
            <div>
              <div className="text-[10px] text-gray-200 font-medium">WebFetchTool</div>
              <div className="text-[9px] text-gray-400">Fetch URLs and documentation content</div>
            </div>
            <input
              type="checkbox"
              checked={enableWebFetchTool}
              onChange={(e) => {
                setEnableWebFetchTool(e.target.checked);
                syncData({ enableWebFetchTool: e.target.checked });
              }}
              className="rounded bg-gray-900 border-gray-700 text-amber-500 focus:ring-amber-500 h-3.5 w-3.5"
            />
          </div>

          <div className="flex items-center justify-between bg-gray-950/60 p-2 rounded border border-gray-800/80">
            <div>
              <div className="text-[10px] text-gray-200 font-medium">Subagent Task Delegation</div>
              <div className="text-[9px] text-gray-400">Delegate tasks to peer / child agents</div>
            </div>
            <input
              type="checkbox"
              checked={enableSubagents}
              onChange={(e) => {
                setEnableSubagents(e.target.checked);
                syncData({ enableSubagents: e.target.checked });
              }}
              className="rounded bg-gray-900 border-gray-700 text-amber-500 focus:ring-amber-500 h-3.5 w-3.5"
            />
          </div>

          {enableSubagents && (
            <div className="pl-2 border-l border-amber-500/40 mt-1">
              <div className="flex items-center justify-between">
                <span className="text-[10px] text-gray-400">Max Subagent Depth</span>
                <select
                  value={maxSubagentDepth}
                  onChange={(e) => {
                    const depth = parseInt(e.target.value, 10);
                    setMaxSubagentDepth(depth);
                    syncData({ maxSubagentDepth: depth });
                  }}
                  className="bg-gray-950 border border-gray-800 rounded px-1.5 py-0.5 text-amber-300 font-mono text-[10px]"
                >
                  <option value={1}>1 (Single Subagent)</option>
                  <option value={2}>2 (Standard Team)</option>
                  <option value={3}>3 (Deep Hierarchical)</option>
                </select>
              </div>
            </div>
          )}
        </div>
      )}

      {/* Footer Info */}
      <div className="mt-3 pt-2 border-t border-gray-800 flex items-center justify-between text-[9px] text-gray-400 font-mono">
        <span>Claude Code Bridge</span>
        <span className="flex items-center gap-1 text-purple-400">
          <span className="w-1.5 h-1.5 rounded-full bg-purple-400 inline-block animate-pulse"></span>
          Subagent Port Active
        </span>
      </div>
    </div>
  );
}
