"use client";

import { useState, useCallback, useRef } from 'react';
import { Handle, Position, useReactFlow } from '@xyflow/react';

export default function PrivacyGuardNode({ id, data }: { id: string; data: any }) {
  const { updateNodeData } = useReactFlow();
  const [action, setAction] = useState(data?.action || 'anonymize');
  const [maskApiKey, setMaskApiKey] = useState(data?.detectPii?.apiKey !== false);
  const [maskSsn, setMaskSsn] = useState(data?.detectPii?.ssn !== false);
  const [maskCreditCard, setMaskCreditCard] = useState(data?.detectPii?.creditCard !== false);
  const [maskEmail, setMaskEmail] = useState(data?.detectPii?.email !== false);
  const [maskPhone, setMaskPhone] = useState(data?.detectPii?.phone !== false);
  const [maskIpAddress, setMaskIpAddress] = useState(data?.detectPii?.ipAddress !== false);

  const [redactionStyle, setRedactionStyle] = useState(data?.redactionStyle || 'token');

  const dataRef = useRef(data);
  dataRef.current = data;

  // Ensure default structure
  if (data) {
    if (!data.action) data.action = action;
    if (!data.redactionStyle) data.redactionStyle = redactionStyle;
    if (data.auditLogging === undefined) data.auditLogging = true;
    if (!data.whitelist) data.whitelist = [];
    if (!data.customPatterns) data.customPatterns = [];
  }

  const syncData = useCallback((updated: any) => {
    if (dataRef.current) {
      Object.assign(dataRef.current, updated);
    }
    if (id) {
      updateNodeData(id, updated);
    }
  }, [id, updateNodeData]);

  const handleActionChange = (e: React.ChangeEvent<HTMLSelectElement>) => {
    const val = e.target.value;
    setAction(val);
    syncData({ action: val });
  };

  const handleStyleChange = (e: React.ChangeEvent<HTMLSelectElement>) => {
    const val = e.target.value;
    setRedactionStyle(val);
    syncData({ redactionStyle: val });
  };

  return (
    <div className="bg-gray-900 border-2 border-emerald-500 rounded-lg p-3.5 min-w-[280px] max-w-[320px] shadow-2xl transition hover:shadow-emerald-500/10">
      <Handle type="target" position={Position.Left} className="w-3.5 h-3.5 bg-emerald-500 -left-2" />
      
      {/* Header */}
      <div className="flex items-center justify-between pb-2 mb-2 border-b border-gray-800">
        <div className="flex items-center gap-1.5">
          <span className="text-lg">🛡️</span>
          <div>
            <div className="font-bold text-emerald-400 text-sm">Privacy &amp; PII Guard</div>
            <div className="text-[10px] text-gray-400 font-mono">Zero-Knowledge Token Sanitizer</div>
          </div>
        </div>
        <span className="text-[10px] bg-emerald-500/20 text-emerald-300 px-1.5 py-0.5 rounded font-mono">
          {action.toUpperCase()}
        </span>
      </div>

      <div className="text-xs text-gray-300 space-y-2.5">
        <div className="grid grid-cols-2 gap-2">
          <div>
            <label className="block text-[10px] font-semibold text-gray-400 mb-1">Enforcement</label>
            <select
              className="nodrag w-full bg-gray-950 border border-gray-700 focus:border-emerald-500 rounded p-1.5 text-white text-[11px] outline-none transition cursor-pointer"
              value={action}
              onChange={handleActionChange}
            >
              <option value="anonymize">🎭 Redact In-Flight</option>
              <option value="block">🚫 Block (400)</option>
              <option value="warn">⚠️ Warn &amp; Log</option>
            </select>
          </div>
          <div>
            <label className="block text-[10px] font-semibold text-gray-400 mb-1">Masking Style</label>
            <select
              className="nodrag w-full bg-gray-950 border border-gray-700 focus:border-emerald-500 rounded p-1.5 text-white text-[11px] outline-none transition cursor-pointer"
              value={redactionStyle}
              onChange={handleStyleChange}
            >
              <option value="token">🏷️ [TOKEN]</option>
              <option value="asterisk">•••• Asterisk</option>
              <option value="hash">🔑 [HASH]</option>
            </select>
          </div>
        </div>

        <div>
          <label className="block text-[10px] font-semibold text-gray-400 mb-1">Active PII Scanners</label>
          <div className="grid grid-cols-2 gap-1.5 text-[11px] text-gray-300 bg-gray-950/80 p-2 rounded border border-gray-800">
            <label className="flex items-center gap-1.5 cursor-pointer">
              <input
                type="checkbox"
                checked={maskApiKey}
                onChange={(e) => {
                  setMaskApiKey(e.target.checked);
                  syncData({ detectPii: { ...data?.detectPii, apiKey: e.target.checked } });
                }}
                className="accent-emerald-500"
              />
              <span>API Keys</span>
            </label>
            <label className="flex items-center gap-1.5 cursor-pointer">
              <input
                type="checkbox"
                checked={maskSsn}
                onChange={(e) => {
                  setMaskSsn(e.target.checked);
                  syncData({ detectPii: { ...data?.detectPii, ssn: e.target.checked } });
                }}
                className="accent-emerald-500"
              />
              <span>SSN</span>
            </label>
            <label className="flex items-center gap-1.5 cursor-pointer">
              <input
                type="checkbox"
                checked={maskCreditCard}
                onChange={(e) => {
                  setMaskCreditCard(e.target.checked);
                  syncData({ detectPii: { ...data?.detectPii, creditCard: e.target.checked } });
                }}
                className="accent-emerald-500"
              />
              <span>Credit Cards</span>
            </label>
            <label className="flex items-center gap-1.5 cursor-pointer">
              <input
                type="checkbox"
                checked={maskEmail}
                onChange={(e) => {
                  setMaskEmail(e.target.checked);
                  syncData({ detectPii: { ...data?.detectPii, email: e.target.checked } });
                }}
                className="accent-emerald-500"
              />
              <span>Emails</span>
            </label>
            <label className="flex items-center gap-1.5 cursor-pointer">
              <input
                type="checkbox"
                checked={maskPhone}
                onChange={(e) => {
                  setMaskPhone(e.target.checked);
                  syncData({ detectPii: { ...data?.detectPii, phone: e.target.checked } });
                }}
                className="accent-emerald-500"
              />
              <span>Phones</span>
            </label>
            <label className="flex items-center gap-1.5 cursor-pointer">
              <input
                type="checkbox"
                checked={maskIpAddress}
                onChange={(e) => {
                  setMaskIpAddress(e.target.checked);
                  syncData({ detectPii: { ...data?.detectPii, ipAddress: e.target.checked } });
                }}
                className="accent-emerald-500"
              />
              <span>IP Addresses</span>
            </label>
          </div>
        </div>

        {/* Quick Badges Strip */}
        <div className="pt-2 border-t border-gray-800 grid grid-cols-2 gap-1.5 text-[9px] font-mono text-gray-400">
          <div className="flex items-center gap-1 bg-gray-950 px-2 py-1 rounded border border-gray-800">
            <span>🏷️</span>
            <span>Style: {redactionStyle}</span>
          </div>
          <div className="flex items-center gap-1 bg-gray-950 px-2 py-1 rounded border border-gray-800">
            <span>📜</span>
            <span>Custom: {data?.customPatterns?.length || 0}</span>
          </div>
          <div className="flex items-center gap-1 bg-gray-950 px-2 py-1 rounded border border-gray-800">
            <span>⚖️</span>
            <span>Audit: {data?.auditLogging !== false ? 'Active' : 'Off'}</span>
          </div>
          <div className="flex items-center gap-1 bg-gray-950 px-2 py-1 rounded border border-gray-800">
            <span>⚪</span>
            <span>Whitelist: {data?.whitelist?.length || 0}</span>
          </div>
        </div>
      </div>

      {/* Dual Out Handles */}
      <div className="mt-3 pt-2 border-t border-gray-800 space-y-2">
        <div className="relative flex items-center justify-between">
          <span className="text-[10px] font-semibold text-emerald-400">Sanitized Stream (Clean)</span>
          <Handle type="source" position={Position.Right} id="clean" className="w-3.5 h-3.5 bg-emerald-500 -right-2" />
        </div>
        <div className="relative flex items-center justify-between">
          <span className="text-[10px] font-semibold text-amber-400">Quarantine / Violation Sink</span>
          <Handle type="source" position={Position.Right} id="quarantine" className="w-3.5 h-3.5 bg-amber-500 -right-2" />
        </div>
      </div>
    </div>
  );
}
