export interface GuardCheckResult {
  passed: boolean;
  score?: number;
  reason?: string;
  matchedRule?: string;
  redactedContent?: string;
}

export interface CustomPiiPattern {
  name: string;
  regex: string;
  placeholder?: string;
}

export interface PromptGuardConfig {
  enabled: boolean;
  mode?: 'heuristic' | 'classifier' | 'llm-guard';
  threshold?: number; // e.g. 0.85
  guardModel?: string;
  upstreamGuardId?: string;
  enforcementAction?: 'block' | 'strip' | 'divert' | 'warn';
  threatVectors?: {
    instructionOverride?: boolean;
    danJailbreak?: boolean;
    systemPromptLeak?: boolean;
    obfuscation?: boolean;
    fake_system_token_injection?: boolean;
    unconditional_compliance?: boolean;
  };
  bannedPhrases?: string[];
}

export interface PrivacyGuardConfig {
  enabled: boolean;
  action: 'block' | 'anonymize' | 'warn'; // whether to block or mask PII with tokens
  redactionStyle?: 'token' | 'asterisk' | 'hash';
  detectPii?: {
    email?: boolean;
    ssn?: boolean;
    creditCard?: boolean;
    apiKey?: boolean;
    ipAddress?: boolean;
    phone?: boolean;
  };
  customPatterns?: CustomPiiPattern[];
  whitelist?: string[]; // terms or tokens exempted from redaction
  auditLogging?: boolean;
}

// Common prompt injection attack patterns & system prompt leakage keywords
const INJECTION_PATTERNS: Array<{ regex: RegExp; label: string; weight: number }> = [
  {
    regex: /(?:ignore|disregard|forget|override|bypass)\s+(?:all\s+)?(?:previous|prior|above|system)\s+(?:instructions|prompts|rules|commands|directives)/i,
    label: 'instruction_override',
    weight: 0.95
  },
  {
    regex: /(?:you\s+are\s+now|act\s+as|pretend\s+to\s+be)\s+(?:DAN|unrestricted|jailbroken|an\s+AI\s+without\s+rules|AIM|KEVIN|Omega)/i,
    label: 'dan_jailbreak_persona',
    weight: 0.92
  },
  {
    regex: /(?:output|reveal|leak|print|show|repeat)\s+(?:the\s+)?(?:exact\s+)?(?:system\s+prompt|initial\s+prompt|developer\s+message|hidden\s+instruction)/i,
    label: 'system_prompt_leakage',
    weight: 0.90
  },
  {
    regex: /\[\s*(?:SYSTEM|ADMIN|DEVELOPER|ROOT)\s*(?:OVERRIDE|INSTRUCTION|COMMAND)\s*\]/i,
    label: 'fake_system_token_injection',
    weight: 0.96
  },
  {
    regex: /(?:from\s+now\s+on|starting\s+now)[^.!?\n]*(?:do\s+not\s+refuse|answer\s+anything|no\s+safety\s+filter)/i,
    label: 'unconditional_compliance',
    weight: 0.88
  },
  {
    regex: /(?:convert|encode|decode|execute)\s+(?:the\s+following\s+)?(?:in\s+)?(?:base64|rot13|hex|morse)[^.!?\n]*(?:ignore|hack|exploit|bypass)/i,
    label: 'obfuscated_instruction_bypass',
    weight: 0.85
  }
];

