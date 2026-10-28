import { createHash } from 'node:crypto';
import {
  checkPromptHeuristics,
  scanAndMaskPii,
  stripPromptThreats,
  type PrivacyGuardConfig,
} from '../guard.js';
import type { ChatMessage } from '../index.js';
import { messageText } from './prompt.js';
import type { HarnessMcpServerConfig, HarnessMidLoopGuardConfig } from './types.js';

export interface HarnessObservationInspection {
  allowed: boolean;
  sanitizedText: string;
  piiRedacted: boolean;
  piiTypes: string[];
  injectionDetected: boolean;
  injectionRule?: string;
  injectionScore: number;
  blockedReason?: string;
}

export type SwitchyardStepKind =
  | 'tool-selection'
  | 'observation-parse'
  | 'code-edit'
  | 'verification'
  | 'final-synthesis';

export interface SwitchyardStepDecision {
  stepIndex: number;
  stepKind: SwitchyardStepKind;
  tier: 1 | 2 | 3 | 4;
  route: string;
  modelHint: string;
}

/**
 * Mid-loop security guard for agent harness tool observations and intermediate outputs.
 *
 * Prevents:
 * 1. Credential & PII exfiltration when an agent reads `.env`, `~/.aws/credentials`,
 *    Kubernetes secrets, or database rows during a multi-step tool loop.
 * 2. Indirect prompt injection embedded inside untrusted repository files, logs,
 *    git commit messages, or web fetches before they are re-ingested into the LLM context.
 */
export function inspectHarnessObservation(
  content: string,
  toolName = 'tool',
  config?: HarnessMidLoopGuardConfig
): HarnessObservationInspection {
  if (!content || typeof content !== 'string') {
    return {
      allowed: true,
      sanitizedText: content || '',
      piiRedacted: false,
      piiTypes: [],
      injectionDetected: false,
      injectionScore: 0,
    };
  }

  if (config?.enabled === false) {
    return {
      allowed: true,
      sanitizedText: content,
      piiRedacted: false,
      piiTypes: [],
      injectionDetected: false,
      injectionScore: 0,
    };
  }

  const redactPii = config?.redactPii !== false;
  const stripInjection = config?.stripInjection !== false;
  const blockOnInjection = config?.blockOnInjection === true;
  const redactionStyle = config?.redactionStyle || 'token';

  let working = content;
  const piiTypes: string[] = [];
  let piiRedacted = false;

  if (redactPii) {
    const privacyCfg: PrivacyGuardConfig = {
      enabled: true,
      action: 'anonymize',
      redactionStyle,
      customPatterns: [
        {
          name: 'api_key',
          regex: '\\b(?:sk-proj-[a-zA-Z0-9_-]{16,}|sk-[a-zA-Z0-9_-]{20,}|xox[baprs]-[a-zA-Z0-9-]{10,})\\b',
          placeholder: '[REDACTED_API_KEY]',
        },
      ],
    };
    const piiRes = scanAndMaskPii(working, privacyCfg);
    if (piiRes.detected) {
      piiRedacted = true;
      working = piiRes.redacted;
      for (const t of piiRes.types) {
        if (!piiTypes.includes(t)) piiTypes.push(t);
      }
    }
  }

  const heuristicRes = checkPromptHeuristics(working, 0.80);
  const injectionDetected = !heuristicRes.passed;
  const injectionScore = heuristicRes.score ?? 0;

  if (injectionDetected) {
    if (blockOnInjection) {
      return {
        allowed: false,
        sanitizedText: `[BLOCKED_TOOL_OBSERVATION: Indirect prompt injection detected in output of "${toolName}" (${heuristicRes.matchedRule || 'heuristic'})]`,
        piiRedacted,
        piiTypes,
        injectionDetected: true,
        injectionRule: heuristicRes.matchedRule,
        injectionScore,
        blockedReason:
          heuristicRes.reason ||
          `Indirect prompt injection detected in tool "${toolName}" observation`,
      };
    }

    if (stripInjection) {
      working = stripPromptThreats(working, 0.80);
    }
  }

  return {
    allowed: true,
    sanitizedText: working,
    piiRedacted,
    piiTypes,
    injectionDetected,
    injectionRule: heuristicRes.matchedRule,
    injectionScore,
  };
}

/**
 * Computes a deterministic KV-cache prefix hash over the invariant session prefix:
 * system messages (including `<eluvix-memory>` and `<eluvix-knowledge>`),
 * client tool schemas, and governed MCP server declarations.
 *
 * Disaggregated inference engines (vLLM NIXL, SGLang Mooncake, DeepSeek MLA FP8)
 * use `x-eluvix-prefix-hash` to route all sub-turns of an agent session to the
 * worker holding the warm KV prefix blocks.
 */
export function computeHarnessKvPrefixHash(
  messages: ChatMessage[] | undefined,
  tools?: unknown[],
  mcpServers?: HarnessMcpServerConfig[]
): string {
  const systemBlock = (Array.isArray(messages) ? messages : [])
    .filter(m => m.role === 'system')
    .map(m => messageText(m).trim())
    .filter(Boolean)
    .join('\n---\n');

  const toolNames = Array.isArray(tools)
    ? tools
        .map((t: any) => String(t?.function?.name || t?.name || ''))
        .filter(Boolean)
        .sort()
        .join(',')
    : '';

  const mcpNames = Array.isArray(mcpServers)
    ? mcpServers
        .map(s => `${s.name}@${s.endpoint}`)
        .sort()
        .join(',')
    : '';

  const canonical = `sys:${systemBlock}|tools:${toolNames}|mcp:${mcpNames}`;
  const digest = createHash('sha256').update(canonical).digest('hex').slice(0, 16);
  return `elx-kv-${digest}`;
}

/**
 * Grades an individual step within a multi-turn harness trajectory so Switchyard
 * can route mechanical tool-selection & observation-parsing steps to Tier-1/Tier-2
 * local engines while reserving Tier-4 frontier engines for architectural synthesis.
 */
export function selectSwitchyardStepTier(
  stepIndex: number,
  stepKind: SwitchyardStepKind,
  contextText = ''
): SwitchyardStepDecision {
  if (stepKind === 'tool-selection' || stepKind === 'observation-parse') {
    return {
      stepIndex,
      stepKind,
      tier: 1,
      route: 'tier-1-local-sglang',
      modelHint: 'local-tier-1-fast',
    };
  }

  if (stepKind === 'code-edit' || stepKind === 'verification') {
    return {
      stepIndex,
      stepKind,
      tier: 2,
      route: 'tier-2-disaggregated-vllm',
      modelHint: 'local-tier-2-coder',
    };
  }

  const isHighComplexity =
    contextText.length > 2048 ||
    /\b(architect|security\s+audit|formal|proof|synthesize|zero-day|consensus|disaggregated)\b/i.test(
      contextText
    );

  if (isHighComplexity) {
    return {
      stepIndex,
      stepKind,
      tier: 4,
      route: 'tier-4-frontier-tee',
      modelHint: 'frontier-tier-4-reasoning',
    };
  }

  return {
    stepIndex,
    stepKind,
    tier: 3,
    route: 'tier-3-balanced-hybrid',
    modelHint: 'hybrid-tier-3-general',
  };
}
