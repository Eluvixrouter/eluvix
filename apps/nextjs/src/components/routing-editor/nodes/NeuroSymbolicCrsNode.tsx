"use client";

import { useState, useCallback, useRef, useEffect, useMemo } from 'react';
import { Handle, Position, useReactFlow } from '@xyflow/react';

export default function NeuroSymbolicCrsNode({ id, data }: { id: string; data: any }) {
  const { setNodes } = useReactFlow();
  const [crsPolicy, setCrsPolicy] = useState<string>(
    data?.crsPolicy || 'strict-zero-false-positive'
  );
  const [slicerMode, setSlicerMode] = useState<string>(
    data?.slicerMode || 'llvm-def-use'
  );
  const [sanitizerArch, setSanitizerArch] = useState<string>(
    data?.sanitizerArch || 'asan-x86_64'
  );
  const [targetSink, setTargetSink] = useState<string>(
    data?.targetSink || 'memcpy'
  );
  const [stallThresholdSeconds, setStallThresholdSeconds] = useState<number>(
    data?.stallThresholdSeconds ?? 120
  );
  const [defaultBitWidth, setDefaultBitWidth] = useState<number>(
    data?.defaultBitWidth ?? 16
  );
  const [sampleFaultAddr, setSampleFaultAddr] = useState<string>(
    data?.sampleFaultAddr || '0x602000000014'
  );
  const [sampleShadowByte, setSampleShadowByte] = useState<string>(
    data?.sampleShadowByte || '0xfa'
  );

  // Keep local editable state in sync when the node data reference changes
  // (layout load, undo/redo, decompile). Adjusting state during render is the
  // React-sanctioned replacement for a resync effect: React discards this
  // render and re-renders with the new state before committing.
  const [prevData, setPrevData] = useState(data);
  if (data !== prevData) {
    setPrevData(data);
    if (data) {
      if (data?.crsPolicy !== undefined) setCrsPolicy(data.crsPolicy);
      if (data?.slicerMode !== undefined) setSlicerMode(data.slicerMode);
      if (data?.sanitizerArch !== undefined) setSanitizerArch(data.sanitizerArch);
      if (data?.targetSink !== undefined) setTargetSink(data.targetSink);
      if (data?.stallThresholdSeconds !== undefined) setStallThresholdSeconds(data.stallThresholdSeconds);
      if (data?.defaultBitWidth !== undefined) setDefaultBitWidth(data.defaultBitWidth);
      if (data?.sampleFaultAddr !== undefined) setSampleFaultAddr(data.sampleFaultAddr);
      if (data?.sampleShadowByte !== undefined) setSampleShadowByte(data.sampleShadowByte);
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
        setNodes((nds) =>
          nds.map((node) => (node.id === id ? { ...node, data: { ...node.data, ...updated } } : node))
        );
      }
      dataRef.current?.onChange?.();
    },
    [id, setNodes]
  );

  // Exact analytical ASan Shadow Address & Bit-Vector Overflow calculation
  const analyticalMetrics = useMemo(() => {
    const mask64 = BigInt('0xffffffffffffffff');
    let addr = BigInt('0x602000000014');
    try {
      const clean = sampleFaultAddr.trim().replace(/^0x/i, '');
      addr = BigInt('0x' + (clean || '602000000014')) & mask64;
    } catch {
      addr = BigInt('0x602000000014');
    }

    const offset =
      sanitizerArch === 'asan-aarch64'
        ? BigInt('0x1000000000')
        : sanitizerArch === 'kasan-x86_64'
          ? BigInt('0xdffffc0000000000')
          : BigInt('0x7fff8000');

    const shadowAddr = ((addr >> BigInt(3)) + offset) & mask64;
    const qwordOffset = Number(addr & BigInt(7));

    const poisonMap: Record<string, string> = {
      '0xfa': 'Heap Redzone OOB',
      '0xfd': 'Quarantine UAF',
      '0xf1': 'Stack Left Redzone',
      '0xf2': 'Stack Mid Redzone',
      '0xf3': 'Stack Right Redzone',
      '0x00': 'Valid Addressable'
    };

    const maxUnsigned = (BigInt(1) << BigInt(defaultBitWidth)) - BigInt(1);

    return {
      shadowAddrHex: '0x' + shadowAddr.toString(16),
      qwordOffset,
      poisonLabel: poisonMap[sampleShadowByte.toLowerCase()] || 'Shadow Poison Trap',
      maxUnsignedHex: '0x' + maxUnsigned.toString(16)
    };
  }, [sampleFaultAddr, sanitizerArch, sampleShadowByte, defaultBitWidth]);

  return (
    <div className="bg-gray-900 border-2 border-purple-500 rounded-lg p-3.5 min-w-[310px] max-w-[350px] shadow-2xl transition hover:shadow-purple-500/15">
      <Handle type="target" position={Position.Left} className="w-3.5 h-3.5 bg-purple-500 -left-2" />

      <div className="flex items-center justify-between pb-2 mb-2 border-b border-gray-800">
        <div className="flex items-center gap-1.5">
          <span className="text-lg">🧬</span>
          <div>
            <div className="font-bold text-purple-400 text-sm">Neuro-Symbolic CRS Slicer</div>
            <div className="text-[10px] text-gray-400 font-mono">
              LLVM def-use Slice &bull; SymCC/Z3 &bull; ASan Shadow
            </div>
          </div>
        </div>
        <span className="text-[9px] px-1.5 py-0.5 rounded font-mono font-bold uppercase bg-purple-500/20 text-purple-300 border border-purple-500/40">
          0% FP VERIFIED
        </span>
      </div>

      <div className="text-xs text-gray-300 space-y-2.5">
        <div className="grid grid-cols-2 gap-2">
          <div>
            <label className="block text-[10px] font-semibold text-gray-400 mb-1">
              CRS Verification Policy
            </label>
            <select
              className="nodrag w-full bg-gray-950 border border-gray-700 focus:border-purple-500 rounded p-1.5 text-white text-[10px] outline-none"
              value={crsPolicy}
              onChange={(e) => {
                const next = e.target.value;
                setCrsPolicy(next);
                syncData({ crsPolicy: next });
              }}
            >
              <option value="strict-zero-false-positive">Strict 0% False-Positive</option>
              <option value="slice-and-verify">Slice &amp; Verify (Hybrid)</option>
              <option value="disabled">Disabled</option>
            </select>
          </div>
          <div>
            <label className="block text-[10px] font-semibold text-gray-400 mb-1">
              Backward Slicer Engine
            </label>
            <select
              className="nodrag w-full bg-gray-950 border border-gray-700 focus:border-purple-500 rounded p-1.5 text-white text-[10px] outline-none"
              value={slicerMode}
              onChange={(e) => {
                const next = e.target.value;
                setSlicerMode(next);
                syncData({ slicerMode: next });
              }}
            >
              <option value="llvm-def-use">LLVM IR def-use</option>
              <option value="joern-cpg">Joern Code Property Graph</option>
              <option value="ast-backward-slice">AST Backward Slice</option>
            </select>
          </div>
        </div>

        <div className="grid grid-cols-3 gap-2">
          <div>
            <label className="block text-[10px] font-semibold text-gray-400 mb-1">
              Target Sink
            </label>
            <input
              type="text"
              className="nodrag w-full bg-gray-950 border border-gray-700 focus:border-purple-500 rounded p-1.5 text-white text-[10px] font-mono outline-none"
              value={targetSink}
              onChange={(e) => {
                const next = e.target.value;
                setTargetSink(next);
                syncData({ targetSink: next });
              }}
            />
          </div>
          <div>
            <label className="block text-[10px] font-semibold text-gray-400 mb-1">
              Stall Gate (s)
            </label>
            <input
              type="number"
              min={1}
              max={3600}
              className="nodrag w-full bg-gray-950 border border-gray-700 focus:border-purple-500 rounded p-1.5 text-white text-[10px] font-mono outline-none"
              value={stallThresholdSeconds}
              onChange={(e) => {
                const next = Math.max(1, parseInt(e.target.value, 10) || 120);
                setStallThresholdSeconds(next);
                syncData({ stallThresholdSeconds: next });
              }}
            />
          </div>
          <div>
            <label className="block text-[10px] font-semibold text-gray-400 mb-1">
              Bit-Vector Width
            </label>
            <select
              className="nodrag w-full bg-gray-950 border border-gray-700 focus:border-purple-500 rounded p-1.5 text-white text-[10px] font-mono outline-none"
              value={defaultBitWidth}
              onChange={(e) => {
                const next = parseInt(e.target.value, 10) || 16;
                setDefaultBitWidth(next);
                syncData({ defaultBitWidth: next });
              }}
            >
              <option value={8}>uint8_t</option>
              <option value={16}>uint16_t</option>
              <option value={32}>uint32_t</option>
              <option value={64}>uint64_t</option>
            </select>
          </div>
        </div>

        <div className="grid grid-cols-2 gap-2">
          <div>
            <label className="block text-[10px] font-semibold text-gray-400 mb-1">
              Sanitizer Shadow Arch
            </label>
            <select
              className="nodrag w-full bg-gray-950 border border-gray-700 focus:border-purple-500 rounded p-1.5 text-white text-[10px] outline-none"
              value={sanitizerArch}
              onChange={(e) => {
                const next = e.target.value;
                setSanitizerArch(next);
                syncData({ sanitizerArch: next });
              }}
            >
              <option value="asan-x86_64">ASan x86_64 (+0x7fff8000)</option>
              <option value="asan-aarch64">ASan AArch64 (+0x1000000000)</option>
              <option value="kasan-x86_64">Linux KASAN (+0xdffffc00..)</option>
            </select>
          </div>
          <div>
            <label className="block text-[10px] font-semibold text-gray-400 mb-1">
              Shadow Poison Trap
            </label>
            <select
              className="nodrag w-full bg-gray-950 border border-gray-700 focus:border-purple-500 rounded p-1.5 text-white text-[10px] font-mono outline-none"
              value={sampleShadowByte}
              onChange={(e) => {
                const next = e.target.value;
                setSampleShadowByte(next);
                syncData({ sampleShadowByte: next });
              }}
            >
              <option value="0xfa">0xfa (Heap Redzone OOB)</option>
              <option value="0xfd">0xfd (Quarantine UAF)</option>
              <option value="0xf1">0xf1 (Stack Left Redzone)</option>
              <option value="0x00">0x00 (Valid Qword)</option>
            </select>
          </div>
        </div>

        <div className="rounded bg-gray-950/90 border border-purple-500/30 p-2 font-mono text-[10px] space-y-1">
          <div className="flex items-center justify-between text-purple-300 font-bold">
            <span>ANALYTICAL SHADOW &amp; BV MATH</span>
            <span className="text-[9px] px-1 rounded bg-purple-500/20 text-purple-300">EXACT</span>
          </div>
          <div className="flex justify-between text-gray-400">
            <span>ShadowAddr ((addr &gt;&gt; 3) + Off):</span>
            <span className="text-emerald-400">{analyticalMetrics.shadowAddrHex}</span>
          </div>
          <div className="flex justify-between text-gray-400">
            <span>Trap [{sampleShadowByte} @ +{analyticalMetrics.qwordOffset}B]:</span>
            <span className="text-amber-300">{analyticalMetrics.poisonLabel}</span>
          </div>
          <div className="flex justify-between text-gray-400">
            <span>BV Modulus (uint{defaultBitWidth}_t max):</span>
            <span className="text-sky-300">{analyticalMetrics.maxUnsignedHex}</span>
          </div>
        </div>
      </div>

      <Handle type="source" position={Position.Right} className="w-3.5 h-3.5 bg-purple-500 -right-2" />
    </div>
  );
}
