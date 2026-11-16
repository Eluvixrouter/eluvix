import crypto from 'node:crypto';
import {
  isSecretReference,
  maskSecretOrReferenceForDisplay,
  resolveUpstreamSecret,
  resolveUpstreamSecretSync,
} from './secrets.js';
import {
  parsePaperclipContextFromHeadersAndBody,
  parsePaperclipHeaders,
  type PaperclipIntegrationConfig,
  type PaperclipKeyPolicy,
  type PaperclipRequestContext,
  type PaperclipSignatureStatus,
} from './paperclip-context.js';

export const PAPERCLIP_DEFAULT_MAX_SKEW_MS = 300_000;

export type HeaderInput =
  | Record<string, string | string[] | undefined>
  | Headers
  | undefined;

function readRawHeader(headers: HeaderInput, name: string): string | undefined {
  if (!headers) return undefined;
  if (typeof (headers as Headers).get === 'function') {
    const val = (headers as Headers).get(name);
    return val === null ? undefined : val;
  }
  const target = name.toLowerCase();
  for (const [k, v] of Object.entries(
    headers as Record<string, string | string[] | undefined>
  )) {
    if (k.toLowerCase() === target) {
      if (Array.isArray(v)) return v[0];
      return v;
    }
  }
  return undefined;
}

export function canonicalPaperclipSignaturePayload(fields: {
  ts: string;
  runId?: string | null;
  issueId?: string | null;
  agentId?: string | null;
  companyId?: string | null;
  priority?: string | null;
  budgetRemainingPct?: string | null;
  sensitivity?: string | null;
  hop?: string | null;
}): string {
  return [
    'v1',
    fields.ts,
    fields.runId ?? '',
    fields.issueId ?? '',
    fields.agentId ?? '',
    fields.companyId ?? '',
    fields.priority ?? '',
    fields.budgetRemainingPct ?? '',
    fields.sensitivity ?? '',
    fields.hop ?? '0',
  ].join('|');
}

export function signPaperclipContextHeaders(
  headers: Record<string, string>,
  secret: string,
  ts: string = String(Date.now())
): Record<string, string> {
  const payload = canonicalPaperclipSignaturePayload({
    ts,
    runId: headers['x-paperclip-run-id'],
    issueId: headers['x-paperclip-issue-id'],
    agentId: headers['x-paperclip-agent-id'],
    companyId: headers['x-paperclip-company-id'],
    priority: headers['x-paperclip-issue-priority'],
    budgetRemainingPct: headers['x-paperclip-budget-remaining-pct'],
    sensitivity: headers['x-paperclip-sensitivity'],
    hop: headers['x-paperclip-hop'] ?? '0',
  });
  const mac = crypto
    .createHmac('sha256', secret)
    .update(payload, 'utf8')
    .digest('hex');
  return {
    ...headers,
    'x-paperclip-context-ts': ts,
    'x-paperclip-context-sig': `v1.${ts}.${mac}`,
  };
}

export function resolveEffectivePaperclipHmacSecret(
  config?: PaperclipIntegrationConfig,
  keyPolicy?: PaperclipKeyPolicy
): string | undefined {
  const candidates = [
    keyPolicy?.hmacSecret,
    config?.hmacSecret,
    process.env.PAPERCLIP_ELUVIX_HMAC_SECRET,
    process.env.ELUVIX_PAPERCLIP_HMAC_SECRET,
  ];
  for (const c of candidates) {
    if (typeof c !== 'string' || c.trim().length === 0) continue;
    const trimmed = c.trim();
    if (isSecretReference(trimmed)) {
      try {
        const resolved = resolveUpstreamSecretSync(trimmed);
        if (
          typeof resolved === 'string' &&
          resolved.trim().length > 0 &&
          !isSecretReference(resolved.trim())
        ) {
          return resolved.trim();
        }
      } catch {
        // Ignore unresolvable or async-only SecretRef candidate
      }
      continue;
    }
    return trimmed;
  }
  return undefined;
}

/**
 * Async variant of `resolveEffectivePaperclipHmacSecret` supporting all
 * `SecretRef` backends (`env:`, `file:`, `bao:`, `vault:`, `keychain:`).
 */
export async function resolveEffectivePaperclipHmacSecretAsync(
  config?: PaperclipIntegrationConfig,
  keyPolicy?: PaperclipKeyPolicy
): Promise<string | undefined> {
  const candidates = [
    keyPolicy?.hmacSecret,
    config?.hmacSecret,
    process.env.PAPERCLIP_ELUVIX_HMAC_SECRET,
    process.env.ELUVIX_PAPERCLIP_HMAC_SECRET,
  ];
  for (const c of candidates) {
    if (typeof c !== 'string' || c.trim().length === 0) continue;
    const trimmed = c.trim();
    if (isSecretReference(trimmed)) {
      try {
        const resolved = await resolveUpstreamSecret(trimmed);
        if (
          typeof resolved === 'string' &&
          resolved.trim().length > 0 &&
          !isSecretReference(resolved.trim())
        ) {
          return resolved.trim();
        }
      } catch {
        // Ignore unresolvable SecretRef candidate rather than treating the ref itself as a literal secret
      }
      continue;
    }
    return trimmed;
  }
  return undefined;
}

