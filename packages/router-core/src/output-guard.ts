/**
 * Browser-safe Output Guardrails & Streaming SSE DLP Filter.
 *
 * Scans model completions, reasoning traces, tool-call arguments, and live SSE token
 * streams (with a sliding holdback window so secrets/PII split across adjacent token
 * chunks are caught before reaching the client).
 *
 * IMPORTANT: Keep ZERO `node:*` imports in this module so client-side compiler,
 * diagnostics, and simulator bundles can import `@eluvix/router-core/output-guard`.
 */

import {
  scanAndMaskPii,
  type PrivacyGuardConfig,
  type CustomPiiPattern,
} from './guard.js';

/**
 * Guards against catastrophic backtracking (ReDoS) in user-configured regexes.
 */
export function isSafeRegexPattern(pattern: string): boolean {
  if (!pattern || typeof pattern !== 'string' || pattern.length > 512) return false;
  // Reject nested quantifiers such as (a+)+, (.*)+, ([a-z]+)*
  if (/(\([^()]*[+*?][^()]*\))[+*?{]/.test(pattern)) return false;
  try {
    new RegExp(pattern);
    return true;
  } catch {
    return false;
  }
}

export interface OutputGuardConfig {
  enabled: boolean;
  action: 'redact' | 'block' | 'audit';
  detectSecrets?: boolean;
  detectPii?: PrivacyGuardConfig['detectPii'];
  blockedRegexes?: string[];
  customPatterns?: CustomPiiPattern[];
  redactionStyle?: 'mask' | 'token' | 'hash' | 'asterisk';
  whitelist?: string[];
  holdbackChars?: number;
}

export interface OutputGuardCheckResult {
  allowed: boolean;
  text: string;
  status: 'clean' | 'redacted' | 'blocked';
  redactionCount: number;
  findings: string[];
  blockedReason?: string;
}

const BUILTIN_SECRET_PATTERNS: Array<{ label: string; regex: RegExp; replacement: string }> = [
  {
    label: 'ELUVIX_API_KEY',
    regex: /\belx_[A-Za-z0-9_-]{8,}\b/g,
    replacement: '[REDACTED_ELUVIX_KEY]',
  },
  {
    label: 'OPENAI_API_KEY',
    regex: /\bsk-(?:proj-|live-|test-)?[A-Za-z0-9_-]{16,}\b/g,
    replacement: '[REDACTED_API_KEY]',
  },
  {
    label: 'ANTHROPIC_API_KEY',
    regex: /\bsk-ant-[A-Za-z0-9_-]{12,}\b/g,
    replacement: '[REDACTED_ANTHROPIC_KEY]',
  },
  {
    label: 'GITHUB_TOKEN',
    regex: /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}\b/g,
    replacement: '[REDACTED_GITHUB_TOKEN]',
  },
  {
    label: 'AWS_ACCESS_KEY',
    regex: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g,
    replacement: '[REDACTED_AWS_KEY]',
  },
  {
    label: 'PRIVATE_KEY_BLOCK',
    regex: /-----BEGIN (?:RSA |EC |OPENSSH |PGP )?PRIVATE KEY-----[\s\S]*?-----END (?:RSA |EC |OPENSSH |PGP )?PRIVATE KEY-----/g,
    replacement: '[REDACTED_PRIVATE_KEY]',
  },
];

/**
 * Applies Output Guardrail inspection (secrets, PII, and custom/blocked regexes)
 * to a single string.
 */
