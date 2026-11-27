import { NextResponse } from 'next/server';
import {
  Eluvix,
  isPaperclipCompanyAllowed,
  mergeEffectiveHops,
  parseVerifiedPaperclipRequestAsync,
  resolveBearerToken,
  type PaperclipKeyPolicy,
  type RequestScope,
  type RouterConfig
} from '@eluvix/router-core';
import { getRouter, getConfig } from '@/lib/router';
import { resolveCallerIdentity, extractApiTokenFromHeaders } from '@/lib/caller-identity';

export const dynamic = 'force-dynamic';

/**
 * POST /api/v1/route-explain
 *
 * Decision tracing for the live router: explains how a chat request
 * WOULD be routed (selection stages, ranked failover order, chosen
 * upstream) without contacting any upstream. Body mirrors a chat
 * completion request: { model?, messages, tools?, scope?, hops?, memoryTainted? }.
 */
export async function POST(req: Request) {
  let keyUserId: string | undefined;
  let keyOrigin: RequestScope['origin'] | undefined;
  let keyHasPaperclipScope = false;
  let keyPaperclipPolicy: PaperclipKeyPolicy | undefined;
  const token = req?.headers ? extractApiTokenFromHeaders(req) : null;
  if (token && token.startsWith('elx_')) {
    const resolved = resolveBearerToken(token);
    if (!resolved.valid) {
      return NextResponse.json(
        { error: 'Incorrect API key provided.' },
        { status: 401 }
      );
    }
    keyUserId = resolved.userId;
    keyOrigin = resolved.origin;
    keyHasPaperclipScope =
      !Array.isArray(resolved.scopes) ||
      resolved.scopes.length === 0 ||
      resolved.scopes.includes('paperclip');
    keyPaperclipPolicy = resolved.paperclip;
  }

  let body: any;
  try {
    body = await req.json();
  } catch (err: any) {
    return NextResponse.json({ error: `Malformed JSON: ${err.message}` }, { status: 400 });
  }

  if (!body || !Array.isArray(body.messages) || body.messages.length === 0) {
    return NextResponse.json(
      { error: 'A non-empty "messages" array is required to explain a route.' },
      { status: 400 }
    );
  }

  try {
    const headerOrigin = req?.headers?.get('x-eluvix-origin');
    const origin: RequestScope['origin'] =
      keyOrigin ||
      body.scope?.origin ||
      body.origin ||
      (headerOrigin === 'harness' || headerOrigin === 'playground' ? headerOrigin : 'client');
    const identity = await resolveCallerIdentity(req);
    const resolvedUserId = keyUserId || (identity.ok ? identity.userId : undefined);
    const isAdmin = identity.ok && identity.role === 'admin';
    const effectiveUserId =
      isAdmin && body.scope?.userId
        ? body.scope.userId
        : resolvedUserId || 'default';

    const scope: Partial<RequestScope> = {
      userId: effectiveUserId,
      sessionId: body.scope?.sessionId || req?.headers?.get('x-eluvix-session') || undefined,
      origin
    };
    const hops = Math.max(
      0,
      Number.isFinite(Number(body.hops))
        ? Number(body.hops)
        : parseInt(req?.headers?.get('x-eluvix-hops') || '0', 10) || 0
    );

    // Optional ephemeral preview config from the Eluvix Visual Node Routing Editor simulator
    // (evaluated strictly in-memory via explainRoute() with zero disk writes or upstream network I/O)
    const canOverrideConfig =
      identity.ok && (identity.role === 'admin' || identity.role === 'operator');
    const previewConfig: RouterConfig | null =
      canOverrideConfig &&
      body.configOverride &&
      typeof body.configOverride === 'object' &&
      Array.isArray(body.configOverride.upstreams)
        ? (body.configOverride as RouterConfig)
        : null;

    const router = previewConfig ? new Eluvix(previewConfig) : getRouter();
    const routerConfig = previewConfig || getConfig();
    const defaultModel = routerConfig.modelGateway?.primaryModel || routerConfig.defaultModel || 'auto';

    const VALID_CONFIDENTIAL = new Set(['disabled', 'prefer-tee', 'require-tee', 'require-dual-attestation']);
    const VALID_QUANT = new Set(['disabled', 'prefer-nvfp4-hadamard', 'lossless-reasoning']);
    const VALID_FABRIC = new Set(['disabled', 'prefer-rail-optimized', 'require-collision-free-fabric']);
    const VALID_CRS = new Set(['disabled', 'slice-and-verify', 'strict-zero-false-positive']);
    const VALID_ATTENTION = new Set([
      'disabled',
      'prefer-fa3-warp-specialized',
      'prefer-blackwell-tmem',
      'require-fp8-ping-pong'
    ]);

    const confidentialPolicyHeader = req?.headers?.get('x-eluvix-confidential');
    const quantizationPolicyHeader = req?.headers?.get('x-eluvix-quantization');
    const fabricPolicyHeader = req?.headers?.get('x-eluvix-fabric');
    const crsPolicyHeader = req?.headers?.get('x-eluvix-crs');
    const attentionPolicyHeader = req?.headers?.get('x-eluvix-attention');

    const metadata: Record<string, any> = { ...(body.metadata || {}) };
    if (metadata.confidentialPolicy && !VALID_CONFIDENTIAL.has(String(metadata.confidentialPolicy))) {
      delete metadata.confidentialPolicy;
    }
    if (metadata.quantizationPolicy && !VALID_QUANT.has(String(metadata.quantizationPolicy))) {
      delete metadata.quantizationPolicy;
    }
    if (metadata.fabricPolicy && !VALID_FABRIC.has(String(metadata.fabricPolicy))) {
      delete metadata.fabricPolicy;
    }
    if (metadata.crsPolicy && !VALID_CRS.has(String(metadata.crsPolicy))) {
      delete metadata.crsPolicy;
    }
    if (metadata.attentionPolicy && !VALID_ATTENTION.has(String(metadata.attentionPolicy))) {
      delete metadata.attentionPolicy;
    }

    if (confidentialPolicyHeader && VALID_CONFIDENTIAL.has(confidentialPolicyHeader)) {
      metadata.confidentialPolicy = confidentialPolicyHeader;
    }
    if (quantizationPolicyHeader && VALID_QUANT.has(quantizationPolicyHeader)) {
      metadata.quantizationPolicy = quantizationPolicyHeader;
    }
    if (fabricPolicyHeader && VALID_FABRIC.has(fabricPolicyHeader)) {
      metadata.fabricPolicy = fabricPolicyHeader;
    }
    if (crsPolicyHeader && VALID_CRS.has(crsPolicyHeader)) {
      metadata.crsPolicy = crsPolicyHeader;
    }
    if (attentionPolicyHeader && VALID_ATTENTION.has(attentionPolicyHeader)) {
      metadata.attentionPolicy = attentionPolicyHeader;
    }

    const pcCfg = routerConfig?.integrations?.paperclip;
    const isAdminOrSessionCaller = !token || !token.startsWith('elx_');
    const paperclip = await parseVerifiedPaperclipRequestAsync(req?.headers, {
      config: pcCfg,
      keyPolicy: keyPaperclipPolicy,
      hasPaperclipScope: keyHasPaperclipScope,
      isAdminOrSessionCaller,
      // Hunt-3 M-A2: App Router route handlers cannot observe the peer
      // socket address, and x-forwarded-for is client-controlled, so no
      // loopback determination is possible here — never claim loopback.
      // Loopback trust in Next.js requires a scoped key or HMAC instead.
      isLoopbackCaller: false,
      bodyPaperclip: body.paperclip,
    });
    const rawCompanyHdr = req?.headers?.get('x-paperclip-company-id')?.trim();
    const candidateCompany =
      rawCompanyHdr ||
      paperclip.companyId ||
      (typeof body?.paperclip?.companyId === 'string'
        ? body.paperclip.companyId.trim()
        : undefined);
    if (
      keyPaperclipPolicy?.companyIds &&
      keyPaperclipPolicy.companyIds.length > 0 &&
      !isPaperclipCompanyAllowed(candidateCompany, keyPaperclipPolicy)
    ) {
      return NextResponse.json(
        {
          error: candidateCompany
            ? `API key is not authorized for Paperclip company "${candidateCompany}".`
            : 'API key requires an authorized "companyId" or "x-paperclip-company-id".',
        },
        { status: 403 }
      );
    }
    const effectiveHops = mergeEffectiveHops(hops, paperclip);

    const explanation = router.explainRoute(
      {
        model: body.model || defaultModel,
        messages: body.messages,
        tools: body.tools,
        metadata,
        stream: false
      },
      {
        scope,
        hops: effectiveHops,
        memoryTainted: Boolean(body.memoryTainted),
        paperclip,
      }
    );
    return NextResponse.json(explanation);
  } catch (error) {
    const err = error as Error;
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}