export interface PaperclipSignatureVerification {
  status: PaperclipSignatureStatus;
  valid: boolean;
  reason?: string;
}

export function verifyPaperclipContextSignature(
  headers: HeaderInput,
  opts?: {
    secret?: string;
    nowMs?: number;
    maxSkewMs?: number;
  }
): PaperclipSignatureVerification {
  const rawTs = readRawHeader(headers, 'x-paperclip-context-ts')?.trim();
  const rawSig = readRawHeader(headers, 'x-paperclip-context-sig')?.trim();
  if (!rawTs && !rawSig) {
    return { status: 'unsigned', valid: false, reason: 'missing-signature' };
  }
  if (!rawTs || !rawSig) {
    return { status: 'invalid', valid: false, reason: 'incomplete-signature' };
  }
  if (!opts?.secret) {
    return { status: 'invalid', valid: false, reason: 'missing-secret' };
  }

  const sigMatch = /^v1\.([^.]+)\.([0-9a-fA-F]+)$/.exec(rawSig);
  if (!sigMatch || sigMatch[1] !== rawTs) {
    return { status: 'invalid', valid: false, reason: 'malformed-signature' };
  }

  const tsNum = Number(rawTs);
  if (!Number.isFinite(tsNum) || tsNum <= 0) {
    return { status: 'invalid', valid: false, reason: 'invalid-timestamp' };
  }

  const nowMs = opts.nowMs ?? Date.now();
  const maxSkewMs = opts.maxSkewMs ?? PAPERCLIP_DEFAULT_MAX_SKEW_MS;
  if (Math.abs(nowMs - tsNum) > maxSkewMs) {
    return { status: 'expired', valid: false, reason: 'timestamp-out-of-window' };
  }

  const payload = canonicalPaperclipSignaturePayload({
    ts: rawTs,
    runId: readRawHeader(headers, 'x-paperclip-run-id')?.trim(),
    issueId: readRawHeader(headers, 'x-paperclip-issue-id')?.trim(),
    agentId: readRawHeader(headers, 'x-paperclip-agent-id')?.trim(),
    companyId: readRawHeader(headers, 'x-paperclip-company-id')?.trim(),
    priority: readRawHeader(headers, 'x-paperclip-issue-priority')?.trim(),
    budgetRemainingPct: readRawHeader(
      headers,
      'x-paperclip-budget-remaining-pct'
    )?.trim(),
    sensitivity: readRawHeader(headers, 'x-paperclip-sensitivity')?.trim(),
    hop: readRawHeader(headers, 'x-paperclip-hop')?.trim() ?? '0',
  });

  const expectedHex = crypto
    .createHmac('sha256', opts.secret)
    .update(payload, 'utf8')
    .digest('hex');
  const providedHex = sigMatch[2].toLowerCase();

  if (expectedHex.length !== providedHex.length) {
    return { status: 'invalid', valid: false, reason: 'digest-length-mismatch' };
  }

  const expectedBuf = Buffer.from(expectedHex, 'hex');
  const providedBuf = Buffer.from(providedHex, 'hex');
  if (expectedBuf.length === 0 || expectedBuf.length !== providedBuf.length) {
    return { status: 'invalid', valid: false, reason: 'invalid-hex-digest' };
  }

  if (!crypto.timingSafeEqual(expectedBuf, providedBuf)) {
    return { status: 'invalid', valid: false, reason: 'hmac-mismatch' };
  }

  return { status: 'valid', valid: true };
}

export function isPaperclipCompanyAllowed(
  companyId: string | undefined,
  keyPolicy?: PaperclipKeyPolicy
): boolean {
  if (!keyPolicy?.companyIds || keyPolicy.companyIds.length === 0) {
    return true;
  }
  return typeof companyId === 'string' && keyPolicy.companyIds.includes(companyId);
}

/**
 * Evaluates both caller authorization (`scoped-key` / admin / `loopback`) and
 * cryptographic `x-paperclip-context-sig` HMAC verification before deciding whether
 * privileged Paperclip routing bias headers (`priority`, `budget`, `sensitivity`, `hop`)
 * are trusted.
 */