// Common PII and Sensitive Data Patterns
const PII_PATTERNS: Array<{ regex: RegExp; label: string; placeholder: string; key: keyof NonNullable<PrivacyGuardConfig['detectPii']> }> = [
  {
    // API Keys (OpenAI, Anthropic, AWS, GitHub, Slack, Eluvix, generic bearer tokens)
    regex: /\b(?:sk-(?:proj-|svcacct-)?[a-zA-Z0-9_\-]{20,}|sk-ant-[a-zA-Z0-9_\-]{20,}|elx_[a-zA-Z0-9_\-]{20,}|xox[baprs]-[a-zA-Z0-9_\-]{10,}|AKIA[0-9A-Z]{16}|ghp_[a-zA-Z0-9]{36}|github_pat_[a-zA-Z0-9_]{40,})\b/g,
    label: 'api_key',
    placeholder: '[REDACTED_API_KEY]',
    key: 'apiKey'
  },
  {
    // Social Security Numbers (US SSN: XXX-XX-XXXX)
    regex: /\b\d{3}-\d{2}-\d{4}\b/g,
    label: 'us_ssn',
    placeholder: '[REDACTED_SSN]',
    key: 'ssn'
  },
  {
    // Credit Cards (Visa, MasterCard, Amex, Discover)
    regex: /\b(?:4[0-9]{12}(?:[0-9]{3})?|5[1-5][0-9]{14}|3[47][0-9]{13}|6(?:011|5[0-9]{2})[0-9]{12})\b/g,
    label: 'credit_card',
    placeholder: '[REDACTED_CREDIT_CARD]',
    key: 'creditCard'
  },
  {
    // Email addresses
    regex: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g,
    label: 'email_address',
    placeholder: '[REDACTED_EMAIL]',
    key: 'email'
  },
  {
    // Phone numbers (US / international formats)
    regex: /\b(?:\+?\d{1,3}[-.\s]?)?\(?\d{3}\)?[-.\s]?\d{3}[-.\s]?\d{4}\b/g,
    label: 'phone_number',
    placeholder: '[REDACTED_PHONE]',
    key: 'phone'
  },
  {
    // IPv4 addresses (excluding private loopback localhost optionally, but flagged by default)
    regex: /\b(?:(?:25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)\.){3}(?:25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)\b/g,
    label: 'ip_address',
    placeholder: '[REDACTED_IP]',
    key: 'ipAddress'
  }
];

// Prompt-guard modes 'classifier' and 'llm-guard' are declared in
// PromptGuardConfig but NOT implemented — only the regex heuristics below
// exist. Silently accepting the config would let an operator believe
// model-based screening is active when it is not, so warn loudly (once per
// mode per process) and apply the heuristics.
const warnedUnimplementedGuardModes = new Set<string>();

function noteUnimplementedGuardMode(config?: PromptGuardConfig): void {
  const mode = config?.mode;
  if (!mode || mode === 'heuristic') return;
  if (warnedUnimplementedGuardModes.has(mode)) return;
  warnedUnimplementedGuardModes.add(mode);
  console.warn(
    `[Prompt Guard] WARNING: promptGuard.mode '${mode}' is not implemented — no classifier/LLM guard exists in this build. ` +
    `Falling back to the built-in regex heuristics; do not rely on '${mode}' for model-based screening.`
  );
}

function simpleHash(str: string): string {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    hash = ((hash << 5) - hash) + str.charCodeAt(i);
    hash |= 0;
  }
  return Math.abs(hash).toString(16).padStart(8, '0').slice(0, 8);
}

/**
 * Fast sub-millisecond local heuristic injection scanner
 */
export function checkPromptHeuristics(content: string, configOrThreshold: number | PromptGuardConfig = 0.80): GuardCheckResult {
  if (!content || typeof content !== 'string') {
    return { passed: true, score: 0 };
  }

  const threshold = typeof configOrThreshold === 'number' ? configOrThreshold : (configOrThreshold.threshold ?? 0.80);
  const config = typeof configOrThreshold === 'object' ? configOrThreshold : undefined;

  noteUnimplementedGuardMode(config);

  // 1. Check custom banned phrases
  if (config?.bannedPhrases && config.bannedPhrases.length > 0) {
    const lowerContent = content.toLowerCase();
    for (const phrase of config.bannedPhrases) {
      if (phrase.trim() && lowerContent.includes(phrase.trim().toLowerCase())) {
        return {
          passed: false,
          score: 1.0,
          reason: `Matches forbidden phrase: "${phrase}"`,
          matchedRule: 'banned_phrase'
        };
      }
    }
  }

  // 2. Check injection patterns with threat vector gating
  for (const pattern of INJECTION_PATTERNS) {
    // Check threat vector toggle
    if (config?.threatVectors) {
      if (pattern.label === 'instruction_override' && config.threatVectors.instructionOverride === false) continue;
      if (pattern.label === 'dan_jailbreak_persona' && config.threatVectors.danJailbreak === false) continue;
      if (pattern.label === 'system_prompt_leakage' && config.threatVectors.systemPromptLeak === false) continue;
      if (pattern.label === 'obfuscated_instruction_bypass' && config.threatVectors.obfuscation === false) continue;
      if (pattern.label === 'fake_system_token_injection' && config.threatVectors.fake_system_token_injection === false) continue;
      if (pattern.label === 'unconditional_compliance' && config.threatVectors.unconditional_compliance === false) continue;
    }

    if (pattern.regex.test(content)) {
      if (pattern.weight >= threshold) {
        return {
          passed: false,
          score: pattern.weight,
          reason: `Potential prompt injection / adversarial pattern detected: ${pattern.label}`,
          matchedRule: pattern.label
        };
      }
    }
  }

  return { passed: true, score: 0 };
}

