"use client";

import { useState } from 'react';
import { Handle, Position, useReactFlow } from '@xyflow/react';
import NodeHealthIndicator from '../NodeHealthIndicator';
import {
  DEFAULT_PAPERCLIP_INTEGRATION_CONFIG,
  DEFAULT_PAPERCLIP_PRIORITY_POLICY,
  type PaperclipIntegrationConfig,
  type PaperclipStepTier,
} from '@eluvix/router-core/paperclip-context';

const TIER_OPTIONS: Array<{ value: PaperclipStepTier; label: string }> = [
  { value: 'fast-local', label: 'Fast Local (T1)' },
  { value: 'code-specialist', label: 'Code Specialist (T2)' },
  { value: 'heavy-reasoning', label: 'Heavy Reasoning (T3)' },
  { value: 'frontier-verified', label: 'Frontier Verified (T4)' },
];

export default function PaperclipBridgeNode({ id, data }: { id: string; data: any }) {
  const { updateNodeData } = useReactFlow();
  const initial: PaperclipIntegrationConfig = {
    ...DEFAULT_PAPERCLIP_INTEGRATION_CONFIG,
    enabled: data?.enabled ?? true,
    paperclipBaseUrl: data?.paperclipBaseUrl || 'http://127.0.0.1:3100',
    trustHeadersFrom: data?.trustHeadersFrom || 'scoped-key',
    budgetPressure: data?.budgetPressure || DEFAULT_PAPERCLIP_INTEGRATION_CONFIG.budgetPressure,
    priorityPolicy: data?.priorityPolicy || DEFAULT_PAPERCLIP_PRIORITY_POLICY,
  };

  const [enabled, setEnabled] = useState<boolean>(initial.enabled);
  const [paperclipBaseUrl, setPaperclipBaseUrl] = useState<string>(
    initial.paperclipBaseUrl || 'http://127.0.0.1:3100'
  );
  const [trustHeadersFrom, setTrustHeadersFrom] = useState<'scoped-key' | 'loopback'>(
    initial.trustHeadersFrom || 'scoped-key'
  );
  const [budgetThresholdPct, setBudgetThresholdPct] = useState<number>(
    initial.budgetPressure?.thresholdPct ?? 15
  );
  const [budgetAction, setBudgetAction] = useState<'cascade-cheaper' | 'local-only' | 'none'>(
    initial.budgetPressure?.action ?? 'cascade-cheaper'
  );
  const [criticalMinTier, setCriticalMinTier] = useState<PaperclipStepTier>(
    initial.priorityPolicy?.critical?.minTier || 'heavy-reasoning'
  );
  const [criticalAllowCloud, setCriticalAllowCloud] = useState<boolean>(
    initial.priorityPolicy?.critical?.allowCloud ?? true
  );
  const [lowPreferLocal, setLowPreferLocal] = useState<boolean>(
    initial.priorityPolicy?.low?.preferLocal ?? true
  );

  const commit = (patch: Partial<PaperclipIntegrationConfig>) => {
    const nextPriorityPolicy = {
      ...DEFAULT_PAPERCLIP_PRIORITY_POLICY,
      critical: { minTier: criticalMinTier, allowCloud: criticalAllowCloud },
      low: { preferLocal: lowPreferLocal, maxTier: 'code-specialist' as PaperclipStepTier },
      ...(patch.priorityPolicy || {}),
    };
    updateNodeData(id, {
      enabled,
      paperclipBaseUrl,
      trustHeadersFrom,
      budgetPressure: {
        thresholdPct: budgetThresholdPct,
        action: budgetAction,
        ...(patch.budgetPressure || {}),
      },
      priorityPolicy: nextPriorityPolicy,
      ...patch,
    });
  };

  return (
    <div className="w-80 rounded-xl border border-amber-500/40 bg-zinc-900/95 p-3 text-xs text-zinc-100 shadow-lg backdrop-blur">
      <Handle type="target" position={Position.Left} className="!bg-amber-400" />
      <div className="mb-2 flex items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <span className="inline-flex h-5 w-5 items-center justify-center rounded bg-amber-500/20 text-[11px] font-bold text-amber-300">
            PC
          </span>
          <div>
            <div className="font-semibold text-amber-200">Paperclip Bridge</div>
            <div className="text-[10px] text-zinc-400">Priority &amp; Delegation Policy</div>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <NodeHealthIndicator serviceName="Paperclip" />
          <label className="flex cursor-pointer items-center gap-1 text-[10px]">
            <input
              type="checkbox"
              checked={enabled}
              onChange={(e) => {
                setEnabled(e.target.checked);
                commit({ enabled: e.target.checked });
              }}
            />
            On
          </label>
        </div>
      </div>

      <div className="space-y-2">
        <div>
          <label className="block text-[10px] text-zinc-400">Paperclip URL</label>
          <input
            type="text"
            value={paperclipBaseUrl}
            onChange={(e) => {
              setPaperclipBaseUrl(e.target.value);
              commit({ paperclipBaseUrl: e.target.value });
            }}
            className="mt-0.5 w-full rounded border border-zinc-700 bg-zinc-950 px-2 py-1 text-[11px]"
          />
        </div>

        <div className="grid grid-cols-2 gap-2">
          <div>
            <label className="block text-[10px] text-zinc-400">Header Trust</label>
            <select
              value={trustHeadersFrom}
              onChange={(e) => {
                const v = e.target.value as 'scoped-key' | 'loopback';
                setTrustHeadersFrom(v);
                commit({ trustHeadersFrom: v });
              }}
              className="mt-0.5 w-full rounded border border-zinc-700 bg-zinc-950 px-1.5 py-1 text-[11px]"
            >
              <option value="scoped-key">Scoped elx_ Key</option>
              <option value="loopback">Loopback Host</option>
            </select>
          </div>
          <div>
            <label className="block text-[10px] text-zinc-400">Critical Min Tier</label>
            <select
              value={criticalMinTier}
              onChange={(e) => {
                const v = e.target.value as PaperclipStepTier;
                setCriticalMinTier(v);
                commit({
                  priorityPolicy: {
                    ...DEFAULT_PAPERCLIP_PRIORITY_POLICY,
                    critical: { minTier: v, allowCloud: criticalAllowCloud },
                    low: { preferLocal: lowPreferLocal, maxTier: 'code-specialist' },
                  },
                });
              }}
              className="mt-0.5 w-full rounded border border-zinc-700 bg-zinc-950 px-1.5 py-1 text-[11px]"
            >
              {TIER_OPTIONS.map((opt) => (
                <option key={opt.value} value={opt.value}>
                  {opt.label}
                </option>
              ))}
            </select>
          </div>
        </div>

        <div className="grid grid-cols-2 gap-2">
          <div>
            <label className="block text-[10px] text-zinc-400">
              Budget Pressure ({budgetThresholdPct}%)
            </label>
            <input
              type="range"
              min={0}
              max={50}
              value={budgetThresholdPct}
              onChange={(e) => {
                const pct = Number(e.target.value);
                setBudgetThresholdPct(pct);
                commit({ budgetPressure: { thresholdPct: pct, action: budgetAction } });
              }}
              className="mt-1 w-full accent-amber-400"
            />
          </div>
          <div>
            <label className="block text-[10px] text-zinc-400">Pressure Action</label>
            <select
              value={budgetAction}
              onChange={(e) => {
                const v = e.target.value as 'cascade-cheaper' | 'local-only' | 'none';
                setBudgetAction(v);
                commit({ budgetPressure: { thresholdPct: budgetThresholdPct, action: v } });
              }}
              className="mt-0.5 w-full rounded border border-zinc-700 bg-zinc-950 px-1.5 py-1 text-[11px]"
            >
              <option value="cascade-cheaper">Cascade Cheaper</option>
              <option value="local-only">Force Local</option>
              <option value="none">None</option>
            </select>
          </div>
        </div>

        <div className="flex items-center justify-between pt-1 text-[10px] text-zinc-300">
          <label className="flex cursor-pointer items-center gap-1">
            <input
              type="checkbox"
              checked={criticalAllowCloud}
              onChange={(e) => {
                setCriticalAllowCloud(e.target.checked);
                commit({
                  priorityPolicy: {
                    ...DEFAULT_PAPERCLIP_PRIORITY_POLICY,
                    critical: { minTier: criticalMinTier, allowCloud: e.target.checked },
                    low: { preferLocal: lowPreferLocal, maxTier: 'code-specialist' },
                  },
                });
              }}
            />
            Critical Allow Cloud
          </label>
          <label className="flex cursor-pointer items-center gap-1">
            <input
              type="checkbox"
              checked={lowPreferLocal}
              onChange={(e) => {
                setLowPreferLocal(e.target.checked);
                commit({
                  priorityPolicy: {
                    ...DEFAULT_PAPERCLIP_PRIORITY_POLICY,
                    critical: { minTier: criticalMinTier, allowCloud: criticalAllowCloud },
                    low: { preferLocal: e.target.checked, maxTier: 'code-specialist' },
                  },
                });
              }}
            />
            Low Prefer Local
          </label>
        </div>
      </div>

      <Handle type="source" position={Position.Right} className="!bg-amber-400" />
    </div>
  );
}