export function parseVerifiedPaperclipRequest(
  headers: HeaderInput,
  opts: {
    config?: PaperclipIntegrationConfig;
    keyPolicy?: PaperclipKeyPolicy;
    hasPaperclipScope?: boolean;
    isAdminOrSessionCaller?: boolean;
    isLoopbackCaller?: boolean;
    bodyPaperclip?: unknown;
    nowMs?: number;
    maxSkewMs?: number;
    resolvedHmacSecret?: string;
  } = {}
): PaperclipRequestContext {
  const { config, keyPolicy } = opts;
  const baseTrusted = Boolean(
    opts.hasPaperclipScope ||
      opts.isAdminOrSessionCaller ||
      (config?.trustHeadersFrom === 'loopback' && (opts.isLoopbackCaller ?? true))
  );

  const secret =
    opts.resolvedHmacSecret !== undefined
      ? opts.resolvedHmacSecret
      : resolveEffectivePaperclipHmacSecret(config, keyPolicy);
  const verification = verifyPaperclipContextSignature(headers, {
    secret,
    nowMs: opts.nowMs,
    maxSkewMs: opts.maxSkewMs,
  });

  const allowUnsignedExplicit =
    typeof keyPolicy?.allowUnsignedContext === 'boolean'
      ? keyPolicy.allowUnsignedContext
      : config?.requireSignedContext === false;
  const requireSigned =
    keyPolicy?.allowUnsignedContext === true
      ? false
      : Boolean(secret || keyPolicy?.hmacSecret || config?.hmacSecret) ||
        config?.requireSignedContext === true;

  let trusted = baseTrusted;
  const extraDropped: string[] = [];

  if (baseTrusted) {
    if (verification.status === 'valid') {
      trusted = true;
    } else if (verification.status === 'invalid') {
      trusted = false;
      extraDropped.push('x-paperclip-context-sig');
    } else if (verification.status === 'expired') {
      trusted = false;
      extraDropped.push('x-paperclip-context-ts', 'x-paperclip-context-sig');
    } else if (verification.status === 'unsigned') {
      if (requireSigned && !allowUnsignedExplicit) {
        trusted = false;
        extraDropped.push('x-paperclip-context-sig');
      }
    }
  }

  const parsed =
    opts.bodyPaperclip !== undefined && opts.bodyPaperclip !== null
      ? parsePaperclipContextFromHeadersAndBody(headers, opts.bodyPaperclip, {
          trusted,
        })
      : parsePaperclipHeaders(headers, { trusted });

  return {
    ...parsed,
    signatureStatus: verification.status,
    ...(keyPolicy ? { keyPolicy } : {}),
    droppedHeaders: Array.from(new Set([...parsed.droppedHeaders, ...extraDropped])),
  };
}

/**
 * Async variant of `parseVerifiedPaperclipRequest` that resolves `bao:`,
 * `vault:`, `keychain:`, `file:`, and `env:` HMAC SecretRefs before verification.
 */
export async function parseVerifiedPaperclipRequestAsync(
  headers: HeaderInput,
  opts: {
    config?: PaperclipIntegrationConfig;
    keyPolicy?: PaperclipKeyPolicy;
    hasPaperclipScope?: boolean;
    isAdminOrSessionCaller?: boolean;
    isLoopbackCaller?: boolean;
    bodyPaperclip?: unknown;
    nowMs?: number;
    maxSkewMs?: number;
  } = {}
): Promise<PaperclipRequestContext> {
  const resolvedHmacSecret = await resolveEffectivePaperclipHmacSecretAsync(
    opts.config,
    opts.keyPolicy
  );
  return parseVerifiedPaperclipRequest(headers, {
    ...opts,
    resolvedHmacSecret,
  });
}

/**
 * Masks literal Paperclip HMAC secrets for API responses while preserving
 * non-secret `SecretRef` pointers (e.g. `env:PAPERCLIP_ELUVIX_HMAC_SECRET`).
 */
export function sanitizePaperclipIntegrationForDisplay(
  config?: PaperclipIntegrationConfig
):
  | (PaperclipIntegrationConfig & {
      hmacSigningConfigured: boolean;
    })
  | undefined {
  if (!config) return undefined;
  const trimmed = typeof config.hmacSecret === 'string' ? config.hmacSecret.trim() : '';
  if (!trimmed) {
    return {
      ...config,
      hmacSigningConfigured: Boolean(
        process.env.PAPERCLIP_ELUVIX_HMAC_SECRET || process.env.ELUVIX_PAPERCLIP_HMAC_SECRET
      ),
    };
  }
  return {
    ...config,
    hmacSecret: maskSecretOrReferenceForDisplay(trimmed),
    hmacSigningConfigured: true,
  };
}

/**
 * Masks `hmacSecret` inside a scoped key's `paperclip` policy before returning
 * it over admin HTTP APIs.
 */
export function sanitizePaperclipKeyPolicyForDisplay(
  policy?: PaperclipKeyPolicy
): PaperclipKeyPolicy | undefined {
  if (!policy) return undefined;
  if (!policy.hmacSecret || !policy.hmacSecret.trim()) {
    return policy;
  }
  return {
    ...policy,
    hmacSecret: maskSecretOrReferenceForDisplay(policy.hmacSecret.trim()),
  };
}