export function applyOutputGuardToText(
  rawText: string,
  config?: OutputGuardConfig | null
): OutputGuardCheckResult {
  if (!config || !config.enabled || !rawText) {
    return {
      allowed: true,
      text: rawText || '',
      status: 'clean',
      redactionCount: 0,
      findings: [],
    };
  }

  let working = rawText;
  let redactionCount = 0;
  const findings: string[] = [];

  // 1. Built-in high-entropy secret / credential leak patterns
  if (config.detectSecrets !== false) {
    for (const pat of BUILTIN_SECRET_PATTERNS) {
      const regex = new RegExp(pat.regex.source, pat.regex.flags);
      const matches = working.match(regex);
      if (matches && matches.length > 0) {
        redactionCount += matches.length;
        if (!findings.includes(pat.label)) findings.push(pat.label);
        if (config.action === 'redact') {
          working = working.replace(regex, pat.replacement);
        }
      }
    }
  }

  // 2. Blocked regexes
  if (Array.isArray(config.blockedRegexes)) {
    for (const rawPattern of config.blockedRegexes) {
      if (!rawPattern || typeof rawPattern !== 'string') continue;
      if (!isSafeRegexPattern(rawPattern)) continue;
      try {
        const rx = new RegExp(rawPattern, 'gi');
        const matches = working.match(rx);
        if (matches && matches.length > 0) {
          redactionCount += matches.length;
          const label = `BLOCKED_REGEX(${rawPattern.slice(0, 24)})`;
          if (!findings.includes(label)) findings.push(label);
          if (config.action === 'redact') {
            working = working.replace(rx, '[REDACTED_POLICY]');
          }
        }
      } catch {
        // Ignore invalid user regex
      }
    }
  }

  // 3. PII & Custom Patterns via PrivacyGuard engine
  const hasPiiChecks =
    config.detectPii === undefined ||
    Object.values(config.detectPii).some(Boolean) ||
    (Array.isArray(config.customPatterns) && config.customPatterns.length > 0);

  if (hasPiiChecks) {
    const mappedStyle =
      config.redactionStyle === 'mask' ? 'asterisk' : config.redactionStyle || 'token';
    const piiRes = scanAndMaskPii(working, {
      enabled: true,
      action: config.action === 'audit' ? 'anonymize' : config.action === 'block' ? 'block' : 'anonymize',
      detectPii: config.detectPii ?? {
        email: true,
        phone: true,
        ssn: true,
        creditCard: true,
        ipAddress: false,
        apiKey: true,
      },
      customPatterns: config.customPatterns,
      redactionStyle: mappedStyle,
      whitelist: config.whitelist,
      auditLogging: false,
    });

    if (piiRes.detected) {
      redactionCount += Math.max(1, piiRes.types.length);
      for (const t of piiRes.types) {
        if (!findings.includes(t)) findings.push(t);
      }
      if (config.action === 'redact') {
        working = piiRes.redacted;
      }
    }
  }

  if (redactionCount === 0) {
    return {
      allowed: true,
      text: rawText,
      status: 'clean',
      redactionCount: 0,
      findings: [],
    };
  }

  if (config.action === 'block') {
    const reason = `Output blocked by Output Guardrail (${findings.join(', ')})`;
    return {
      allowed: false,
      text: `[OUTPUT GUARD BLOCKED: ${findings.join(', ')}]`,
      status: 'blocked',
      redactionCount,
      findings,
      blockedReason: reason,
    };
  }

  if (config.action === 'audit') {
    return {
      allowed: true,
      text: rawText,
      status: 'clean',
      redactionCount,
      findings,
    };
  }

  return {
    allowed: true,
    text: working,
    status: 'redacted',
    redactionCount,
    findings,
  };
}

/**
 * Applies Output Guardrail inspection across all choices, reasoning fields, and tool call
 * arguments of a non-streaming OpenAI Chat Completion JSON response.
 */
