"use client";

import { useState, useCallback, useRef, useEffect } from 'react';
import { Handle, Position, useReactFlow } from '@xyflow/react';

export default function HarnessNode({ id, data }: { id: string; data: any }) {
  const { updateNodeData } = useReactFlow();
  const [kind, setKind] = useState(data?.kind || 'trueforge');
  const [endpoint, setEndpoint] = useState(data?.endpoint || 'http://localhost:8790');
  const [agentId, setAgentId] = useState(data?.agentId || 'default');
  const [approvals, setApprovals] = useState(data?.approvals || data?.approvalPolicy || 'auto-approve-readonly');
  const [sessionMode, setSessionMode] = useState(data?.sessionMode || 'per-eluvix-session');
  const [locality, setLocality] = useState(
    data?.providerIsLocal === true ? 'local' : data?.providerIsLocal === false ? 'remote' : 'auto'
  );
  // CLI-spawn harnesses (ACP, Multica): the binary + extra args + workdir.
  // The compiler already emits these; the UI just never edited them.
  const [command, setCommand] = useState(
    typeof data?.command === 'string' ? data.command : Array.isArray(data?.command) ? data.command.join(' ') : ''
  );
  const [args, setArgs] = useState(
    Array.isArray(data?.args) ? data.args.join(' ') : ''
  );
  const [cwd, setCwd] = useState(data?.cwd || '');
  // Multica-only options, stored under data.multica (see compiler.ts).
  const [multicaWorkspaceId, setMulticaWorkspaceId] = useState(data?.multica?.workspaceId || '');
  const [multicaProfile, setMulticaProfile] = useState(data?.multica?.profile || '');
  const [multicaProject, setMulticaProject] = useState(data?.multica?.project || '');
  const [multicaIngestTranscripts, setMulticaIngestTranscripts] = useState(
    data?.multica?.ingestTranscripts === true
  );
  const [multicaIngestPollIntervalMs, setMulticaIngestPollIntervalMs] = useState(
    data?.multica?.ingestPollIntervalMs !== undefined ? String(data.multica.ingestPollIntervalMs) : ''
  );

  // Keep local editable state in sync when the node data reference changes
  // (layout load, undo/redo, decompile). Adjusting state during render is the
  // React-sanctioned replacement for a resync effect: React discards this
  // render and re-renders with the new state before committing.
  const [prevData, setPrevData] = useState(data);
  if (data !== prevData) {
    setPrevData(data);
    if (data) {
      if (data?.kind !== undefined) setKind(data.kind);
      if (data?.endpoint !== undefined) setEndpoint(data.endpoint);
      if (data?.agentId !== undefined) setAgentId(data.agentId);
      if (data?.approvals !== undefined || data?.approvalPolicy !== undefined) {
        setApprovals(data.approvals || data.approvalPolicy);
      }
      if (data?.sessionMode !== undefined) setSessionMode(data.sessionMode);
      if (data?.providerIsLocal !== undefined) {
        setLocality(data.providerIsLocal === true ? 'local' : data.providerIsLocal === false ? 'remote' : 'auto');
      }
      if (data?.command !== undefined) {
        setCommand(
          typeof data.command === 'string'
            ? data.command
            : Array.isArray(data.command)
              ? data.command.join(' ')
              : ''
        );
      }
      if (data?.args !== undefined) {
        setArgs(Array.isArray(data.args) ? data.args.join(' ') : '');
      }
      if (data?.cwd !== undefined) setCwd(data.cwd || '');
      if (data?.multica?.workspaceId !== undefined) setMulticaWorkspaceId(data.multica.workspaceId);
      if (data?.multica?.profile !== undefined) setMulticaProfile(data.multica.profile);
      if (data?.multica?.project !== undefined) setMulticaProject(data.multica.project);
      if (data?.multica?.ingestTranscripts !== undefined) {
        setMulticaIngestTranscripts(data.multica.ingestTranscripts === true);
      }
      if (data?.multica?.ingestPollIntervalMs !== undefined) {
        setMulticaIngestPollIntervalMs(String(data.multica.ingestPollIntervalMs));
      }
    }
  }

  const dataRef = useRef(data);
  // Keep the ref current after render; assigning it during render is what
  // react-hooks/refs forbids.
  useEffect(() => {
    dataRef.current = data;
  });

  const syncData = useCallback(
    (updated: any) => {
      if (dataRef.current) {
        Object.assign(dataRef.current, updated);
      }
      if (id) {
        updateNodeData(id, updated);
      }
    },
    [id, updateNodeData]
  );

  return (
    <div className="bg-gray-900 border-2 border-indigo-500 rounded-lg p-3.5 min-w-[280px] max-w-[320px] shadow-2xl transition hover:shadow-indigo-500/10">
      <Handle type="target" position={Position.Left} className="w-3.5 h-3.5 bg-indigo-500 -left-2" />

      <div className="flex items-center justify-between pb-2 mb-2 border-b border-gray-800">
        <div className="flex items-center gap-1.5">
          <span className="text-lg">⚙️</span>
          <div>
            <div className="font-bold text-indigo-400 text-sm">Agent Harness Runtime</div>
            <div className="text-[10px] text-gray-400 font-mono">TrueForge / OpenHands / Letta / A2A / ACP / Multica</div>
          </div>
        </div>
        <span className="text-[10px] bg-indigo-500/20 text-indigo-300 px-1.5 py-0.5 rounded font-mono uppercase">
          {kind}
        </span>
      </div>

      <div className="text-xs text-gray-300 space-y-2.5">
        <div className="grid grid-cols-2 gap-2">
          <div>
            <label className="block text-[10px] font-semibold text-gray-400 mb-1">Harness Kind</label>
            <select
              className="nodrag w-full bg-gray-950 border border-gray-700 focus:border-indigo-500 rounded p-1.5 text-white text-[11px] outline-none"
              value={kind}
              onChange={(e) => {
                const next = e.target.value;
                const defaultEndpoint =
                  next === 'trueforge'
                    ? 'trueforge://embedded'
                    : next === 'opencode'
                    ? 'opencode-eluvix://embedded'
                    : next === 'aider'
                    ? 'aider://embedded'
                    : next === 'swe-agent'
                    ? 'swe-agent://embedded'
                    : next === 'cline'
                    ? 'cline://embedded'
                    : next === 'plandex'
                    ? 'plandex://embedded'
                    : next === 'acp'
                    ? 'acp://goose'
                    : next === 'openhands'
                    ? 'http://localhost:3000'
                    : next === 'mastra'
                    ? 'http://localhost:4111'
                    : next === 'letta'
                    ? 'http://localhost:8283'
                    : next === 'a2a'
                    ? 'http://localhost:8090'
                    : next === 'multica'
                    ? 'http://localhost:8080'
                    : 'http://localhost:8642/v1';
                setKind(next);
                setEndpoint(defaultEndpoint);
                syncData({ kind: next, endpoint: defaultEndpoint });
              }}
            >
              <option value="opencode">Eluvix OpenCode Fork (:4096 / embedded)</option>
              <option value="trueforge">TrueForge (:8790 / embedded)</option>
              <option value="multica">Multica — dispatch to Multica agents (:8080)</option>
              <option value="aider">Aider Architect+Editor (embedded / :8791)</option>
              <option value="swe-agent">SWE-agent ACI (embedded / :8792)</option>
              <option value="cline">Cline / Roo Headless (embedded / :8793)</option>
              <option value="plandex">Plandex DAG Sandbox (embedded / :8099)</option>
              <option value="openhands">OpenHands (:3000)</option>
              <option value="letta">Letta / MemGPT (:8283)</option>
              <option value="mastra">Mastra Agent (:4111)</option>
              <option value="a2a">A2A Protocol (:8090)</option>
              <option value="acp">ACP Stdio (Goose / opencode)</option>
              <option value="hermes">Hermes Agent (:8642)</option>
            </select>
          </div>
          <div>
            <label className="block text-[10px] font-semibold text-gray-400 mb-1">Tool Approval Policy</label>
            <select
              className="nodrag w-full bg-gray-950 border border-gray-700 focus:border-indigo-500 rounded p-1.5 text-white text-[11px] outline-none"
              value={approvals}
              onChange={(e) => {
                setApprovals(e.target.value);
                syncData({ approvals: e.target.value, approvalPolicy: e.target.value });
              }}
            >
              <option value="auto-approve-readonly">Read-Only Auto-Approve</option>
              <option value="read-only">Read-Only (Strict)</option>
              <option value="auto-deny">Strict Headless Auto-Deny</option>
              <option value="surface">Surface to Stream</option>
            </select>
          </div>
        </div>

        <div>
          <label className="block text-[10px] font-semibold text-gray-400 mb-1">Endpoint / ACP URI</label>
          <input
            type="text"
            className="nodrag w-full bg-gray-950 border border-gray-700 focus:border-indigo-500 rounded p-1.5 text-white text-[11px] font-mono outline-none"
            value={endpoint}
            onChange={(e) => {
              setEndpoint(e.target.value);
              syncData({ endpoint: e.target.value });
            }}
          />
        </div>

        <div>
          <label className="block text-[10px] font-semibold text-gray-400 mb-1">
            CLI Command (optional — binary override for ACP / Multica)
          </label>
          <input
            type="text"
            placeholder="multica"
            className="nodrag w-full bg-gray-950 border border-gray-700 focus:border-indigo-500 rounded p-1.5 text-white text-[11px] font-mono outline-none"
            value={command}
            onChange={(e) => {
              const next = e.target.value;
              setCommand(next);
              syncData({ command: next.trim() ? next.trim() : undefined });
            }}
          />
          <div className="grid grid-cols-2 gap-2 mt-2">
            <input
              type="text"
              placeholder="Extra args (space-separated)"
              className="nodrag w-full bg-gray-950 border border-gray-700 focus:border-indigo-500 rounded p-1.5 text-white text-[11px] font-mono outline-none"
              value={args}
              onChange={(e) => {
                const next = e.target.value;
                setArgs(next);
                syncData({
                  args: next.trim() ? next.trim().split(/\s+/) : undefined
                });
              }}
            />
            <input
              type="text"
              placeholder="Workdir (cwd, optional)"
              className="nodrag w-full bg-gray-950 border border-gray-700 focus:border-indigo-500 rounded p-1.5 text-white text-[11px] font-mono outline-none"
              value={cwd}
              onChange={(e) => {
                const next = e.target.value;
                setCwd(next);
                syncData({ cwd: next.trim() ? next.trim() : undefined });
              }}
            />
          </div>
        </div>

        {kind === 'multica' && (
          <div className="rounded border border-indigo-500/40 bg-indigo-500/5 p-2 space-y-2">
            <div className="text-[10px] font-semibold text-indigo-300">
              Multica dispatch — the operator-installed `multica` CLI talks to a separately
              deployed Multica server. Runs are review-gated (PR auto-complete off).
            </div>
            <div className="grid grid-cols-2 gap-2">
              <div>
                <label className="block text-[10px] font-semibold text-gray-400 mb-1">Workspace ID</label>
                <input
                  type="text"
                  placeholder="defaults to paperclip companyId"
                  className="nodrag w-full bg-gray-950 border border-gray-700 focus:border-indigo-500 rounded p-1.5 text-white text-[11px] font-mono outline-none"
                  value={multicaWorkspaceId}
                  onChange={(e) => {
                    const next = e.target.value;
                    setMulticaWorkspaceId(next);
                    syncData({
                      multica: {
                        ...(dataRef.current?.multica || {}),
                        workspaceId: next.trim() ? next.trim() : undefined
                      }
                    });
                  }}
                />
              </div>
              <div>
                <label className="block text-[10px] font-semibold text-gray-400 mb-1">CLI Profile</label>
                <input
                  type="text"
                  placeholder="--profile (optional)"
                  className="nodrag w-full bg-gray-950 border border-gray-700 focus:border-indigo-500 rounded p-1.5 text-white text-[11px] font-mono outline-none"
                  value={multicaProfile}
                  onChange={(e) => {
                    const next = e.target.value;
                    setMulticaProfile(next);
                    syncData({
                      multica: {
                        ...(dataRef.current?.multica || {}),
                        profile: next.trim() ? next.trim() : undefined
                      }
                    });
                  }}
                />
              </div>
            </div>
            <div>
              <label className="block text-[10px] font-semibold text-gray-400 mb-1">Project</label>
              <input
                type="text"
                placeholder="Multica project name (optional)"
                className="nodrag w-full bg-gray-950 border border-gray-700 focus:border-indigo-500 rounded p-1.5 text-white text-[11px] font-mono outline-none"
                value={multicaProject}
                onChange={(e) => {
                  const next = e.target.value;
                  setMulticaProject(next);
                  syncData({
                    multica: {
                      ...(dataRef.current?.multica || {}),
                      project: next.trim() ? next.trim() : undefined
                    }
                  });
                }}
              />
            </div>
            <p className="text-[10px] text-gray-500">
              Auth is the calling user&apos;s own Multica PAT (`mul_…`) on the upstream
              apiKey — never a shared token, never a run-scoped `mat_…` token.
            </p>
            <label className="flex items-start gap-2 text-[11px] text-gray-300 cursor-pointer">
              <input
                type="checkbox"
                className="nodrag mt-0.5"
                checked={multicaIngestTranscripts}
                onChange={(e) => {
                  const next = e.target.checked;
                  setMulticaIngestTranscripts(next);
                  syncData({
                    multica: {
                      ...(dataRef.current?.multica || {}),
                      ingestTranscripts: next ? true : undefined
                    }
                  });
                }}
              />
              <span>
                Ingest run transcripts into memory once runs finish (opt-in).
                Every message is T5-scan-gated (injection blocked, PII
                redacted) and stored under the dispatching user only.
              </span>
            </label>
            {multicaIngestTranscripts && (
              <div>
                <label className="block text-[10px] font-semibold text-gray-400 mb-1">
                  Ingestion sweep interval (ms, default 60000)
                </label>
                <input
                  type="number"
                  min={10000}
                  max={600000}
                  step={1000}
                  placeholder="60000"
                  className="nodrag w-full bg-gray-950 border border-gray-700 focus:border-indigo-500 rounded p-1.5 text-white text-[11px] font-mono outline-none"
                  value={multicaIngestPollIntervalMs}
                  onChange={(e) => {
                    const next = e.target.value;
                    setMulticaIngestPollIntervalMs(next);
                    const parsed = Number(next);
                    syncData({
                      multica: {
                        ...(dataRef.current?.multica || {}),
                        ingestPollIntervalMs:
                          next.trim() && Number.isFinite(parsed) ? parsed : undefined
                      }
                    });
                  }}
                />
              </div>
            )}
          </div>
        )}

        <div className="grid grid-cols-2 gap-2">
          <div>
            <label className="block text-[10px] font-semibold text-gray-400 mb-1">Agent Profile ID</label>
            <input
              type="text"
              className="nodrag w-full bg-gray-950 border border-gray-700 focus:border-indigo-500 rounded p-1.5 text-white text-[11px] font-mono outline-none"
              value={agentId}
              onChange={(e) => {
                setAgentId(e.target.value);
                syncData({ agentId: e.target.value });
              }}
            />
          </div>
          <div>
            <label className="block text-[10px] font-semibold text-gray-400 mb-1">Session Mode</label>
            <select
              className="nodrag w-full bg-gray-950 border border-gray-700 focus:border-indigo-500 rounded p-1.5 text-white text-[11px] outline-none"
              value={sessionMode}
              onChange={(e) => {
                setSessionMode(e.target.value);
                syncData({ sessionMode: e.target.value });
              }}
            >
              <option value="per-eluvix-session">Per Conversation</option>
              <option value="per-request">Stateless Per-Turn</option>
            </select>
          </div>
        </div>

        <div>
          <label className="block text-[10px] font-semibold text-gray-400 mb-1">Provider Locality</label>
          <select
            className="nodrag w-full bg-gray-950 border border-gray-700 focus:border-indigo-500 rounded p-1.5 text-white text-[11px] outline-none"
            value={locality}
            onChange={(e) => {
              const next = e.target.value;
              setLocality(next);
              syncData({
                providerIsLocal: next === 'local' ? true : next === 'remote' ? false : undefined
              });
            }}
          >
            <option value="auto">Auto (derive from endpoint)</option>
            <option value="local">Local (this machine / LAN)</option>
            <option value="remote">Remote (cloud-backed)</option>
          </select>
          <p className="text-[10px] text-gray-500 mt-1">
            Governs local-only egress and memory sharing. Auto treats ACP/CLI wrappers as remote.
          </p>
        </div>

        <div className="pt-2 border-t border-gray-800 flex items-center gap-1.5">
          <button
            type="button"
            onClick={() => {
              if (typeof window !== 'undefined') {
                window.dispatchEvent(
                  new CustomEvent('eluvix:open-quick-harness', {
                    detail: {
                      nodeId: id,
                      kind,
                      endpoint,
                      agentId,
                      approvalPolicy: approvals,
                    },
                  })
                );
              }
            }}
            className="nodrag flex-1 bg-indigo-600 hover:bg-indigo-500 text-white font-semibold text-[11px] py-1.5 px-2.5 rounded transition flex items-center justify-center gap-1 shadow"
          >
            <span>💬</span>
            <span>Quick Harness</span>
          </button>
          <a
            href={`/harness?kind=${encodeURIComponent(kind)}&endpoint=${encodeURIComponent(
              endpoint
            )}&agent=${encodeURIComponent(agentId)}&node=${encodeURIComponent(id || '')}`}
            className="nodrag bg-gray-800 hover:bg-gray-700 text-indigo-300 border border-gray-700 font-semibold text-[11px] py-1.5 px-2.5 rounded transition flex items-center justify-center gap-1"
            title="Open in Full-Screen Deep Conversation Studio (/harness)"
          >
            <span>↗</span>
            <span>Studio</span>
          </a>
        </div>
      </div>

      <Handle type="source" position={Position.Right} id="output" className="w-3.5 h-3.5 bg-indigo-500 -right-2" />
    </div>
  );
}
