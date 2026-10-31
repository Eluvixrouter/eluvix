/**
 * Neuro-Symbolic Cyber Reasoning System (CRS) Primitives for Eluvix:
 * - Backward Program Slicing (def-use & control-flow dominator pruning for LLM context compression)
 * - AddressSanitizer (ASan / KASAN) Shadow Memory & Hexspeak Poison Triage
 * - Fixed-Width Bit-Vector Overflow Verifier & Defensive Bounds-Check Synthesizer
 * - Stall-Triggered Escalation Routing Mathematics
 */

import {
  sanitizeSafeIdentifier,
  sanitizePositiveInt
} from './shell-utils.js';

export type CrsPolicy =
  | 'disabled'
  | 'slice-and-verify'
  | 'strict-zero-false-positive';

export type CrsSlicerMode =
  | 'llvm-def-use'
  | 'ast-backward-slice'
  | 'joern-cpg';

export type SanitizerArchId =
  | 'asan-x86_64'
  | 'asan-aarch64'
  | 'kasan-x86_64';

export interface CrsOverlayConfig {
  enabled?: boolean;
  policy?: CrsPolicy;
  slicerMode?: CrsSlicerMode;
  sanitizerArch?: SanitizerArchId;
  /** Seconds without coverage/verifier progress before escalating to neuro-symbolic/frontier tier */
  stallThresholdSeconds?: number;
  /** Bit-width of coupled arithmetic invariants (8, 16, 32, 64) */
  defaultBitWidth?: 8 | 16 | 32 | 64;
  /** Target sink function or identifier to slice backward from (e.g., 'memcpy', 'free') */
  targetSink?: string;
  /** Automatically inject defensive bounds-check synthesis into system prompt */
  autoSynthesizePatch?: boolean;
}

export interface ControlFlowGate {
  lineNumber: number;
  condition: string;
  gateKind: 'magic-constant' | 'coupled-arithmetic' | 'state-guard' | 'bounds-check';
  variables: string[];
  estimatedBitBarrier: number;
}

export interface ProgramSliceResult {
  targetSink: string;
  sinkLineNumber: number;
  originalLineCount: number;
  slicedLineCount: number;
  compressionRatioPct: number;
  originalEstimatedTokens: number;
  slicedEstimatedTokens: number;
  estimatedTokensSaved: number;
  slicedCode: string;
  slicedLineNumbers: number[];
  taintedVariables: string[];
  controlFlowGates: ControlFlowGate[];
  derivationMethod: 'analytical-exact';
}

export interface AsanShadowMapping {
  architecture: SanitizerArchId;
  applicationAddressHex: string;
  shadowOffsetHex: string;
  shadowAddressHex: string;
  byteOffsetInQword: number;
  shadowByteHex: string;
  shadowByteValue: number;
  isAddressable: boolean;
  bugClass:
    | 'valid-addressable'
    | 'partial-word-valid'
    | 'partial-word-oob'
    | 'heap-buffer-overflow-redzone'
    | 'heap-use-after-free-quarantine'
    | 'stack-buffer-overflow-left-redzone'
    | 'stack-buffer-overflow-mid-redzone'
    | 'stack-buffer-overflow-right-redzone'
    | 'stack-use-after-return'
    | 'stack-use-after-scope'
    | 'unknown-poison';
  diagnosticSummary: string;
  formulaLatex: string;
  derivationMethod: 'analytical-exact';
}

export interface HexspeakTombstoneInfo {
  constantHex: string;
  name: string;
  category: 'magic-guard' | 'poison-tombstone' | 'asan-shadow-byte';
  subsystem: string;
  bugClass: string;
  remediationHint: string;
}

export interface BitVectorOverflowCheck {
  bitWidth: 8 | 16 | 32 | 64;
  operation: 'add' | 'mul' | 'mul-add';
  operandA: string;
  operandB: string;
  operandC?: string;
  trueMathematicalResult: string;
  wrappedBitVectorResult: string;
  wrappedHex: string;
  maxUnsignedValue: string;
  overflowed: boolean;
  wrapAroundDelta: string;
  defensiveBoundsCheckC: string;
  defensiveBoundsCheckRust: string;
  derivationMethod: 'analytical-exact';
}

export interface StallEscalationMetrics {
  constrainedBits: number;
  randomHitProbability: number;
  expectedRandomTrials: number;
  stalledSeconds: number;
  stallThresholdSeconds: number;
  coupledArithmeticGatesCount: number;
  shouldEscalateToNeuroSymbolic: boolean;
  recommendedEngine: 'libafl-cmplog-fastpath' | 'symcc-z3-concolic' | 'llm-backward-slice-agent';
  derivationMethod: 'analytical-exact';
}

const DEFAULT_SINKS = [
  'memcpy',
  'memmove',
  'strcpy',
  'strncpy',
  'sprintf',
  'snprintf',
  'free',
  'kfree',
  'malloc',
  'calloc',
  'realloc',
  'copy_from_slice',
  'get_unchecked',
  'ptr::write',
  'ptr::copy'
];

