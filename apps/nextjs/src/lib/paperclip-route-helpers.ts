import { NextResponse } from 'next/server';
import {
  dispatchAlertWebhooks,
  globalCircuitBreaker,
  getEffectiveCostPer1kTokens,
  isLocalUpstream,
  isPaperclipCompanyAllowed,
  mergeEffectiveHops,
  parseVerifiedPaperclipRequestAsync,
  resolveBearerToken,
  type PaperclipFleetUpstreamSummary,
  type PaperclipIntegrationConfig,
  type PaperclipKeyPolicy,
  type PaperclipRequestContext,
  type RequestScope,
} from '@eluvix/router-core';
import {
  resolveCallerIdentity,
  extractApiTokenFromHeaders,
  type CallerIdentityResult,
} from '@/lib/caller-identity';
import { getRouter } from '@/lib/router';

export async function requirePaperclipCaller(
  req: Request
): Promise<
  | { ok: true; identity: Extract<CallerIdentityResult, { ok: true }> }
  | { ok: false; response: NextResponse }
> {
  const identity = await resolveCallerIdentity(req, { requiredScope: 'paperclip' });
  if (!identity.ok) {
    const status =
      identity.reason === 'insufficient-scope'
        ? 403
        : identity.reason === 'rate-limited' || identity.reason === 'budget-exceeded'
          ? 429
          : 401;
    return {
      ok: false,
      response: NextResponse.json(
        {
          error: {
            message:
              identity.reason === 'insufficient-scope'
                ? 'API key lacks required "paperclip" scope.'
                : `Authentication failed (${identity.reason}).`,
            type: 'invalid_request_error',
            code: identity.reason,
          },
        },
        { status }
      ),
    };
  }
  return { ok: true, identity };
}

export function assertPaperclipCompanyScope(
  identity: Extract<CallerIdentityResult, { ok: true }>,
  companyId?: string
): NextResponse | null {
  const allowedCompanies = identity.paperclip?.companyIds;
  if (!allowedCompanies || allowedCompanies.length === 0) {
    return null;
  }
  if (!isPaperclipCompanyAllowed(companyId, identity.paperclip)) {
    return NextResponse.json(
      {
        error: {
          message: companyId
            ? `API key is not authorized for Paperclip company "${companyId}".`
            : 'API key requires an authorized "companyId" within its companyIds allowlist.',
          type: 'invalid_request_error',
          code: 'company_scope_forbidden',
        },
      },
      { status: 403 }
    );
  }
  return null;
}

export type NamedChatKeyResolution =
  | {
      ok: true;
      isApiKey: boolean;
      rawToken: string | null;
      userId?: string;
      origin?: RequestScope['origin'];
      hasPaperclipScope: boolean;
      paperclipPolicy?: PaperclipKeyPolicy;
    }
  | {
      ok: false;
      status: number;
      code: string;
      message: string;
    };

export function resolveNamedChatApiKey(req: Request): NamedChatKeyResolution {
  const rawToken = extractApiTokenFromHeaders(req);
  if (!rawToken || !rawToken.startsWith('elx_')) {
    return {
      ok: true,
      isApiKey: false,
      rawToken,
      hasPaperclipScope: false,
    };
  }
  const resolved = resolveBearerToken(rawToken, undefined, 'eluvix', { requiredScope: 'chat' });
  if (!resolved.valid) {
    const status =
      resolved.reason === 'insufficient-scope'
        ? 403
        : resolved.reason === 'rate-limited' || resolved.reason === 'budget-exceeded'
          ? 429
          : 401;
    const message =
      resolved.reason === 'insufficient-scope'
        ? 'API key lacks required "chat" scope.'
        : resolved.reason === 'expired'
          ? 'API key has expired.'
          : resolved.reason === 'rate-limited'
            ? 'API key rate limit (RPM) exceeded.'
            : resolved.reason === 'budget-exceeded'
              ? 'API key daily spend budget exceeded.'
              : 'Incorrect API key provided.';
    return {
      ok: false,
      status,
      code: resolved.reason || 'invalid_api_key',
      message,
    };
  }
  if (resolved.role === 'readonly') {
    return {
      ok: false,
      status: 403,
      code: 'forbidden_readonly_user',
      message: 'Forbidden: read-only users cannot execute inference requests.',
    };
  }
  return {
    ok: true,
    isApiKey: true,
    rawToken,
    userId: resolved.userId,
    origin: resolved.origin,
    hasPaperclipScope:
      !resolved.scopes ||
      resolved.scopes.includes('*') ||
      resolved.scopes.includes('paperclip'),
    paperclipPolicy: resolved.paperclip,
  };
}

