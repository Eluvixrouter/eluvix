import type { ChatMessage } from '../index.js';
import type * as dbModule from '../db.js';

export interface RouterDeps {
  db?: Partial<typeof dbModule>;
  fetch?: typeof globalThis.fetch;
  now?: () => number;
}

export interface PromptComplexityAssessment {
  score: 1 | 2 | 3 | 4;
  label: 'simple' | 'moderate' | 'heavy' | 'frontier';
  tokenEstimate: number;
  features: string[];
  hasImages?: boolean;
  hasTools?: boolean;
}

/**
 * Computes a deterministic 32-bit hex hash over static system prompts,
 * knowledge blocks, or initial message turns to support KV-cache prefix affinity.
 */
export function computeKvPrefixHash(messages: ChatMessage[], maxChars = 2048): string {
  if (!messages || messages.length === 0) return 'empty';
  let prefix = '';
  const hasSystem = messages.some((m) => m.role === 'system');

  if (hasSystem) {
    for (const m of messages) {
      if (m.role === 'system') {
        const c = typeof m.content === 'string' ? m.content : JSON.stringify(m.content);
        prefix += `[${m.role}]${c}\n`;
        if (prefix.length >= maxChars) break;
      }
    }
  } else {
    for (const m of messages) {
      const c = typeof m.content === 'string' ? m.content : JSON.stringify(m.content);
      prefix += `[${m.role}]${c}\n`;
      if (prefix.length >= 512) break;
    }
  }

  if (!prefix) return 'empty';

  let h = 0x811c9dc5;
  for (let i = 0; i < prefix.length; i++) {
    h ^= prefix.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}

export function estimatePromptComplexity(
  messages: ChatMessage[],
  customThresholds?: {
    moderate?: number;
    heavy?: number;
    frontier?: number;
    codeEscalation?: boolean;
    hasTools?: boolean;
    toolsCount?: number;
  }
): PromptComplexityAssessment {
  if (!messages || messages.length === 0) {
    const hasTools = customThresholds?.hasTools ?? false;
    return {
      score: hasTools ? 3 : 1,
      label: hasTools ? 'heavy' : 'simple',
      tokenEstimate: 0,
      features: hasTools ? [`tools (${customThresholds?.toolsCount ?? 1})`] : ['empty'],
      hasImages: false,
      hasTools,
    };
  }

  let hasImages = false;

  const textContent = messages
    .map((m) => {
      if (typeof m.content === 'string') {
        return m.content;
      } else if (Array.isArray(m.content)) {
        let combined = '';
        for (const part of m.content) {
          if (part.type === 'text') combined += part.text + '\n';
          if (part.type === 'image_url') hasImages = true;
        }
        return combined;
      }
      return '';
    })
    .join('\n');
  const totalChars = textContent.length;
  const tokenEstimate = Math.ceil(totalChars / 4);
  const features: string[] = [];

  const codeBlockRegex = /```[\s\S]*?```/g;
  const codeMatches = textContent.match(codeBlockRegex);
  const codeBlockMatches = codeMatches ? codeMatches.length : 0;
  if (codeBlockMatches > 0) {
    features.push(`${codeBlockMatches} code block(s)`);
  }

  const isStructured =
    /(\{|\[)\s*"[^"]+"\s*:/g.test(textContent) ||
    /<[a-zA-Z0-9_-]+>[\s\S]*?<\/[a-zA-Z0-9_-]+>/g.test(textContent);
  if (isStructured) {
    features.push('structured schema (json/xml)');
  }

  const reasoningRegex =
    /\b(step-by-step|step by step|prove|proof|derive|differential|algorithmic|architecture|refactor|benchmark|root cause|diagnose|formal verification|complexity analysis|edge case|concurrency|mutex|deadlock|quantum|theorem|calculus|linear algebra|optimize|optimization)\b/gi;
  const reasoningMatches = textContent.match(reasoningRegex);
  const reasoningCount = reasoningMatches ? reasoningMatches.length : 0;
  if (reasoningCount > 0) {
    features.push(`reasoning keywords (${reasoningCount})`);
  }

  if (hasImages) {
    features.push('image payload');
  }

  const hasTools = customThresholds?.hasTools ?? false;
  if (hasTools) {
    features.push(`tools (${customThresholds?.toolsCount ?? 1})`);
  }

  const frontierLimit = customThresholds?.frontier ?? 6000;
  const heavyLimit = customThresholds?.heavy ?? 1500;
  const moderateLimit = customThresholds?.moderate ?? 300;
  const codeEscalate = customThresholds?.codeEscalation ?? true;

  let score: 1 | 2 | 3 | 4 = 1;
  let label: 'simple' | 'moderate' | 'heavy' | 'frontier' = 'simple';

  if (
    tokenEstimate > frontierLimit ||
    hasImages ||
    (tokenEstimate > 2500 && (codeBlockMatches >= 3 || reasoningCount >= 4))
  ) {
    score = 4;
    label = 'frontier';
  } else if (
    tokenEstimate > heavyLimit ||
    (codeEscalate && codeBlockMatches >= 1) ||
    reasoningCount >= 2 ||
    isStructured ||
    hasTools
  ) {
    score = 3;
    label = 'heavy';
  } else if (tokenEstimate > moderateLimit || reasoningCount >= 1 || messages.length > 5) {
    score = 2;
    label = 'moderate';
  } else {
    score = 1;
    label = 'simple';
  }

  return {
    score,
    label,
    tokenEstimate,
    features,
    hasImages,
    hasTools,
  };
}