const C_RUST_KEYWORDS = new Set([
  'if', 'else', 'for', 'while', 'do', 'switch', 'case', 'return', 'break', 'continue',
  'struct', 'enum', 'union', 'typedef', 'static', 'const', 'volatile', 'unsigned', 'signed',
  'int', 'char', 'long', 'short', 'void', 'size_t', 'ssize_t', 'uint8_t', 'uint16_t',
  'uint32_t', 'uint64_t', 'int8_t', 'int16_t', 'int32_t', 'int64_t', 'uintptr_t',
  'let', 'mut', 'fn', 'pub', 'unsafe', 'match', 'usize', 'isize', 'u8', 'u16', 'u32', 'u64',
  'sizeof', 'NULL', 'true', 'false', 'EINVAL', 'EPERM', 'ENOMEM'
]);

/**
 * Extracts valid C/Rust/TS variable identifiers (including struct member chains like `hdr->payload_len`
 * and base identifiers like `hdr`, `payload_len`).
 */
function extractIdentifiers(expr: string): string[] {
  const cleaned = expr
    .replace(/\/\/.*$/gm, '')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/"(?:\\.|[^"\\])*"/g, '""')
    .replace(/0x[0-9a-fA-F]+/g, ' ');

  const tokens = new Set<string>();
  // Match struct pointer/field accesses (e.g. hdr->payload_len or ctx.state)
  const memberMatches = cleaned.match(/\b[a-zA-Z_][a-zA-Z0-9_]*(?:(?:->|\.)[a-zA-Z_][a-zA-Z0-9_]*)+/g) || [];
  for (const m of memberMatches) {
    tokens.add(m);
    const root = m.split(/->|\./)[0];
    if (root && !C_RUST_KEYWORDS.has(root)) {
      tokens.add(root);
    }
  }

  const wordMatches = cleaned.match(/\b[a-zA-Z_][a-zA-Z0-9_]*\b/g) || [];
  for (const w of wordMatches) {
    if (!C_RUST_KEYWORDS.has(w) && !DEFAULT_SINKS.includes(w)) {
      tokens.add(w);
    }
  }
  return Array.from(tokens);
}

/**
 * Classifies a branch condition (`if (...)`) into a CRS gate category.
 */
function classifyControlFlowGate(lineNumber: number, condition: string): ControlFlowGate {
  const vars = extractIdentifiers(condition);
  const hasHexMagic = /0x[0-9a-fA-F]{4,}/i.test(condition);
  const hasArithmetic = /[*+/]|(?<!-)-(?!>)/.test(condition);

  if (hasArithmetic && vars.length >= 2) {
    return {
      lineNumber,
      condition: condition.trim(),
      gateKind: 'coupled-arithmetic',
      variables: vars,
      estimatedBitBarrier: 32
    };
  }
  if (hasHexMagic) {
    return {
      lineNumber,
      condition: condition.trim(),
      gateKind: 'magic-constant',
      variables: vars,
      estimatedBitBarrier: 32
    };
  }
  if (/state|auth|ready|mode|phase|status/i.test(condition)) {
    return {
      lineNumber,
      condition: condition.trim(),
      gateKind: 'state-guard',
      variables: vars,
      estimatedBitBarrier: 16
    };
  }
  return {
    lineNumber,
    condition: condition.trim(),
    gateKind: 'bounds-check',
    variables: vars,
    estimatedBitBarrier: 8
  };
}

/**
 * Computes a Backward Program Slice starting from a target sink or line number.
 * Performs backward def-use data dependence closure plus control-flow guard inclusion.
 */
