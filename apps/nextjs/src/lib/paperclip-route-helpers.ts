import { NextResponse } from 'next/server';
import {
  globalCircuitBreaker,
  getEffectiveCostPer1kTokens,
  isLocalUpstream,
  isPaperclipCompanyAllowed,
  type PaperclipFleetUpstreamSummary,
} from '@eluvix/router-core';
import { resolveCallerIdentity, type CallerIdentityResult } from '@/lib/caller-identity';
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