export type MessageContentPart = 
  | { type: 'text'; text: string }
  | { type: 'image_url'; image_url: { url: string } };

export interface ChatMessageLike {
  role: string;
  content: string | MessageContentPart[];
}

/**
 * Checks an entire chat request against prompt injection rules
 */
export function validateChatPrompt(messages: ChatMessageLike[], configOrThreshold: number | PromptGuardConfig = 0.80): GuardCheckResult {
  noteUnimplementedGuardMode(typeof configOrThreshold === 'object' ? configOrThreshold : undefined);
  for (const msg of messages) {
    const text = typeof msg.content === 'string'
      ? msg.content
      : Array.isArray(msg.content)
        ? msg.content.filter(p => p.type === 'text').map((p: any) => p.text).join('\n')
        : '';
    if (text) {
      const result = checkPromptHeuristics(text, configOrThreshold);
      if (!result.passed) {
        return result;
      }
    }
  }
  return { passed: true, score: 0 };
}

/**
 * Strips detected prompt threats and banned phrases from content
 */
export function stripPromptThreats(content: string, configOrThreshold: number | PromptGuardConfig = 0.80): string {
  if (!content || typeof content !== 'string') return content;
  const threshold = typeof configOrThreshold === 'number' ? configOrThreshold : (configOrThreshold.threshold ?? 0.80);
  const config = typeof configOrThreshold === 'object' ? configOrThreshold : undefined;

  let cleaned = content;
  const maxPasses = 5;

  for (let pass = 0; pass < maxPasses; pass++) {
    const prev = cleaned;

    // 1. Strip custom banned phrases
    if (config?.bannedPhrases && config.bannedPhrases.length > 0) {
      for (const phrase of config.bannedPhrases) {
        if (phrase.trim()) {
          const esc = phrase.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
          cleaned = cleaned.replace(new RegExp(esc, 'gi'), '');
        }
      }
    }

    // 2. Strip injection patterns with threat vector gating
    for (const pattern of INJECTION_PATTERNS) {
      if (config?.threatVectors) {
        if (pattern.label === 'instruction_override' && config.threatVectors.instructionOverride === false) continue;
        if (pattern.label === 'dan_jailbreak_persona' && config.threatVectors.danJailbreak === false) continue;
        if (pattern.label === 'system_prompt_leakage' && config.threatVectors.systemPromptLeak === false) continue;
        if (pattern.label === 'obfuscated_instruction_bypass' && config.threatVectors.obfuscation === false) continue;
        if (pattern.label === 'fake_system_token_injection' && config.threatVectors.fake_system_token_injection === false) continue;
        if (pattern.label === 'unconditional_compliance' && config.threatVectors.unconditional_compliance === false) continue;
      }
      if (pattern.weight >= threshold) {
        cleaned = cleaned.replace(new RegExp(pattern.regex.source, 'gi'), '');
      }
    }

    if (cleaned === prev) {
      break;
    }
  }

  return cleaned.trim();
}

/**
 * Scans and optionally redacts/anonymizes PII from content
 */