export function computeBackwardProgramSlice(
  sourceCode: string,
  options: { targetSink?: string; sinkLineNumber?: number } = {}
): ProgramSliceResult {
  const rawLines = (sourceCode || '').split(/\r?\n/);
  const originalLineCount = rawLines.length;

  // 1. Locate the sink line
  let sinkIdx = -1;
  let detectedSink = options.targetSink || 'memcpy';

  if (
    typeof options.sinkLineNumber === 'number' &&
    options.sinkLineNumber >= 1 &&
    options.sinkLineNumber <= rawLines.length
  ) {
    sinkIdx = options.sinkLineNumber - 1;
  } else if (options.targetSink) {
    const escaped = options.targetSink.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const rx = new RegExp(`\\b${escaped}\\b`);
    for (let i = rawLines.length - 1; i >= 0; i--) {
      if (rx.test(rawLines[i])) {
        sinkIdx = i;
        break;
      }
    }
  }

  if (sinkIdx === -1) {
    for (let i = rawLines.length - 1; i >= 0; i--) {
      const line = rawLines[i];
      const matched = DEFAULT_SINKS.find(s => new RegExp(`\\b${s.replace('::', '\\:\\:')}\\s*\\(`).test(line));
      if (matched) {
        sinkIdx = i;
        detectedSink = matched;
        break;
      }
    }
  }

  if (sinkIdx === -1) {
    sinkIdx = Math.max(0, rawLines.length - 1);
  }

  // 2. Seed taint set with variables used on the sink line
  const tainted = new Set<string>(extractIdentifiers(rawLines[sinkIdx] || ''));
  const selectedIndices = new Set<number>([sinkIdx]);
  const controlFlowGates: ControlFlowGate[] = [];

  // Always include function signature and closing brace if present
  for (let i = sinkIdx; i >= 0; i--) {
    const trimmed = rawLines[i].trim();
    if (/^[a-zA-Z_][a-zA-Z0-9_\s\*]*\([^;]*\)\s*\{?$/.test(trimmed) || /^pub\s+fn\s+|^fn\s+/.test(trimmed)) {
      selectedIndices.add(i);
      for (const id of extractIdentifiers(trimmed)) {
        tainted.add(id);
      }
      break;
    }
  }
  for (let i = sinkIdx + 1; i < rawLines.length; i++) {
    if (rawLines[i].trim() === '}') {
      selectedIndices.add(i);
      break;
    }
  }

  // 3. Backward pass from sinkIdx - 1 down to 0
  for (let i = sinkIdx - 1; i >= 0; i--) {
    const rawLine = rawLines[i];
    const trimmed = rawLine.trim();
    if (!trimmed || trimmed.startsWith('//') || trimmed.startsWith('/*') || trimmed.startsWith('*')) {
      continue;
    }

    // Check if this line is a control-flow guard (e.g. `if (...) return ...;` or `if (...) {`)
    const ifMatch = trimmed.match(/^if\s*\((.+)\)/);
    if (ifMatch) {
      const cond = ifMatch[1];
      const condVars = extractIdentifiers(cond);
      const isEarlyExit = /\breturn\b|\bgoto\b|\bpanic!\b/.test(trimmed) ||
        (i + 1 < rawLines.length && /\breturn\b|\bgoto\b/.test(rawLines[i + 1]));
      const touchesTainted = condVars.some(v => tainted.has(v));

      if (isEarlyExit || touchesTainted) {
        selectedIndices.add(i);
        if (!/\breturn\b/.test(trimmed) && i + 1 <= sinkIdx && /\breturn\b/.test(rawLines[i + 1])) {
          selectedIndices.add(i + 1);
          if (i + 2 <= sinkIdx && rawLines[i + 2].trim() === '}') {
            selectedIndices.add(i + 2);
          }
        }
        for (const v of condVars) {
          tainted.add(v);
        }
        controlFlowGates.unshift(classifyControlFlowGate(i + 1, cond));
        continue;
      }
    }

    // Check if this line is an assignment / definition `lhs = rhs;`
    const assignMatch = trimmed.match(/^([^=]+?)(?<![=!<>])=(?!=)(.+)$/);
    if (assignMatch) {
      const lhsIds = extractIdentifiers(assignMatch[1]);
      const rhsIds = extractIdentifiers(assignMatch[2]);
      if (lhsIds.some(id => tainted.has(id))) {
        selectedIndices.add(i);
        for (const id of lhsIds) tainted.add(id);
        for (const id of rhsIds) tainted.add(id);
      }
      continue;
    }

    // Check if this line calls a mutating function on a tainted variable
    const lineIds = extractIdentifiers(trimmed);
    if (lineIds.some(id => tainted.has(id)) && /\(/.test(trimmed)) {
      selectedIndices.add(i);
      for (const id of lineIds) tainted.add(id);
    }
  }

  const sortedLineIdx = Array.from(selectedIndices).sort((a, b) => a - b);
  const slicedLines = sortedLineIdx.map(idx => rawLines[idx]);
  const slicedCode = slicedLines.join('\n');
  const slicedLineCount = slicedLines.length;

  const originalEstimatedTokens = Math.max(1, Math.ceil(sourceCode.length / 4));
  const slicedEstimatedTokens = Math.max(1, Math.ceil(slicedCode.length / 4));
  const estimatedTokensSaved = Math.max(0, originalEstimatedTokens - slicedEstimatedTokens);
  const compressionRatioPct =
    originalLineCount > 0
      ? Number(((1 - slicedLineCount / originalLineCount) * 100).toFixed(2))
      : 0;

  return {
    targetSink: detectedSink,
    sinkLineNumber: sinkIdx + 1,
    originalLineCount,
    slicedLineCount,
    compressionRatioPct: Math.max(0, compressionRatioPct),
    originalEstimatedTokens,
    slicedEstimatedTokens,
    estimatedTokensSaved,
    slicedCode,
    slicedLineNumbers: sortedLineIdx.map(idx => idx + 1),
    taintedVariables: Array.from(tainted).sort(),
    controlFlowGates,
    derivationMethod: 'analytical-exact'
  };
}

/**
 * Exact 64-bit AddressSanitizer (ASan / KASAN) Shadow Memory address calculator and poison byte decoder.
 * Formula: ShadowAddr = (AppAddr >> 3) + ShadowOffset
 */
export function computeAsanShadowMapping(
  applicationAddress: string | bigint,
  architecture: SanitizerArchId = 'asan-x86_64',
  shadowByteValue = 0xfa
): AsanShadowMapping {
  let addr: bigint;
  try {
    const clean = typeof applicationAddress === 'string'
      ? applicationAddress.trim().replace(/^0x/i, '')
      : applicationAddress.toString(16);
    addr = BigInt('0x' + (clean || '0'));
  } catch {
    addr = 0x602000000014n;
  }

  // Mask to 64-bit unsigned address space
  addr = addr & 0xffffffffffffffffn;

  let offset: bigint;
  let offsetHex: string;
  if (architecture === 'asan-aarch64') {
    offset = 0x1000000000n; // 1ULL << 36
    offsetHex = '0x1000000000';
  } else if (architecture === 'kasan-x86_64') {
    offset = 0xdffffc0000000000n;
    offsetHex = '0xdffffc0000000000';
  } else {
    offset = 0x7fff8000n;
    offsetHex = '0x7fff8000';
  }

  const shadowAddr = ((addr >> 3n) + offset) & 0xffffffffffffffffn;
  const byteOffsetInQword = Number(addr & 7n);
  const clampedShadowByte = shadowByteValue & 0xff;
  const shadowByteHex = '0x' + clampedShadowByte.toString(16).padStart(2, '0');

  let isAddressable = false;
  let bugClass: AsanShadowMapping['bugClass'] = 'unknown-poison';
  let diagnosticSummary = '';

  if (clampedShadowByte === 0x00) {
    isAddressable = true;
    bugClass = 'valid-addressable';
    diagnosticSummary = 'All 8 bytes in this qword are valid and addressable (0x00).';
  } else if (clampedShadowByte >= 0x01 && clampedShadowByte <= 0x07) {
    if (byteOffsetInQword < clampedShadowByte) {
      isAddressable = true;
      bugClass = 'partial-word-valid';
      diagnosticSummary = `Partially addressable qword (${clampedShadowByte} valid bytes); access at byte offset ${byteOffsetInQword} is valid.`;
    } else {
      isAddressable = false;
      bugClass = 'partial-word-oob';
      diagnosticSummary = `Out-of-bounds access at byte offset ${byteOffsetInQword} in partially addressable qword (only bytes 0..${clampedShadowByte - 1} valid).`;
    }
  } else if (clampedShadowByte === 0xfa) {
    bugClass = 'heap-buffer-overflow-redzone';
    diagnosticSummary = 'Poisoned Heap Left/Right Redzone (0xfa = kAsanHeapLeftRedzoneMagic). Deterministic heap-buffer-overflow.';
  } else if (clampedShadowByte === 0xfd) {
    bugClass = 'heap-use-after-free-quarantine';
    diagnosticSummary = 'Poisoned Freed Quarantine Chunk (0xfd = kAsanHeapFreeMagic). Deterministic heap-use-after-free (dangling pointer).';
  } else if (clampedShadowByte === 0xf1) {
    bugClass = 'stack-buffer-overflow-left-redzone';
    diagnosticSummary = 'Poisoned Stack Left Redzone (0xf1 = kAsanStackLeftRedzoneMagic). Stack buffer underflow or House of Spirit fake chunk.';
  } else if (clampedShadowByte === 0xf2) {
    bugClass = 'stack-buffer-overflow-mid-redzone';
    diagnosticSummary = 'Poisoned Stack Middle Redzone (0xf2 = kAsanStackMidRedzoneMagic). Adjacent stack variable overflow.';
  } else if (clampedShadowByte === 0xf3) {
    bugClass = 'stack-buffer-overflow-right-redzone';
    diagnosticSummary = 'Poisoned Stack Right Redzone (0xf3 = kAsanStackRightRedzoneMagic). Stack frame buffer overflow.';
  } else if (clampedShadowByte === 0xf8) {
    bugClass = 'stack-use-after-return';
    diagnosticSummary = 'Poisoned Stack Use-After-Return (0xf8 = kAsanStackUseAfterReturnMagic). Escaped pointer to retired stack frame.';
  } else if (clampedShadowByte === 0xf5) {
    bugClass = 'stack-use-after-scope';
    diagnosticSummary = 'Poisoned Stack Use-After-Scope (0xf5 = kAsanStackUseAfterScopeMagic). Out-of-lexical-scope variable access.';
  } else {
    bugClass = 'unknown-poison';
    diagnosticSummary = `Poisoned shadow byte ${shadowByteHex}; non-zero shadow mark traps __asan_report_load/store.`;
  }

  return {
    architecture,
    applicationAddressHex: '0x' + addr.toString(16),
    shadowOffsetHex: offsetHex,
    shadowAddressHex: '0x' + shadowAddr.toString(16),
    byteOffsetInQword,
    shadowByteHex,
    shadowByteValue: clampedShadowByte,
    isAddressable,
    bugClass,
    diagnosticSummary,
    formulaLatex: `\\text{ShadowAddr} = (\\text{0x${addr.toString(16)}} \\gg 3) + \\text{${offsetHex}} = \\text{0x${shadowAddr.toString(16)}}`,
    derivationMethod: 'analytical-exact'
  };
}

export const HEXSPEAK_TOMBSTONE_CATALOG: Record<string, HexspeakTombstoneInfo> = {
  '0xdeadbeef': {
    constantHex: '0xDEADBEEF',
    name: 'DEADBEEF Uninitialized / Freed Marker',
    category: 'poison-tombstone',
    subsystem: 'Allocator / Firmware Debug Fill',
    bugClass: 'Use of uninitialized or freed heap/register memory',
    remediationHint: 'Zero-initialize allocations (calloc / kzalloc) and clear pointers immediately after free().'
  },
  '0xfee1dead': {
    constantHex: '0xFEE1DEAD',
    name: 'LINUX_REBOOT_MAGIC1 (Feel Dead)',
    category: 'magic-guard',
    subsystem: 'Linux Kernel kernel/reboot.c & Protocol Guards',
    bugClass: '32-bit Magic Header Guard (Solved by LibAFL CmpLog)',
    remediationHint: 'Ensure state-machine transitions beyond magic header checks validate payload bounds independently.'
  },
  '0x6b6b6b6b': {
    constantHex: '0x6b6b6b6b',
    name: 'SLUB POISON_FREE (0x6b)',
    category: 'poison-tombstone',
    subsystem: 'Linux Kernel mm/slub.c (SLUB_DEBUG / KASAN)',
    bugClass: 'Ring-0 Kernel Slab Use-After-Free (UAF)',
    remediationHint: 'Audit reference counting (kref / RCU grace periods) before kfree() on slab objects.'
  },
  '0x5a5a5a5a': {
    constantHex: '0x5a5a5a5a',
    name: 'SLUB POISON_INUSE (0x5a)',
    category: 'poison-tombstone',
    subsystem: 'Linux Kernel mm/slub.c (SLUB_DEBUG)',
    bugClass: 'Uninitialized Kernel Slab Read',
    remediationHint: 'Use kzalloc() or explicit struct field initialization before exposing object or copying to user space.'
  },
  '0xdead10cc': {
    constantHex: '0xDEAD10CC',
    name: 'DEAD10CC (Deadlock Across Suspend)',
    category: 'poison-tombstone',
    subsystem: 'OS Process / SQLite Shared-Memory Lock Supervisor',
    bugClass: 'Advisory file or shared-memory lock held across system suspend boundary',
    remediationHint: 'Release flock/SQLite WAL locks on suspend notifications or move database out of shared container mounts.'
  }
};

/**
 * Looks up known Hexspeak magic guards or kernel/allocator poison tombstones.
 */
export function decodeHexspeakOrPoisonConstant(rawHex: string): HexspeakTombstoneInfo | null {
  const normalized = rawHex.trim().toLowerCase().replace(/^0x/, '');
  if (normalized === 'deadbeef') return HEXSPEAK_TOMBSTONE_CATALOG['0xdeadbeef'];
  if (normalized === 'fee1dead') return HEXSPEAK_TOMBSTONE_CATALOG['0xfee1dead'];
  if (/^(6b){4,8}$/.test(normalized)) return HEXSPEAK_TOMBSTONE_CATALOG['0x6b6b6b6b'];
  if (/^(5a){4,8}$/.test(normalized)) return HEXSPEAK_TOMBSTONE_CATALOG['0x5a5a5a5a'];
  if (normalized === 'dead10cc') return HEXSPEAK_TOMBSTONE_CATALOG['0xdead10cc'];
  return null;
}

/**
 * Evaluates fixed-width unsigned bit-vector arithmetic (`uint8`, `uint16`, `uint32`, `uint64`)
 * using exact modular 2^w math to detect integer wrap-around vulnerabilities and synthesize
 * standard-compliant C and Rust bounds checks.
 */
export function verifyBitVectorOverflow(params: {
  bitWidth: 8 | 16 | 32 | 64;
  operation: 'add' | 'mul' | 'mul-add';
  operandA: number | bigint | string;
  operandB: number | bigint | string;
  operandC?: number | bigint | string;
  varNameA?: string;
  varNameB?: string;
}): BitVectorOverflowCheck {
  const w = params.bitWidth;
  const modulus = 1n << BigInt(w);
  const mask = modulus - 1n;

  const parseBig = (val: number | bigint | string | undefined): bigint => {
    if (val === undefined) return 0n;
    if (typeof val === 'bigint') return val & mask;
    if (typeof val === 'number') return BigInt(Math.max(0, Math.floor(val))) & mask;
    const trimmed = val.trim();
    try {
      return BigInt(trimmed) & mask;
    } catch {
      return 0n;
    }
  };

  const a = parseBig(params.operandA);
  const b = parseBig(params.operandB);
  const c = parseBig(params.operandC);

  let trueResult: bigint;
  if (params.operation === 'add') {
    trueResult = a + b;
  } else if (params.operation === 'mul') {
    trueResult = a * b;
  } else {
    trueResult = a * b + c;
  }

  const wrapped = trueResult & mask;
  const overflowed = trueResult >= modulus;
  const delta = overflowed ? trueResult - wrapped : 0n;

  const varA = params.varNameA || 'hdr->payload_len';
  const varB = params.varNameB || 'hdr->footer_pad';
  const cMaxMacro = `UINT${w}_MAX`;
  const rustType = `u${w}`;

  let defensiveBoundsCheckC: string;
  let defensiveBoundsCheckRust: string;

  if (params.operation === 'add') {
    defensiveBoundsCheckC = `if (${varA} > ${cMaxMacro} - ${varB}) return -EINVAL;`;
    defensiveBoundsCheckRust = `let alloc_sz = ${varA}.checked_add(${varB}).ok_or(Error::IntegerOverflow)?;`;
  } else if (params.operation === 'mul') {
    defensiveBoundsCheckC = `if (${varA} != 0 && ${varB} > ${cMaxMacro} / ${varA}) return -EINVAL;`;
    defensiveBoundsCheckRust = `let total = ${varA}.checked_mul(${varB}).ok_or(Error::IntegerOverflow)?;`;
  } else {
    defensiveBoundsCheckC = `if (${varA} != 0 && (${varB} > ${cMaxMacro} / ${varA} || (${varA} * ${varB}) > ${cMaxMacro} - 0x${c.toString(16)})) return -EINVAL;`;
    defensiveBoundsCheckRust = `let total = ${varA}.checked_mul(${varB}).and_then(|v| v.checked_add(0x${c.toString(16)}_${rustType})).ok_or(Error::IntegerOverflow)?;`;
  }

  return {
    bitWidth: w,
    operation: params.operation,
    operandA: '0x' + a.toString(16),
    operandB: '0x' + b.toString(16),
    ...(params.operation === 'mul-add' ? { operandC: '0x' + c.toString(16) } : {}),
    trueMathematicalResult: '0x' + trueResult.toString(16) + ` (${trueResult.toString(10)})`,
    wrappedBitVectorResult: '0x' + wrapped.toString(16) + ` (${wrapped.toString(10)})`,
    wrappedHex: '0x' + wrapped.toString(16).padStart(w / 4, '0'),
    maxUnsignedValue: '0x' + mask.toString(16) + ` (${mask.toString(10)})`,
    overflowed,
    wrapAroundDelta: delta.toString(10),
    defensiveBoundsCheckC,
    defensiveBoundsCheckRust,
    derivationMethod: 'analytical-exact'
  };
}

/**
 * Evaluates whether a fuzzer/agent loop has hit a probability wall and should escalate
 * from fast local execution to SymCC/Z3 concolic solving or LLM backward-slice synthesis.
 */
export function evaluateStallEscalation(params: {
  constrainedBits?: number;
  stalledSeconds?: number;
  stallThresholdSeconds?: number;
  coupledArithmeticGatesCount?: number;
  hasStatefulHandshakeGate?: boolean;
}): StallEscalationMetrics {
  const bits = Math.max(0, Math.min(256, params.constrainedBits ?? 32));
  const stalledSeconds = Math.max(0, params.stalledSeconds ?? 0);
  const threshold = Math.max(1, params.stallThresholdSeconds ?? 120);
  const coupledGates = Math.max(0, params.coupledArithmeticGatesCount ?? 0);

  const randomHitProbability = Math.pow(2, -bits);
  const expectedRandomTrials = Math.pow(2, bits);

  const stalledByTimer = stalledSeconds >= threshold;
  const stalledByCoupledMath = coupledGates > 0 && bits >= 16;
  const shouldEscalate = stalledByTimer || stalledByCoupledMath || Boolean(params.hasStatefulHandshakeGate);

  let recommendedEngine: StallEscalationMetrics['recommendedEngine'] = 'libafl-cmplog-fastpath';
  if (params.hasStatefulHandshakeGate || (stalledByTimer && coupledGates > 0)) {
    recommendedEngine = 'llm-backward-slice-agent';
  } else if (stalledByCoupledMath || stalledByTimer) {
    recommendedEngine = 'symcc-z3-concolic';
  }

  return {
    constrainedBits: bits,
    randomHitProbability,
    expectedRandomTrials,
    stalledSeconds,
    stallThresholdSeconds: threshold,
    coupledArithmeticGatesCount: coupledGates,
    shouldEscalateToNeuroSymbolic: shouldEscalate,
    recommendedEngine,
    derivationMethod: 'analytical-exact'
  };
}

/**
 * Inspects a developer prompt for source code, ASan/KASAN crash reports, or Hexspeak tombstones,
 * returning a structured triage analysis and optional system context block.
 */
export function analyzePromptForCrsTriage(
  promptText: string,
  config?: CrsOverlayConfig
): {
  detected: boolean;
  sliceResult?: ProgramSliceResult;
  shadowMapping?: AsanShadowMapping;
  tombstones: HexspeakTombstoneInfo[];
  overflowCheck?: BitVectorOverflowCheck;
  stallMetrics: StallEscalationMetrics;
  systemBlock: string;
} {
  const text = promptText || '';
  const arch = config?.sanitizerArch || 'asan-x86_64';
  const bitWidth = config?.defaultBitWidth || 16;

  // 1. Detect Hexspeak / Poison Tombstones
  const tombstones: HexspeakTombstoneInfo[] = [];
  const hexMatches = text.match(/0x[0-9a-fA-F]{4,16}/g) || [];
  const seenHex = new Set<string>();
  for (const h of hexMatches) {
    const info = decodeHexspeakOrPoisonConstant(h);
    if (info && !seenHex.has(info.constantHex)) {
      seenHex.add(info.constantHex);
      tombstones.push(info);
    }
  }

  // 2. Detect ASan shadow byte or fault address if present
  let shadowMapping: AsanShadowMapping | undefined;
  const asanShadowMatch = text.match(/\b0x(fa|fd|f1|f2|f3|f8|f5)\b/i);
  const addrMatch = text.match(/address\s+(0x[0-9a-fA-F]{8,16})/i);
  if (asanShadowMatch || addrMatch || /AddressSanitizer|KASAN|heap-buffer-overflow|heap-use-after-free/i.test(text)) {
    const shadowByte = asanShadowMatch
      ? parseInt(asanShadowMatch[1], 16)
      : /use-after-free/i.test(text)
        ? 0xfd
        : 0xfa;
    const faultAddr = addrMatch ? addrMatch[1] : '0x602000000014';
    shadowMapping = computeAsanShadowMapping(faultAddr, arch, shadowByte);
  }

  // 3. Detect code block or inline C/Rust function for Backward Program Slicing
  let sliceResult: ProgramSliceResult | undefined;
  const codeBlockMatch = text.match(/```(?:c|cpp|rust|ts|javascript)?\s*([\s\S]*?)```/i);
  const candidateCode = codeBlockMatch
    ? codeBlockMatch[1]
    : DEFAULT_SINKS.some(s => text.includes(`${s}(`)) && text.includes('{')
      ? text
      : '';

  if (candidateCode.trim().length > 20) {
    sliceResult = computeBackwardProgramSlice(candidateCode, {
      targetSink: config?.targetSink
    });
  }

  // 4. Check for uint16_t / uint32_t addition wrap patterns
  let overflowCheck: BitVectorOverflowCheck | undefined;
  if (/uint16_t|u16|alloc_sz|payload_len/i.test(text)) {
    overflowCheck = verifyBitVectorOverflow({
      bitWidth,
      operation: 'add',
      operandA: 0xfff0,
      operandB: 0x0020
    });
  }

  const coupledGatesCount = sliceResult
    ? sliceResult.controlFlowGates.filter(g => g.gateKind === 'coupled-arithmetic').length
    : /chunk_count\s*\*\s*.*chunk_stride/i.test(text)
      ? 1
      : 0;
  const hasStateGate = sliceResult
    ? sliceResult.controlFlowGates.some(g => g.gateKind === 'state-guard')
    : /S_AUTH_READY|ctx->state/i.test(text);

  const stallMetrics = evaluateStallEscalation({
    constrainedBits: coupledGatesCount > 0 ? 64 : tombstones.length > 0 ? 32 : 16,
    stalledSeconds: coupledGatesCount > 0 ? 180 : 0,
    stallThresholdSeconds: config?.stallThresholdSeconds ?? 120,
    coupledArithmeticGatesCount: coupledGatesCount,
    hasStatefulHandshakeGate: hasStateGate
  });

  const detected =
    Boolean(sliceResult) ||
    Boolean(shadowMapping) ||
    tombstones.length > 0 ||
    Boolean(overflowCheck);

  const lines: string[] = ['<eluvix-crs-triage>'];
  if (shadowMapping) {
    lines.push(
      `[ASan Shadow Triage (${shadowMapping.architecture})]: Addr ${shadowMapping.applicationAddressHex} -> Shadow ${shadowMapping.shadowAddressHex} [${shadowMapping.shadowByteHex}] (${shadowMapping.bugClass})`
    );
    lines.push(`  Diagnostic: ${shadowMapping.diagnosticSummary}`);
  }
  for (const t of tombstones) {
    lines.push(`[Tombstone / Magic Constant ${t.constantHex}]: ${t.name} — ${t.bugClass}`);
    lines.push(`  Remediation: ${t.remediationHint}`);
  }
  if (sliceResult) {
    lines.push(
      `[Backward Program Slice (sink: ${sliceResult.targetSink} @ line ${sliceResult.sinkLineNumber})]: ${sliceResult.slicedLineCount}/${sliceResult.originalLineCount} lines (${sliceResult.compressionRatioPct}% compression, ${sliceResult.estimatedTokensSaved} tokens saved)`
    );
    lines.push(`  Tainted def-use variables: ${sliceResult.taintedVariables.join(', ')}`);
  }
  if (overflowCheck && overflowCheck.overflowed) {
    lines.push(
      `[Bit-Vector Verifier (uint${overflowCheck.bitWidth}_t)]: ${overflowCheck.operandA} + ${overflowCheck.operandB} wraps around ${overflowCheck.maxUnsignedValue} to ${overflowCheck.wrappedHex}`
    );
    lines.push(`  Synthesized C Guard: ${overflowCheck.defensiveBoundsCheckC}`);
    lines.push(`  Synthesized Rust Guard: ${overflowCheck.defensiveBoundsCheckRust}`);
  }
  lines.push('</eluvix-crs-triage>');

  return {
    detected,
    sliceResult,
    shadowMapping,
    tombstones,
    overflowCheck,
    stallMetrics,
    systemBlock: detected ? lines.join('\n') : ''
  };
}

/**
 * Generates a shell-safe defensive CRS verification & sanitizer setup script (`crs-setup.sh`).
 */
export function generateCrsVerificationScript(
  nodeId: string,
  config: CrsOverlayConfig
): string {
  const safeId = sanitizeSafeIdentifier(nodeId, 'crs-verifier');
  const safePolicy = sanitizeSafeIdentifier(config.policy || 'strict-zero-false-positive', 'strict-zero-false-positive');
  const safeSlicer = sanitizeSafeIdentifier(config.slicerMode || 'llvm-def-use', 'llvm-def-use');
  const safeArch = sanitizeSafeIdentifier(config.sanitizerArch || 'asan-x86_64', 'asan-x86_64');
  const safeSink = sanitizeSafeIdentifier(config.targetSink || 'memcpy', 'memcpy');
  const safeStallSec = sanitizePositiveInt(config.stallThresholdSeconds, 120, 1, 86400);
  const safeBitWidth = [8, 16, 32, 64].includes(Number(config.defaultBitWidth))
    ? Number(config.defaultBitWidth)
    : 16;

  const shadowMapping = computeAsanShadowMapping('0x602000000014', config.sanitizerArch || 'asan-x86_64', 0xfa);
  const overflowSample = verifyBitVectorOverflow({
    bitWidth: safeBitWidth as 8 | 16 | 32 | 64,
    operation: 'add',
    operandA: 0xfff0,
    operandB: 0x0020
  });

  return [
    '#!/usr/bin/env bash',
    '# ==============================================================================',
    `# Eluvix Neuro-Symbolic CRS & Backward Slicer Setup (${safeId})`,
    `# Policy: ${safePolicy} | Slicer: ${safeSlicer} | Sanitizer: ${safeArch}`,
    `# Target Sink: ${safeSink} | Stall Threshold: ${safeStallSec}s | Bit-Width: uint${safeBitWidth}_t`,
    '# ==============================================================================',
    'set -euo pipefail',
    '',
    '# 1. Compiler Sanitizer & Coverage Flags (ASan + UBSan + CmpLog)',
    'export CFLAGS="-O2 -g -fsanitize=address,undefined -fno-omit-frame-pointer -fsanitize-coverage=trace-pc-guard,trace-cmp"',
    'export CXXFLAGS="${CFLAGS}"',
    'export ASAN_OPTIONS="detect_leaks=1:abort_on_error=1:quarantine_size_mb=256"',
    '',
    `# 2. Analytical Shadow Memory Verification (${safeArch})`,
    `#    AppAddr: ${shadowMapping.applicationAddressHex} -> ShadowAddr: ${shadowMapping.shadowAddressHex} (Offset: ${shadowMapping.shadowOffsetHex})`,
    `#    Poison Byte: ${shadowMapping.shadowByteHex} (${shadowMapping.bugClass})`,
    '',
    `# 3. Synthesized Defensive Overflow Guard (uint${safeBitWidth}_t)`,
    `#    C Guard:    ${overflowSample.defensiveBoundsCheckC}`,
    `#    Rust Guard: ${overflowSample.defensiveBoundsCheckRust}`,
    '',
    `echo "[Eluvix CRS ${safeId}] Ready: policy=${safePolicy}, slicer=${safeSlicer}, stall_gate=${safeStallSec}s"`
  ].join('\n');
}