export function applyOutputGuardToChatCompletionJson(
  payload: Record<string, any>,
  config?: OutputGuardConfig | null
): { payload: Record<string, any>; result: OutputGuardCheckResult } {
  if (!config || !config.enabled || !payload || typeof payload !== 'object') {
    return {
      payload,
      result: {
        allowed: true,
        text: '',
        status: 'clean',
        redactionCount: 0,
        findings: [],
      },
    };
  }

  const nextPayload = JSON.parse(JSON.stringify(payload));
  let totalRedactions = 0;
  const allFindings: string[] = [];
  let blockedReason: string | undefined;

  const mergeResult = (r: OutputGuardCheckResult) => {
    totalRedactions += r.redactionCount;
    for (const f of r.findings) {
      if (!allFindings.includes(f)) allFindings.push(f);
    }
    if (!r.allowed && r.blockedReason && !blockedReason) {
      blockedReason = r.blockedReason;
    }
  };

  if (Array.isArray(nextPayload.choices)) {
    for (const choice of nextPayload.choices) {
      const msg = choice?.message;
      if (!msg || typeof msg !== 'object') continue;

      if (typeof msg.content === 'string' && msg.content.length > 0) {
        const res = applyOutputGuardToText(msg.content, config);
        mergeResult(res);
        msg.content = res.text;
        if (!res.allowed) {
          choice.finish_reason = 'content_filter';
        }
      }

      if (typeof msg.reasoning_content === 'string' && msg.reasoning_content.length > 0) {
        const res = applyOutputGuardToText(msg.reasoning_content, config);
        mergeResult(res);
        msg.reasoning_content = res.text;
      }

      if (Array.isArray(msg.tool_calls)) {
        for (const tc of msg.tool_calls) {
          if (typeof tc?.function?.arguments === 'string' && tc.function.arguments.length > 0) {
            const res = applyOutputGuardToText(tc.function.arguments, config);
            mergeResult(res);
            tc.function.arguments = res.text;
          }
        }
      }
    }
  }

  const status: OutputGuardCheckResult['status'] = blockedReason
    ? 'blocked'
    : totalRedactions > 0 && config.action === 'redact'
    ? 'redacted'
    : 'clean';

  return {
    payload: nextPayload,
    result: {
      allowed: !blockedReason,
      text: '',
      status,
      redactionCount: totalRedactions,
      findings: allFindings,
      blockedReason,
    },
  };
}

/**
 * Wraps an OpenAI SSE `ReadableStream<Uint8Array>` with a sliding lookahead buffer
 * (`holdbackChars`, default `64`) so secrets or PII tokens split across adjacent
 * `delta.content` chunks are caught and redacted/blocked in real time.
 */