export async function resolvePaperclipInferenceContext(opts: {
  headers: Headers;
  rawToken: string | null;
  hops: number;
  config?: PaperclipIntegrationConfig;
  keyPaperclipPolicy?: PaperclipKeyPolicy;
  hasPaperclipScope: boolean;
  bodyPaperclip?: unknown;
}): Promise<
  | { ok: true; paperclip: PaperclipRequestContext; effectiveHops: number }
  | { ok: false; status: 403; code: 'company_scope_forbidden'; message: string }
> {
  const isAdminOrSessionCaller = !opts.rawToken || !opts.rawToken.startsWith('elx_');
  const paperclip = await parseVerifiedPaperclipRequestAsync(opts.headers, {
    config: opts.config,
    keyPolicy: opts.keyPaperclipPolicy,
    hasPaperclipScope: opts.hasPaperclipScope,
    isAdminOrSessionCaller,
    bodyPaperclip: opts.bodyPaperclip,
  });

  if (paperclip.signatureStatus === 'invalid' || paperclip.signatureStatus === 'expired') {
    void dispatchAlertWebhooks({
      event: 'paperclip.hmac_rejected',
      severity: 'critical',
      summary: `Rejected Paperclip context signature (${paperclip.signatureStatus}) for company ${paperclip.companyId || 'unknown'}`,
      data: {
        signatureStatus: paperclip.signatureStatus,
        runId: paperclip.runId,
        issueId: paperclip.issueId,
        agentId: paperclip.agentId,
        companyId: paperclip.companyId,
      },
    }).catch(() => {});
  }

  const rawCompanyHdr = opts.headers.get('x-paperclip-company-id')?.trim();
  const bodyCompanyId =
    opts.bodyPaperclip && typeof (opts.bodyPaperclip as any).companyId === 'string'
      ? String((opts.bodyPaperclip as any).companyId).trim()
      : undefined;
  const candidateCompanyId = rawCompanyHdr || paperclip.companyId || bodyCompanyId;

  if (
    opts.keyPaperclipPolicy?.companyIds &&
    opts.keyPaperclipPolicy.companyIds.length > 0 &&
    !isPaperclipCompanyAllowed(candidateCompanyId, opts.keyPaperclipPolicy)
  ) {
    return {
      ok: false,
      status: 403,
      code: 'company_scope_forbidden',
      message: candidateCompanyId
        ? `API key is not authorized for Paperclip company "${candidateCompanyId}".`
        : 'API key requires an authorized "x-paperclip-company-id" header.',
    };
  }

  return {
    ok: true,
    paperclip,
    effectiveHops: mergeEffectiveHops(opts.hops, paperclip),
  };
}

export function buildPaperclipFleetSummary(): PaperclipFleetUpstreamSummary[] {
  const router = getRouter();
  return router.getUpstreams().map((u) => {
    const healthy = globalCircuitBreaker.getState(u.id) !== 'open';
    const local = isLocalUpstream(u);
    const modalities = ['text'];
    if (u.capabilities?.includes('vision') || u.type === 'anthropic' || u.type === 'antigravity') {
      modalities.push('vision');
    }
    if (u.type === 'comfyui') {
      modalities.push('image-gen');
    }
    return {
      id: u.id,
      name: u.name,
      type: u.type,
      isLocal: local,
      healthy,
      models: u.models || [],
      costPer1kTokens: getEffectiveCostPer1kTokens(u),
      estimatedLatencyMs: u.latencyMs ?? (local ? 750 : 1400),
      modalities,
    };
  });
}
