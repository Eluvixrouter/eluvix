"use client";

import { useState, useCallback } from 'react';
import { Handle, Position, useReactFlow } from '@xyflow/react';

export interface CodexNodeData {
  label?: string;
  model?: string;
  customModel?: string;
  reasoningEffort?: 'low' | 'medium' | 'high';
  environment?: 'local-sandbox' | 'docker' | 'e2b-cloud';
  approvalMode?: 'always-ask' | 'confirm-risky' | 'auto-approve';
  enableCodeInterpreter?: boolean;
  enableBash?: boolean;
  enableFileEditor?: boolean;
  enableWebBrowsing?: boolean;
  workingDirectory?: string;
  maxTokens?: number;
  persona?: string;
  systemInstructions?: string;
}

const CODEX_MODEL_PRESETS = [
  { id: 'o3-mini', name: 'o3-mini (High Coding Reasoning & Math)', tier: 'Frontier Reasoning' },
  { id: 'o1', name: 'o1 (Frontier Deep Reasoning)', tier: 'Frontier' },
  { id: 'o1-mini', name: 'o1-mini (Fast Reasoning for Code)', tier: 'Fast Reasoning' },
  { id: 'gpt-4o', name: 'GPT-4o (Omni High Throughput)', tier: 'Omni' },
  { id: 'gpt-4o-mini', name: 'GPT-4o mini (Low Cost Fast Iteration)', tier: 'Economy' },
  { id: 'custom', name: '✏️ Custom / Local OpenAI Compatible...', tier: 'Custom' }
];