export function createStreamingOutputDlpTransform(
  openAiStream: ReadableStream<Uint8Array>,
  config?: OutputGuardConfig | null,
  onResult?: (res: OutputGuardCheckResult) => void
): ReadableStream<Uint8Array> {
  if (!config || !config.enabled) {
    return openAiStream;
  }

  const holdbackChars = Math.max(16, Math.min(256, config.holdbackChars ?? 64));
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();

  let sseBuffer = '';
  let pendingContentWindow = '';
  let lastTemplateChunk: Record<string, any> | null = null;
  let totalRedactions = 0;
  const allFindings: string[] = [];
  let streamBlocked = false;
  let blockedReason: string | undefined;

  const recordGuardOutcome = (res: OutputGuardCheckResult) => {
    if (res.redactionCount > 0) {
      totalRedactions += res.redactionCount;
      for (const f of res.findings) {
        if (!allFindings.includes(f)) allFindings.push(f);
      }
    }
    if (!res.allowed) {
      streamBlocked = true;
      blockedReason = res.blockedReason;
    }
  };

  return new ReadableStream<Uint8Array>({
    async start(controller) {
      const reader = openAiStream.getReader();

      const emitContentDelta = (text: string, baseChunk?: Record<string, any>) => {
        if (!text) return;
        const chunkObj = baseChunk
          ? JSON.parse(JSON.stringify(baseChunk))
          : {
              id: 'chatcmpl_dlp',
              object: 'chat.completion.chunk',
              created: Math.floor(Date.now() / 1000),
              model: 'eluvix',
              choices: [{ index: 0, delta: {}, finish_reason: null }],
            };
        if (!Array.isArray(chunkObj.choices) || chunkObj.choices.length === 0) {
          chunkObj.choices = [{ index: 0, delta: {}, finish_reason: null }];
        }
        chunkObj.choices[0].delta = {
          ...(chunkObj.choices[0].delta || {}),
          content: text,
        };
        chunkObj.choices[0].finish_reason = null;
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(chunkObj)}\n\n`));
      };

      const flushPendingWindow = (forceAll: boolean, templateChunk?: Record<string, any>) => {
        if (!pendingContentWindow || streamBlocked) return;

        const check = applyOutputGuardToText(pendingContentWindow, config);
        recordGuardOutcome(check);

        if (streamBlocked) {
          pendingContentWindow = '';
          const blockChunk = {
            id: templateChunk?.id || lastTemplateChunk?.id || 'chatcmpl_blocked',
            object: 'chat.completion.chunk',
            created: Math.floor(Date.now() / 1000),
            model: templateChunk?.model || lastTemplateChunk?.model || 'eluvix',
            choices: [
              {
                index: 0,
                delta: { content: check.text },
                finish_reason: 'content_filter',
              },
            ],
          };
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(blockChunk)}\n\n`));
          controller.enqueue(encoder.encode('data: [DONE]\n\n'));
          return;
        }

        pendingContentWindow = check.text;

        if (forceAll) {
          const toEmit = pendingContentWindow;
          pendingContentWindow = '';
          emitContentDelta(toEmit, templateChunk || lastTemplateChunk || undefined);
          return;
        }

        if (pendingContentWindow.length > holdbackChars) {
          const safeLen = pendingContentWindow.length - holdbackChars;
          const safePrefix = pendingContentWindow.slice(0, safeLen);
          pendingContentWindow = pendingContentWindow.slice(safeLen);
          emitContentDelta(safePrefix, templateChunk || lastTemplateChunk || undefined);
        }
      };

      const processSseLine = (line: string) => {
        if (streamBlocked) return;
        const trimmed = line.trim();
        if (!trimmed) return;

        if (!trimmed.startsWith('data:')) {
          controller.enqueue(encoder.encode(`${line}\n`));
          return;
        }

        const dataPayload = trimmed.slice(5).trim();
        if (dataPayload === '[DONE]') {
          flushPendingWindow(true);
          if (!streamBlocked) {
            controller.enqueue(encoder.encode('data: [DONE]\n\n'));
          }
          return;
        }

        let parsed: any;
        try {
          parsed = JSON.parse(dataPayload);
        } catch {
          controller.enqueue(encoder.encode(`${line}\n\n`));
          return;
        }

        const choice = parsed?.choices?.[0];
        if (!choice) {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(parsed)}\n\n`));
          return;
        }

        lastTemplateChunk = parsed;
        const delta = choice.delta || {};
        const hasContent = typeof delta.content === 'string' && delta.content.length > 0;

        if (typeof delta.reasoning_content === 'string' && delta.reasoning_content.length > 0) {
          const rCheck = applyOutputGuardToText(delta.reasoning_content, config);
          recordGuardOutcome(rCheck);
          delta.reasoning_content = rCheck.text;
        }

        if (hasContent) {
          pendingContentWindow += delta.content;
          delete delta.content;
          flushPendingWindow(false, parsed);
          if (streamBlocked) return;
        }

        if (choice.finish_reason) {
          flushPendingWindow(true, parsed);
          if (streamBlocked) return;
        }

        const remainingDeltaKeys = Object.keys(delta);
        if (remainingDeltaKeys.length > 0 || choice.finish_reason || parsed.usage) {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(parsed)}\n\n`));
        }
      };

      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          sseBuffer += decoder.decode(value, { stream: true });
          const lines = sseBuffer.split('\n');
          sseBuffer = lines.pop() || '';
          for (const l of lines) {
            processSseLine(l);
            if (streamBlocked) break;
          }
          if (streamBlocked) break;
        }
        if (!streamBlocked && sseBuffer.trim()) {
          processSseLine(sseBuffer);
        }
        if (!streamBlocked && pendingContentWindow) {
          flushPendingWindow(true);
        }
        onResult?.({
          allowed: !streamBlocked,
          text: '',
          status: streamBlocked
            ? 'blocked'
            : totalRedactions > 0 && config.action === 'redact'
            ? 'redacted'
            : 'clean',
          redactionCount: totalRedactions,
          findings: allFindings,
          blockedReason,
        });
        controller.close();
      } catch (err) {
        try {
          controller.error(err);
        } catch {}
      } finally {
        try {
          reader.releaseLock();
        } catch {}
      }
    },
  });
}