export function scanAndMaskPii(
  content: string,
  config?: PrivacyGuardConfig | PrivacyGuardConfig['detectPii']
): { detected: boolean; redacted: string; types: string[] } {
  if (!content || typeof content !== 'string') {
    return { detected: false, redacted: content, types: [] };
  }

  const piiFlags = (config && 'detectPii' in config) ? config.detectPii : (config as PrivacyGuardConfig['detectPii']);
  const fullConfig = (config && 'enabled' in config) ? (config as PrivacyGuardConfig) : undefined;
  const style = fullConfig?.redactionStyle || 'token';
  const whitelist = new Set((fullConfig?.whitelist || []).map(w => w.trim().toLowerCase()));

  let redacted = content;
  const types: string[] = [];
  let detected = false;

  const formatReplacement = (match: string, placeholder: string): string => {
    if (style === 'asterisk') {
      return '•'.repeat(Math.min(match.length, 12));
    } else if (style === 'hash') {
      return `[HASH:${simpleHash(match)}]`;
    }
    return placeholder;
  };

  // 1. Built-in PII patterns
  for (const p of PII_PATTERNS) {
    if (piiFlags && piiFlags[p.key] === false) {
      continue;
    }

    if (p.regex.test(redacted)) {
      p.regex.lastIndex = 0;
      redacted = redacted.replace(p.regex, (match) => {
        if (whitelist.has(match.toLowerCase())) {
          return match;
        }
        detected = true;
        if (!types.includes(p.label)) types.push(p.label);
        return formatReplacement(match, p.placeholder);
      });
    }
  }

  // 2. Custom Regex Patterns
  if (fullConfig?.customPatterns && fullConfig.customPatterns.length > 0) {
    for (const cp of fullConfig.customPatterns) {
      try {
        const regex = new RegExp(cp.regex, 'g');
        if (regex.test(redacted)) {
          regex.lastIndex = 0;
          redacted = redacted.replace(regex, (match) => {
            if (whitelist.has(match.toLowerCase())) {
              return match;
            }
            detected = true;
            if (!types.includes(cp.name)) types.push(cp.name);
            return formatReplacement(match, cp.placeholder || `[REDACTED_${cp.name.toUpperCase()}]`);
          });
        }
      } catch (err) {
        console.warn(`[PrivacyGuard] Invalid custom regex pattern "${cp.regex}":`, err);
      }
    }
  }

  return { detected, redacted, types };
}

/**
 * Applies privacy guard inspection and masking across chat messages
 */
export function applyPrivacyGuard<T extends ChatMessageLike>(
  messages: T[],
  config: PrivacyGuardConfig
): { passed: boolean; reason?: string; modifiedMessages: T[] } {
  if (!config.enabled) {
    return { passed: true, modifiedMessages: messages };
  }

  const modifiedMessages = messages.map(m => {
    if (typeof m.content === 'string') {
      return { ...m };
    } else if (Array.isArray(m.content)) {
      return {
        ...m,
        content: m.content.map(part => ({ ...part }))
      };
    }
    return { ...m };
  });
  const detectedPiiTypes: Set<string> = new Set();

  for (let i = 0; i < modifiedMessages.length; i++) {
    const msg = modifiedMessages[i];
    if (typeof msg.content === 'string') {
      const { detected, redacted, types } = scanAndMaskPii(msg.content, config);
      if (detected) {
        types.forEach(t => detectedPiiTypes.add(t));
        if (config.action === 'anonymize') {
          modifiedMessages[i].content = redacted;
        }
      }
    } else if (Array.isArray(msg.content)) {
      for (let j = 0; j < msg.content.length; j++) {
        const part = msg.content[j];
        if (part.type === 'text') {
          const { detected, redacted, types } = scanAndMaskPii(part.text, config);
          if (detected) {
            types.forEach(t => detectedPiiTypes.add(t));
            if (config.action === 'anonymize') {
              (modifiedMessages[i].content as MessageContentPart[])[j] = {
                type: 'text',
                text: redacted
              };
            }
          }
        }
      }
    }
  }

  if (detectedPiiTypes.size > 0 && config.action === 'warn') {
    // 'warn' means the messages pass through unredacted — but never
    // silently. Log the detection TYPES only; the PII content itself must
    // never be written to the log.
    console.warn(
      `[Privacy Guard Warning] Detected sensitive personal data (${Array.from(detectedPiiTypes).join(', ')}) — ` +
      `proceeding without redaction (action: 'warn').`
    );
  }

  if (detectedPiiTypes.size > 0 && config.action === 'block') {
    return {
      passed: false,
      reason: `Blocked by Privacy Guard: Contains sensitive personal data (${Array.from(detectedPiiTypes).join(', ')})`,
      modifiedMessages
    };
  }

  return { passed: true, modifiedMessages };
}
