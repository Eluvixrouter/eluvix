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

  useEffect(() => {
    if (data?.kind !== undefined) setKind(data.kind);
    if (data?.endpoint !== undefined) setEndpoint(data.endpoint);
    if (data?.agentId !== undefined) setAgentId(data.agentId);
    if (data?.approvals !== undefined || data?.approvalPolicy !== undefined) {
      setApprovals(data.approvals || data.approvalPolicy);
    }
    if (data?.sessionMode !== undefined) setSessionMode(data.sessionMode);
  }, [data?.kind, data?.endpoint, data?.agentId, data?.approvals, data?.approvalPolicy, data?.sessionMode]);

  const dataRef = useRef(data);
  dataRef.current = data;

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
            <div className="text-[10px] text-gray-400 font-mono">TrueForge / OpenHands / Letta / A2A / ACP</div>
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
                    ? 'http://localhost:8790'
                    : next === 'opencode'
                    ? 'http://localhost:4096'
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
                    : 'http://localhost:8642/v1';
                setKind(next);
                setEndpoint(defaultEndpoint);
                syncData({ kind: next, endpoint: defaultEndpoint });
              }}
            >
              <option value="trueforge">TrueForge (:8790)</option>
              <option value="openhands">OpenHands (:3000)</option>
              <option value="letta">Letta / MemGPT (:8283)</option>
              <option value="mastra">Mastra Agent (:4111)</option>
              <option value="a2a">A2A Protocol (:8090)</option>
              <option value="opencode">opencode Server (:4096)</option>
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
      </div>

      <Handle type="source" position={Position.Right} id="output" className="w-3.5 h-3.5 bg-indigo-500 -right-2" />
    </div>
  );
}
