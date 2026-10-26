"use client";

import { useState, useCallback, useRef, useEffect } from 'react';
import { Handle, Position, useReactFlow } from '@xyflow/react';

export default function ConfidentialEnclaveNode({ id, data }: { id: string; data: any }) {
  const { setNodes } = useReactFlow();
  const [architecture, setArchitecture] = useState<string>(
    data?.architecture || 'sev-snp-h100-cc'
  );
  const [confidentialPolicy, setConfidentialPolicy] = useState<string>(
    data?.confidentialPolicy || 'require-dual-attestation'
  );
  const [kbsEndpoint, setKbsEndpoint] = useState<string>(
    data?.kbsEndpoint || 'https://kbs.internal.corp:8080'
  );
  const [expectedMeasurement, setExpectedMeasurement] = useState<string>(
    data?.expectedMeasurement || '9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08'
  );
  const [restrictedInjection, setRestrictedInjection] = useState<boolean>(
    data?.restrictedInjection ?? true
  );
  const [spdmAttested, setSpdmAttested] = useState<boolean>(
    data?.spdmAttested ?? true
  );

  useEffect(() => {
    if (data?.architecture !== undefined) setArchitecture(data.architecture);
    if (data?.confidentialPolicy !== undefined) setConfidentialPolicy(data.confidentialPolicy);
    if (data?.kbsEndpoint !== undefined) setKbsEndpoint(data.kbsEndpoint);
    if (data?.expectedMeasurement !== undefined) setExpectedMeasurement(data.expectedMeasurement);
    if (data?.restrictedInjection !== undefined) setRestrictedInjection(data.restrictedInjection);
    if (data?.spdmAttested !== undefined) setSpdmAttested(data.spdmAttested);
  }, [
    data?.architecture,
    data?.confidentialPolicy,
    data?.kbsEndpoint,
    data?.expectedMeasurement,
    data?.restrictedInjection,
    data?.spdmAttested
  ]);

  const dataRef = useRef(data);
  dataRef.current = data;

  const syncData = useCallback(
    (updated: any) => {
      if (dataRef.current) {
        Object.assign(dataRef.current, updated);
      }
      if (id) {
        setNodes((nds) =>
          nds.map((node) => (node.id === id ? { ...node, data: { ...node.data, ...updated } } : node))
        );
      }
      dataRef.current?.onChange?.();
    },
    [id, setNodes]
  );

  const isDual =
    architecture === 'sev-snp-h100-cc' || architecture === 'tdx-b200-tee-io';

  return (
    <div className="bg-gray-900 border-2 border-emerald-500 rounded-lg p-3.5 min-w-[300px] max-w-[340px] shadow-2xl transition hover:shadow-emerald-500/15">
      <Handle type="target" position={Position.Left} className="w-3.5 h-3.5 bg-emerald-500 -left-2" />

      <div className="flex items-center justify-between pb-2 mb-2 border-b border-gray-800">
        <div className="flex items-center gap-1.5">
          <span className="text-lg">🔐</span>
          <div>
            <div className="font-bold text-emerald-400 text-sm">Confidential Silicon Enclave</div>
            <div className="text-[10px] text-gray-400 font-mono">
              SEV-SNP / TDX + H100 CC &bull; IETF RATS
            </div>
          </div>
        </div>
        <span
          className={`text-[10px] px-1.5 py-0.5 rounded font-mono font-bold uppercase ${
            isDual
              ? 'bg-emerald-500/20 text-emerald-300 border border-emerald-500/40'
              : 'bg-amber-500/20 text-amber-300 border border-amber-500/40'
          }`}
        >
          {architecture === 'tdx-b200-tee-io' ? 'TDX + TEE-I/O' : 'SEV-SNP + CC'}
        </span>
      </div>

      <div className="text-xs text-gray-300 space-y-2.5">
        <div className="grid grid-cols-2 gap-2">
          <div>
            <label className="block text-[10px] font-semibold text-gray-400 mb-1">
              Hardware TEE Stack
            </label>
            <select
              className="nodrag w-full bg-gray-950 border border-gray-700 focus:border-emerald-500 rounded p-1.5 text-white text-[10px] outline-none"
              value={architecture}
              onChange={(e) => {
                const next = e.target.value;
                setArchitecture(next);
                syncData({ architecture: next });
              }}
            >
              <option value="sev-snp-h100-cc">AMD SEV-SNP + H100 CC-On</option>
              <option value="tdx-b200-tee-io">Intel TDX + B200 TEE-I/O</option>
              <option value="sev-es-passthrough">Legacy SEV-ES (No RMP)</option>
            </select>
          </div>
          <div>
            <label className="block text-[10px] font-semibold text-gray-400 mb-1">
              RATS Enforcement
            </label>
            <select
              className="nodrag w-full bg-gray-950 border border-gray-700 focus:border-emerald-500 rounded p-1.5 text-white text-[10px] outline-none"
              value={confidentialPolicy}
              onChange={(e) => {
                const next = e.target.value;
                setConfidentialPolicy(next);
                syncData({ confidentialPolicy: next });
              }}
            >
              <option value="require-dual-attestation">🛡️ Require CPU+GPU TEE</option>
              <option value="require-tee">🔒 Require CPU TEE</option>
              <option value="prefer-tee">⚡ Prefer TEE Enclave</option>
            </select>
          </div>
        </div>

        <div>
          <label className="block text-[10px] font-semibold text-gray-400 mb-1">
            Trustee KBS / RATS Verifier Endpoint
          </label>
          <input
            type="text"
            className="nodrag w-full bg-gray-950 border border-gray-700 focus:border-emerald-500 rounded p-1.5 text-white text-[10px] font-mono outline-none"
            value={kbsEndpoint}
            onChange={(e) => {
              setKbsEndpoint(e.target.value);
              syncData({ kbsEndpoint: e.target.value });
            }}
            placeholder="https://kbs.internal.corp:8080"
          />
        </div>

        <div>
          <label className="block text-[10px] font-semibold text-gray-400 mb-1">
            Expected Launch Digest (SHA-384 MEASUREMENT / MRTD)
          </label>
          <input
            type="text"
            className="nodrag w-full bg-gray-950 border border-gray-700 focus:border-emerald-500 rounded p-1.5 text-emerald-300 text-[10px] font-mono outline-none"
            value={expectedMeasurement}
            onChange={(e) => {
              setExpectedMeasurement(e.target.value);
              syncData({ expectedMeasurement: e.target.value });
            }}
          />
        </div>

        <div className="bg-gray-950 border border-gray-800 rounded p-2 space-y-1.5">
          <div className="flex items-center justify-between text-[10px]">
            <label className="flex items-center gap-1.5 cursor-pointer text-gray-300">
              <input
                type="checkbox"
                className="nodrag rounded bg-gray-900 border-gray-700 text-emerald-500"
                checked={restrictedInjection}
                onChange={(e) => {
                  setRestrictedInjection(e.target.checked);
                  syncData({ restrictedInjection: e.target.checked });
                }}
              />
              <span>VMPL 0 + Restricted #HV Injection</span>
            </label>
            <span className="font-mono text-emerald-400">RMP Active</span>
          </div>
          <div className="flex items-center justify-between text-[10px]">
            <label className="flex items-center gap-1.5 cursor-pointer text-gray-300">
              <input
                type="checkbox"
                className="nodrag rounded bg-gray-900 border-gray-700 text-emerald-500"
                checked={spdmAttested}
                onChange={(e) => {
                  setSpdmAttested(e.target.checked);
                  syncData({ spdmAttested: e.target.checked });
                }}
              />
              <span>DMTF SPDM 1.2 + Golden RIMs</span>
            </label>
            <span className="font-mono text-sky-400">BAR1 Locked</span>
          </div>
        </div>
      </div>

      <Handle type="source" position={Position.Right} className="w-3.5 h-3.5 bg-emerald-500 -right-2" />
    </div>
  );
}
