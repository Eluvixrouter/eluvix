import crypto from 'node:crypto';

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
  /**
   * Only 'heuristic' exists. The former 'classifier' and 'llm-guard' modes
   * were declared for years but never implemented (audit M-11): they are
   * removed from the type, validateConfig rejects them on save, and
   * sanitizeLoadedConfig coerces them to 'heuristic' + block on load.
   * Values arriving from untyped sources still trigger the loud runtime
   * warning in noteUnimplementedGuardMode() below.
   */
  mode?: 'heuristic';
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
  /**
   * Audit M-12: with action 'warn', detected PII is REDACTED by default.
   * Set this to true to restore the legacy behavior (forward unredacted,
   * log the detection types only). Deliberately opt-in: forwarding known
   * PII because a warning was logged is how leaks happen.
   */
  allowDetectedPii?: boolean;
}

// Common prompt injection attack patterns & system prompt leakage keywords
const INJECTION_PATTERNS: Array<{ regex: RegExp; label: string; weight: number }> = [
  {
    // Bounded filler words between the trigger verb and the target noun:
    // the old pattern required exactly one anchor word, so doubling it
    // ("previous previous") or inserting one ("the", "secret") defeated
    // the match while preserving meaning. Up to 4 fillers covers the
    // observed evasions without turning the pattern into a free-form
    // verb-to-noun span.
    regex: /(?:ignore|disregard|forget|override|bypass)\s+(?:\w+\s+){0,4}(?:instructions|prompts|rules|commands|directives)/i,
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
    // JWTs (three base64url segments; header segment starts with eyJ)
    regex: /\beyJ[a-zA-Z0-9_-]{8,}\.[a-zA-Z0-9_-]{8,}\.[a-zA-Z0-9_-]{8,}\b/g,
    label: 'jwt_token',
    placeholder: '[REDACTED_JWT]',
    key: 'apiKey'
  },
  {
    // PEM private key block headers
    regex: /-----BEGIN (?:[A-Z0-9 ]+ )?PRIVATE KEY-----/g,
    label: 'private_key',
    placeholder: '[REDACTED_PRIVATE_KEY]',
    key: 'apiKey'
  },
  {
    // Generic Bearer tokens in Authorization-style text
    regex: /\bBearer\s+[a-zA-Z0-9._~+/-]{16,}=*/g,
    label: 'bearer_token',
    placeholder: '[REDACTED_BEARER_TOKEN]',
    key: 'apiKey'
  },
  {
    // Social Security Numbers (US SSN: XXX-XX-XXXX or XXX XX XXXX)
    regex: /\b\d{3}[- ]\d{2}[- ]\d{4}\b/g,
    label: 'us_ssn',
    placeholder: '[REDACTED_SSN]',
    key: 'ssn'
  },
  {
    // Credit Cards (Visa, MasterCard, Amex, Discover) — contiguous digits
    regex: /\b(?:4[0-9]{12}(?:[0-9]{3})?|5[1-5][0-9]{14}|3[47][0-9]{13}|6(?:011|5[0-9]{2})[0-9]{12})\b/g,
    label: 'credit_card',
    placeholder: '[REDACTED_CREDIT_CARD]',
    key: 'creditCard'
  },
  {
    // Credit Cards — grouped presentation formats (4-4-4-4 and Amex 4-6-5,
    // space or dash separated). Audit M-12: grouped numbers sailed past
    // the contiguous-only pattern above.
    regex: /\b(?:\d{4}[- ]){3}\d{4}\b|\b\d{4}[- ]\d{6}[- ]\d{5}\b/g,
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

// Prompt-guard modes 'classifier' and 'llm-guard' were declared in
// PromptGuardConfig for years but never implemented — only the regex
// heuristics below exist (audit M-11). They are now REMOVED from the type:
// validateConfig rejects them on save and sanitizeLoadedConfig coerces
// them on load. Values can still arrive here from untyped sources (raw
// JSON, JS callers), so warn loudly (once per mode per process) and apply
// the heuristics rather than silently pretending model-based screening
// is active.
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

// Salted SHA-256 replacement for the old 32-bit simpleHash: the old hash
// was reversible by brute force (a 10k SSN serial space fell in ~4 ms).
// The salt is generated once per process and never leaves it, so a
// [HASH:...] value cannot be inverted from the redacted output alone.
// Consequence, documented: the same value hashes differently across
// processes — 'hash' style is stable within a run, not across runs.
// (The default redactionStyle is 'token'; this only hardens the opt-in.)
const HASH_SALT = crypto.randomBytes(16).toString('hex');

function simpleHash(str: string): string {
  return crypto.createHash('sha256').update(`${HASH_SALT}:${str}`).digest('hex').slice(0, 16);
}

// ---------------------------------------------------------------------------
// Scan normalization (audit H-6)
//
// The heuristic patterns are plain-English regexes, so any encoding of the
// trigger phrases defeated them: Cyrillic/Greek homoglyphs, zero-width
// splits, fullwidth forms, or a base64/hex blob carrying the payload.
// Before scanning, every text is expanded into scan variants — the raw
// text, the normalized text (NFKC + zero-width stripped + homoglyph
// folded), and bounded decode-and-rescan candidates — and a match in ANY
// variant counts.
// ---------------------------------------------------------------------------

const ZERO_WIDTH_RE = /[\u200B-\u200D\uFEFF\u2060\u00AD\u180E]/g;

// Common Cyrillic / Greek lookalikes of Latin letters.
const HOMOGLYPH_MAP: Record<string, string> = {
  // Cyrillic
  '\u0430': 'a', '\u0435': 'e', '\u043E': 'o', '\u0440': 'p', '\u0441': 'c',
  '\u0445': 'x', '\u0443': 'y', '\u0456': 'i', '\u0458': 'j', '\u0455': 's',
  '\u04BB': 'h', '\u0501': 'd', '\u043A': 'k', '\u043C': 'm', '\u043D': 'h',
  '\u0442': 't', '\u0410': 'A', '\u0412': 'B', '\u0415': 'E', '\u041A': 'K',
  '\u041C': 'M', '\u041D': 'H', '\u041E': 'O', '\u0420': 'P', '\u0421': 'C',
  '\u0422': 'T', '\u0425': 'X',
  // Greek
  '\u03B1': 'a', '\u03BF': 'o', '\u03B5': 'e', '\u03B9': 'i', '\u03BA': 'k',
  '\u03BD': 'v', '\u03C4': 't', '\u03C5': 'u', '\u03C7': 'x', '\u03C1': 'p',
  '\u0391': 'A', '\u0392': 'B', '\u0395': 'E', '\u0396': 'Z', '\u0397': 'H',
  '\u0399': 'I', '\u039A': 'K', '\u039C': 'M', '\u039D': 'N', '\u039F': 'O',
  '\u03A1': 'P', '\u03A4': 'T', '\u03A5': 'Y', '\u03A7': 'X'
};

export function normalizeForScan(text: string): string {
  if (!text) return text;
  const base = text.normalize('NFKC').replace(ZERO_WIDTH_RE, '');
  let folded = '';
  for (const ch of base) folded += HOMOGLYPH_MAP[ch] ?? ch;
  return folded;
}

// Bounds for decode-and-rescan: at most this many decoded candidates per
// text, each truncated to this many characters.
const MAX_DECODED_CANDIDATES = 8;
const MAX_DECODED_CHARS = 4096;

function isMostlyPrintable(s: string): boolean {
  if (!s) return false;
  let printable = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if ((c >= 0x20 && c < 0x7f) || c === 0x0a || c === 0x0d || c === 0x09) printable++;
  }
  return printable / s.length >= 0.85;
}

export function extractDecodedCandidates(text: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const push = (decoded: string) => {
    if (out.length >= MAX_DECODED_CANDIDATES) return;
    // Only rescan decodings that look like text (printable + contains a
    // word); random binary decodings of hashes/ids are noise, not payloads.
    if (!isMostlyPrintable(decoded) || !/[a-zA-Z]{3,}/.test(decoded)) return;
    const trimmed = decoded.slice(0, MAX_DECODED_CHARS);
    if (!seen.has(trimmed)) {
      seen.add(trimmed);
      out.push(trimmed);
    }
  };
  const b64re = /[A-Za-z0-9+/=_-]{24,}/g;
  for (const m of text.match(b64re) || []) {
    if (out.length >= MAX_DECODED_CANDIDATES) break;
    const cleaned = m.replace(/=+$/, '');
    if (cleaned.length % 4 === 1) continue; // cannot be valid base64
    try {
      push(Buffer.from(m, 'base64').toString('utf8'));
    } catch {
      /* not decodable — ignore */
    }
  }
  const hexre = /\b(?:[0-9a-fA-F]{2}){12,}\b/g;
  for (const m of text.match(hexre) || []) {
    if (out.length >= MAX_DECODED_CANDIDATES) break;
    try {
      push(Buffer.from(m, 'hex').toString('utf8'));
    } catch {
      /* not decodable — ignore */
    }
  }
  return out;
}

/** Raw + normalized + decoded variants of a text; a match in any counts. */
function collectScanVariants(content: string): string[] {
  const variants: string[] = [];
  const seen = new Set<string>();
  const push = (s: string) => {
    if (s && !seen.has(s)) {
      seen.add(s);
      variants.push(s);
    }
  };
  push(content);
  const normalized = normalizeForScan(content);
  push(normalized);
  for (const source of [content, normalized]) {
    for (const decoded of extractDecodedCandidates(source)) {
      push(decoded);
      push(normalizeForScan(decoded));
    }
  }
  return variants;
}

// ---------------------------------------------------------------------------
// Threshold semantics (audit M-11): a threshold above the highest pattern
// weight used to silently disable EVERY pattern — the config looked
// stricter while the guard did nothing. Clamp to the max weight and say
// so, once per distinct value.
// ---------------------------------------------------------------------------

const MAX_PATTERN_WEIGHT = Math.max(...INJECTION_PATTERNS.map((p) => p.weight));
const warnedThresholds = new Set<number>();

export function effectiveGuardThreshold(requested: number): number {
  if (requested > MAX_PATTERN_WEIGHT) {
    if (!warnedThresholds.has(requested)) {
      warnedThresholds.add(requested);
      console.warn(
        `[Prompt Guard] WARNING: configured threshold ${requested} exceeds the highest pattern weight (${MAX_PATTERN_WEIGHT}); clamping the threshold so the strongest patterns can still fire.`
      );
    }
    return MAX_PATTERN_WEIGHT;
  }
  return requested;
}

/**
 * Fast sub-millisecond local heuristic injection scanner
 */
export function checkPromptHeuristics(content: string, configOrThreshold: number | PromptGuardConfig = 0.80): GuardCheckResult {
  if (!content || typeof content !== 'string') {
    return { passed: true, score: 0 };
  }

  const threshold = effectiveGuardThreshold(
    typeof configOrThreshold === 'number' ? configOrThreshold : (configOrThreshold.threshold ?? 0.80)
  );
  const config = typeof configOrThreshold === 'object' ? configOrThreshold : undefined;

  noteUnimplementedGuardMode(config);

  // Scan variants: raw text plus its normalized/decoded forms (H-6), so an
  // encoded or lookalike-obfuscated payload cannot slip past the regexes.
  const variants = collectScanVariants(content);

  // 1. Check custom banned phrases
  if (config?.bannedPhrases && config.bannedPhrases.length > 0) {
    const lowerVariants = variants.map((v) => v.toLowerCase());
    for (const phrase of config.bannedPhrases) {
      if (phrase.trim() && lowerVariants.some((v) => v.includes(phrase.trim().toLowerCase()))) {
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

    if (pattern.weight >= threshold && variants.some((v) => pattern.regex.test(v))) {
      return {
        passed: false,
        score: pattern.weight,
        reason: `Potential prompt injection / adversarial pattern detected: ${pattern.label}`,
        matchedRule: pattern.label
      };
    }
  }

  return { passed: true, score: 0 };
}

export type MessageContentPart = 
  | { type: 'text'; text: string }
  | { type: 'image_url'; image_url: { url: string } };

export interface ChatMessageLike {
  role: string;
  content: string | MessageContentPart[] | Array<Record<string, any>>;
  tool_calls?: any[];
  tool_call_id?: string;
  name?: string;
}

/**
 * All scannable text in one message (audit H-7): plain content, the text
 * of EVERY content-part shape (text / input_text / output_text / … — not
 * just the canonical `{type:'text'}`), image URLs, and the serialized
 * tool_calls (function arguments are a classic indirect-injection and
 * PII channel that used to bypass both guards entirely).
 */
export function extractMessageText(msg: ChatMessageLike): string {
  const pieces: string[] = [];
  if (typeof msg.content === 'string') {
    pieces.push(msg.content);
  } else if (Array.isArray(msg.content)) {
    for (const part of msg.content as any[]) {
      if (!part || typeof part !== 'object') continue;
      if (typeof part.text === 'string') pieces.push(part.text);
      if (part.type === 'image_url' && typeof part.image_url?.url === 'string') {
        pieces.push(part.image_url.url);
      }
    }
  }
  if (Array.isArray(msg.tool_calls) && msg.tool_calls.length > 0) {
    try {
      pieces.push(JSON.stringify(msg.tool_calls));
    } catch {
      /* unserializable tool_calls — nothing scannable */
    }
  }
  return pieces.join('\n');
}

/**
 * Checks an entire chat request against prompt injection rules.
 *
 * Audit H-7: this used to scan only user/system string-or-text-part
 * content, so assistant/tool/developer turns, tool_calls arguments, and
 * non-canonical content parts were unscanned — and a payload split across
 * two messages matched nothing anywhere. Now every message is scanned
 * individually AND the whole conversation is scanned concatenated, which
 * is what catches split payloads.
 */
export function validateChatPrompt(messages: ChatMessageLike[], configOrThreshold: number | PromptGuardConfig = 0.80): GuardCheckResult {
  noteUnimplementedGuardMode(typeof configOrThreshold === 'object' ? configOrThreshold : undefined);
  const texts: string[] = [];
  for (const msg of messages) {
    const text = extractMessageText(msg);
    texts.push(text);
    if (!text) continue;
    const result = checkPromptHeuristics(text, configOrThreshold);
    if (!result.passed) {
      return result;
    }
  }
  if (texts.length > 1) {
    const joined = checkPromptHeuristics(texts.join('\n'), configOrThreshold);
    if (!joined.passed) {
      return joined;
    }
  }
  return { passed: true, score: 0 };
}

/**
 * Response-side guard scan (audit H-8, remediation decision D8).
 *
 * Model output used to be trusted blindly: a reply could carry live
 * credentials or injection-shaped text straight to the client — and,
 * worse, into long-term memory via write-back — without any scan. This
 * scans completed assistant text with BOTH pattern sets: the privacy set
 * (credential/PII shapes) and the injection heuristics. Callers decide
 * what to do with a detection; per D8 the client-facing path ships in
 * WARN mode (log + marker header), while the memory write-back path
 * treats any detection as grounds to skip the write.
 */
export interface ResponseGuardScan {
  detected: boolean;
  /** Union of the injection matchedRule and the privacy type labels. */
  rules: string[];
  injection: GuardCheckResult;
  piiTypes: string[];
}

export function scanResponseContent(
  content: string,
  opts?: { promptGuard?: PromptGuardConfig; privacyGuard?: PrivacyGuardConfig }
): ResponseGuardScan {
  if (!content || typeof content !== 'string') {
    return { detected: false, rules: [], injection: { passed: true, score: 0 }, piiTypes: [] };
  }
  const injection = checkPromptHeuristics(content, opts?.promptGuard ?? { enabled: true, threshold: 0.80 });
  const pii = scanAndMaskPii(content, opts?.privacyGuard);
  const rules: string[] = [];
  if (!injection.passed && injection.matchedRule) rules.push(injection.matchedRule);
  for (const t of pii.types) {
    if (!rules.includes(t)) rules.push(t);
  }
  return {
    detected: !injection.passed || pii.detected,
    rules,
    injection,
    piiTypes: pii.types
  };
}

/**
 * Strips detected prompt threats and banned phrases from content
 */
export function stripPromptThreats(content: string, configOrThreshold: number | PromptGuardConfig = 0.80): string {
  if (!content || typeof content !== 'string') return content;
  const threshold = effectiveGuardThreshold(
    typeof configOrThreshold === 'number' ? configOrThreshold : (configOrThreshold.threshold ?? 0.80)
  );
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
    const base: any = { ...m };
    if (Array.isArray(m.content)) {
      base.content = (m.content as any[]).map(part =>
        part && typeof part === 'object' ? { ...part } : part
      );
    }
    if (Array.isArray((m as any).tool_calls)) {
      // Deep-clone so redaction below never mutates the caller's messages.
      try {
        base.tool_calls = JSON.parse(JSON.stringify((m as any).tool_calls));
      } catch {
        base.tool_calls = (m as any).tool_calls;
      }
    }
    return base as T;
  });
  const detectedPiiTypes: Set<string> = new Set();

  // Audit M-12: 'warn' used to forward detected PII unredacted, protected
  // only by a log line. It now redacts by default; forwarding unredacted
  // requires the explicit allowDetectedPii opt-in.
  const redact = config.action === 'anonymize' || (config.action === 'warn' && !config.allowDetectedPii);

  for (let i = 0; i < modifiedMessages.length; i++) {
    const msg = modifiedMessages[i];
    if (typeof msg.content === 'string') {
      const { detected, redacted, types } = scanAndMaskPii(msg.content, config);
      if (detected) {
        types.forEach(t => detectedPiiTypes.add(t));
        if (redact) {
          modifiedMessages[i].content = redacted;
        }
      }
    } else if (Array.isArray(msg.content)) {
      for (let j = 0; j < msg.content.length; j++) {
        const part: any = msg.content[j];
        // Any text-bearing part shape, not just the canonical text type.
        if (part && typeof part.text === 'string') {
          const { detected, redacted, types } = scanAndMaskPii(part.text, config);
          if (detected) {
            types.forEach(t => detectedPiiTypes.add(t));
            if (redact) {
              (modifiedMessages[i].content as any[])[j] = { ...part, text: redacted };
            }
          }
        }
      }
    }

    // tool_calls arguments (audit M-12): a serialized-JSON PII channel
    // that bypassed this guard entirely.
    const calls = (modifiedMessages[i] as any).tool_calls;
    if (Array.isArray(calls)) {
      for (let k = 0; k < calls.length; k++) {
        const call = calls[k];
        const args = call?.function?.arguments;
        if (typeof args === 'string') {
          const { detected, redacted, types } = scanAndMaskPii(args, config);
          if (detected) {
            types.forEach(t => detectedPiiTypes.add(t));
            if (redact) {
              calls[k] = { ...call, function: { ...call.function, arguments: redacted } };
            }
          }
        } else if (call != null) {
          // Non-standard call shape: at least detect (redaction of an
          // unknown structure is not attempted).
          try {
            const { detected, types } = scanAndMaskPii(JSON.stringify(call), config);
            if (detected) types.forEach(t => detectedPiiTypes.add(t));
          } catch {
            /* unserializable — nothing scannable */
          }
        }
      }
    }
  }

  if (detectedPiiTypes.size > 0 && config.action === 'warn') {
    // Never log the PII content itself — detection TYPES only.
    if (config.allowDetectedPii) {
      console.warn(
        `[Privacy Guard Warning] Detected sensitive personal data (${Array.from(detectedPiiTypes).join(', ')}) — ` +
        `proceeding without redaction (action: 'warn', allowDetectedPii: true).`
      );
    } else {
      console.warn(
        `[Privacy Guard Warning] Detected sensitive personal data (${Array.from(detectedPiiTypes).join(', ')}) — ` +
        `detected PII was redacted before forwarding (action: 'warn' redacts by default; set privacyGuard.allowDetectedPii: true to forward unredacted).`
      );
    }
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