export default function CodexNode({ id, data }: { id: string; data: CodexNodeData }) {
  const { updateNodeData } = useReactFlow();
  const [activeTab, setActiveTab] = useState<'model' | 'sandbox' | 'tools'>('model');

  const [model, setModel] = useState<string>(data?.model || 'o3-mini');
  const [customModel, setCustomModel] = useState<string>(data?.customModel || '');
  const [reasoningEffort, setReasoningEffort] = useState<'low' | 'medium' | 'high'>(data?.reasoningEffort || 'medium');
  const [environment, setEnvironment] = useState<'local-sandbox' | 'docker' | 'e2b-cloud'>(data?.environment || 'local-sandbox');
  const [approvalMode, setApprovalMode] = useState<'always-ask' | 'confirm-risky' | 'auto-approve'>(data?.approvalMode || 'confirm-risky');
  const [workingDirectory, setWorkingDirectory] = useState<string>(data?.workingDirectory || './workspace');
  
  const [enableCodeInterpreter, setEnableCodeInterpreter] = useState<boolean>(data?.enableCodeInterpreter !== false);
  const [enableBash, setEnableBash] = useState<boolean>(data?.enableBash !== false);
  const [enableFileEditor, setEnableFileEditor] = useState<boolean>(data?.enableFileEditor !== false);
  const [enableWebBrowsing, setEnableWebBrowsing] = useState<boolean>(data?.enableWebBrowsing ?? true);

  const [persona, setPersona] = useState<string>(data?.persona || 'codex-engineer');
  const [systemInstructions, setSystemInstructions] = useState<string>(
    data?.systemInstructions || 'You are OpenAI Codex, a premier autonomous software engineer specialized in rigorous refactoring, testing, and debugging.'
  );

  // Synchronize state with ReactFlow node data
  const syncData = useCallback((updates: Partial<CodexNodeData>) => {
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
    if (!data.environment) data.environment = environment;
    if (!data.approvalMode) data.approvalMode = approvalMode;
    if (!data.reasoningEffort) data.reasoningEffort = reasoningEffort;
  }

  const handleModelChange = (e: React.ChangeEvent<HTMLSelectElement>) => {
    const val = e.target.value;
    setModel(val);
    syncData({ model: val });
  };

  const handleApprovalChange = (e: React.ChangeEvent<HTMLSelectElement>) => {
    const val = e.target.value as 'always-ask' | 'confirm-risky' | 'auto-approve';
    setApprovalMode(val);
    syncData({ approvalMode: val });
  };

  const getApprovalBadge = () => {
    switch (approvalMode) {
      case 'confirm-risky':
        return <span className="text-[9px] bg-emerald-500/20 text-emerald-300 border border-emerald-500/40 px-1.5 py-0.5 rounded font-mono">🛡️ Confirm Risky</span>;
      case 'always-ask':
        return <span className="text-[9px] bg-blue-500/20 text-blue-300 border border-blue-500/40 px-1.5 py-0.5 rounded font-mono">🔒 Always Ask</span>;
      case 'auto-approve':
        return <span className="text-[9px] bg-amber-500/20 text-amber-300 border border-amber-500/40 px-1.5 py-0.5 rounded font-mono">⚡ Auto-Approve</span>;
    }
  };

  return (
    <div className="bg-gray-900 border-2 border-emerald-500/80 rounded-xl p-3.5 min-w-[320px] max-w-[360px] shadow-2xl transition hover:shadow-emerald-500/20 hover:border-emerald-400">
      {/* Target input handle */}
      <Handle 
        type="target" 
        position={Position.Left} 
        className="w-3.5 h-3.5 bg-emerald-400 border-2 border-gray-900 rounded-full !-left-2 shadow-[0_0_8px_rgba(16,185,129,0.8)]" 
      />

      {/* Primary output handle */}
      <Handle 
        type="source" 
        position={Position.Right} 
        id="output"
        className="w-3.5 h-3.5 bg-emerald-400 border-2 border-gray-900 rounded-full !-right-2 shadow-[0_0_8px_rgba(16,185,129,0.8)]" 
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
          <div className="w-6 h-6 rounded-lg bg-emerald-500/20 border border-emerald-500/40 flex items-center justify-center text-emerald-400 font-bold text-xs">
            ⚡
          </div>
          <div>
            <div className="font-semibold text-gray-100 text-xs tracking-wide flex items-center gap-1.5">
              <span>OpenAI Codex</span>
              <span className="text-[10px] text-gray-400 font-normal">CLI / Agent</span>
            </div>
            <div className="text-[10px] text-emerald-400/90 font-mono">
              {model === 'custom' ? (customModel || 'custom') : model}
            </div>
          </div>
        </div>
        <div>
          {getApprovalBadge()}
        </div>
      </div>

      {/* Tab Navigation */}
      <div className="flex items-center justify-between bg-gray-950/70 p-1 rounded-lg border border-gray-800 mb-3 text-[10px]">
        <button
          type="button"
          onClick={() => setActiveTab('model')}
          className={`flex-1 py-1 px-1.5 text-center font-medium rounded transition ${
            activeTab === 'model'
              ? 'bg-emerald-500/20 text-emerald-300 border border-emerald-500/40 shadow-sm'
              : 'text-gray-400 hover:text-gray-200'
          }`}
        >
          Model
        </button>
        <button
          type="button"
          onClick={() => setActiveTab('sandbox')}
          className={`flex-1 py-1 px-1.5 text-center font-medium rounded transition ${
            activeTab === 'sandbox'
              ? 'bg-emerald-500/20 text-emerald-300 border border-emerald-500/40 shadow-sm'
              : 'text-gray-400 hover:text-gray-200'
          }`}
        >
          Sandbox
        </button>
        <button
          type="button"
          onClick={() => setActiveTab('tools')}
          className={`flex-1 py-1 px-1.5 text-center font-medium rounded transition ${
            activeTab === 'tools'
              ? 'bg-emerald-500/20 text-emerald-300 border border-emerald-500/40 shadow-sm'
              : 'text-gray-400 hover:text-gray-200'
          }`}
        >
          Tools
        </button>
      </div>

      {/* Tab 1: Model & Reasoning */}
      {activeTab === 'model' && (
        <div className="space-y-2.5 text-[11px]">
          <div>
            <label className="block text-[10px] font-medium text-gray-400 mb-1">Reasoning Model</label>
            <select
              value={model}
              onChange={handleModelChange}
              className="w-full bg-gray-950 border border-gray-800 rounded px-2 py-1.5 text-gray-200 focus:outline-none focus:border-emerald-500 transition text-[11px]"
            >
              {CODEX_MODEL_PRESETS.map(p => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
          </div>

          {model === 'custom' && (
            <div>
              <label className="block text-[10px] font-medium text-emerald-400 mb-1">Custom Model Identifier</label>
              <input
                type="text"
                value={customModel}
                onChange={(e) => {
                  setCustomModel(e.target.value);
                  syncData({ customModel: e.target.value });
                }}
                placeholder="e.g. ft:o3-mini:my-org:custom"
                className="w-full bg-gray-950 border border-emerald-500/40 rounded px-2 py-1 text-gray-200 text-[11px] focus:outline-none focus:border-emerald-400"
              />
            </div>
          )}

          {/* Reasoning Effort (o1 / o3-mini) */}
          {(model === 'o3-mini' || model === 'o1' || model === 'o1-mini') && (
            <div className="bg-gray-950/60 p-2 rounded border border-gray-800/80">
              <div className="flex items-center justify-between mb-1.5">
                <span className="text-[10px] text-gray-300 font-medium">Reasoning Effort</span>
                <span className="text-[10px] font-mono text-emerald-400 uppercase">{reasoningEffort}</span>
              </div>
              <div className="grid grid-cols-3 gap-1.5 text-[10px]">
                {(['low', 'medium', 'high'] as const).map(effort => (
                  <button
                    key={effort}
                    type="button"
                    onClick={() => {
                      setReasoningEffort(effort);
                      syncData({ reasoningEffort: effort });
                    }}
                    className={`py-1 text-center font-mono rounded capitalize transition border ${
                      reasoningEffort === effort
                        ? 'bg-emerald-500/20 text-emerald-300 border-emerald-500/40'
                        : 'bg-gray-900 text-gray-400 border-gray-800 hover:text-gray-200'
                    }`}
                  >
                    {effort}
                  </button>
                ))}
              </div>
            </div>
          )}

          {/* Persona & System Instructions */}
          <div>
            <div className="flex items-center justify-between mb-1">
              <label className="text-[10px] font-medium text-gray-400">Persona Preset</label>
              <select
                value={persona}
                onChange={(e) => {
                  const p = e.target.value;
                  setPersona(p);
                  let inst = '';
                  if (p === 'codex-engineer') {
                    inst = 'You are OpenAI Codex, a premier autonomous software engineer specialized in rigorous refactoring, testing, and debugging.';
                  } else if (p === 'test-runner') {
                    inst = 'You are a Test Automation Engineer. You write comprehensive unit and integration tests, run test suites, and fix regressions.';
                  } else if (p === 'security-analyst') {
                    inst = 'You are a Security Review Agent. You audit code for vulnerabilities, sanitize user input, and verify cryptography.';
                  }
                  setSystemInstructions(inst);
                  syncData({ persona: p, systemInstructions: inst });
                }}
                className="bg-gray-950 border border-gray-800 rounded px-1.5 py-0.5 text-gray-300 text-[10px]"
              >
                <option value="codex-engineer">Senior Software Engineer</option>
                <option value="test-runner">Test & QA Automation</option>
                <option value="security-analyst">Security & Vuln Analyst</option>
              </select>
            </div>
            <textarea
              rows={2}
              value={systemInstructions}
              onChange={(e) => {
                setSystemInstructions(e.target.value);
                syncData({ systemInstructions: e.target.value });
              }}
              placeholder="System prompt instructions for Codex..."
              className="w-full bg-gray-950 border border-gray-800 rounded p-1.5 text-gray-300 text-[10px] font-mono focus:outline-none focus:border-emerald-500 transition resize-none"
            />
          </div>
        </div>
      )}

      {/* Tab 2: Environment & Sandbox */}
      {activeTab === 'sandbox' && (
        <div className="space-y-2.5 text-[11px]">
          <div>
            <label className="block text-[10px] font-medium text-gray-400 mb-1">Execution Environment</label>
            <select
              value={environment}
              onChange={(e) => {
                const val = e.target.value as 'local-sandbox' | 'docker' | 'e2b-cloud';
                setEnvironment(val);
                syncData({ environment: val });
              }}
              className="w-full bg-gray-950 border border-gray-800 rounded px-2 py-1.5 text-gray-200 focus:outline-none focus:border-emerald-500 transition text-[11px]"
            >
              <option value="local-sandbox">🔒 Local Process Sandbox</option>
              <option value="docker">🐳 Docker Container Isolation</option>
              <option value="e2b-cloud">☁️ E2B Sandboxed Cloud MicroVM</option>
            </select>
          </div>

          <div>
            <label className="block text-[10px] font-medium text-gray-400 mb-1">Approval Policy</label>
            <select
              value={approvalMode}
              onChange={handleApprovalChange}
              className="w-full bg-gray-950 border border-gray-800 rounded px-2 py-1.5 text-gray-200 focus:outline-none focus:border-emerald-500 transition text-[11px]"
            >
              <option value="confirm-risky">Confirm Risky Actions (Auto-approve reads)</option>
              <option value="always-ask">Always Require Confirmation (Interactive)</option>
              <option value="auto-approve">Full Headless Auto-Approve (CI / Trusted)</option>
            </select>
          </div>

          <div>
            <label className="block text-[10px] font-medium text-gray-400 mb-1">Working Directory Boundary</label>
            <input
              type="text"
              value={workingDirectory}
              onChange={(e) => {
                setWorkingDirectory(e.target.value);
                syncData({ workingDirectory: e.target.value });
              }}
              className="w-full bg-gray-950 border border-gray-800 rounded px-2 py-1 text-gray-300 font-mono text-[10px] focus:outline-none focus:border-emerald-500"
            />
          </div>
        </div>
      )}

      {/* Tab 3: Tools & Capabilities */}
      {activeTab === 'tools' && (
        <div className="space-y-2 text-[11px]">
          <div className="flex items-center justify-between bg-gray-950/60 p-2 rounded border border-gray-800/80">
            <div>
              <div className="text-[10px] text-gray-200 font-medium">Python Code Interpreter</div>
              <div className="text-[9px] text-gray-400">Execute Python code in isolated sandbox</div>
            </div>
            <input
              type="checkbox"
              checked={enableCodeInterpreter}
              onChange={(e) => {
                setEnableCodeInterpreter(e.target.checked);
                syncData({ enableCodeInterpreter: e.target.checked });
              }}
              className="rounded bg-gray-900 border-gray-700 text-emerald-500 focus:ring-emerald-500 h-3.5 w-3.5"
            />
          </div>

          <div className="flex items-center justify-between bg-gray-950/60 p-2 rounded border border-gray-800/80">
            <div>
              <div className="text-[10px] text-gray-200 font-medium">Terminal / Shell Tool</div>
              <div className="text-[9px] text-gray-400">Execute bash, npm, and build scripts</div>
            </div>
            <input
              type="checkbox"
              checked={enableBash}
              onChange={(e) => {
                setEnableBash(e.target.checked);
                syncData({ enableBash: e.target.checked });
              }}
              className="rounded bg-gray-900 border-gray-700 text-emerald-500 focus:ring-emerald-500 h-3.5 w-3.5"
            />
          </div>

          <div className="flex items-center justify-between bg-gray-950/60 p-2 rounded border border-gray-800/80">
            <div>
              <div className="text-[10px] text-gray-200 font-medium">File Editor & Diff Tool</div>
              <div className="text-[9px] text-gray-400">Read and patch repository files</div>
            </div>
            <input
              type="checkbox"
              checked={enableFileEditor}
              onChange={(e) => {
                setEnableFileEditor(e.target.checked);
                syncData({ enableFileEditor: e.target.checked });
              }}
              className="rounded bg-gray-900 border-gray-700 text-emerald-500 focus:ring-emerald-500 h-3.5 w-3.5"
            />
          </div>

          <div className="flex items-center justify-between bg-gray-950/60 p-2 rounded border border-gray-800/80">
            <div>
              <div className="text-[10px] text-gray-200 font-medium">Web Search & Retrieval</div>
              <div className="text-[9px] text-gray-400">Documentation lookup & API searching</div>
            </div>
            <input
              type="checkbox"
              checked={enableWebBrowsing}
              onChange={(e) => {
                setEnableWebBrowsing(e.target.checked);
                syncData({ enableWebBrowsing: e.target.checked });
              }}
              className="rounded bg-gray-900 border-gray-700 text-emerald-500 focus:ring-emerald-500 h-3.5 w-3.5"
            />
          </div>
        </div>
      )}

      {/* Footer Info */}
      <div className="mt-3 pt-2 border-t border-gray-800 flex items-center justify-between text-[9px] text-gray-400 font-mono">
        <span>Codex Agent Bridge</span>
        <span className="flex items-center gap-1 text-purple-400">
          <span className="w-1.5 h-1.5 rounded-full bg-purple-400 inline-block animate-pulse"></span>
          Subagent Port Active
        </span>
      </div>
    </div>
  );
}
