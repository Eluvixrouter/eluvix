import { NextResponse } from 'next/server';
import { resolveBearerToken, type RequestScope } from '@eluvix/router-core';
import { getRouter, getConfig } from '@/lib/router';

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
  const authHeader = req?.headers?.get('authorization');
  if (authHeader && authHeader.startsWith('Bearer ')) {
    const token = authHeader.slice(7).trim();
    if (token.startsWith('elx_')) {
      const resolved = resolveBearerToken(token);
      if (!resolved.valid) {
        return NextResponse.json(
          { error: 'Incorrect API key provided.' },
          { status: 401 }
        );
      }
      keyUserId = resolved.userId;
      keyOrigin = resolved.origin;
    }
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
    const scope: Partial<RequestScope> = {
      userId:
        keyUserId ||
        body.scope?.userId ||
        req?.headers?.get('x-eluvix-user') ||
        (typeof body.user === 'string' && body.user.trim() ? body.user.trim() : 'default'),
      sessionId: body.scope?.sessionId || req?.headers?.get('x-eluvix-session') || undefined,
      origin
    };
    const hops = Math.max(
      0,
      Number.isFinite(Number(body.hops))
        ? Number(body.hops)
        : parseInt(req?.headers?.get('x-eluvix-hops') || '0', 10) || 0
    );

    const router = getRouter();
    const routerConfig = getConfig();
    const defaultModel = routerConfig.modelGateway?.primaryModel || routerConfig.defaultModel || 'auto';

    const VALID_CONFIDENTIAL = new Set(['disabled', 'prefer-tee', 'require-tee', 'require-dual-attestation']);
    const VALID_QUANT = new Set(['disabled', 'prefer-nvfp4-hadamard', 'lossless-reasoning']);
    const VALID_FABRIC = new Set(['disabled', 'prefer-rail-optimized', 'require-collision-free-fabric']);

    const confidentialPolicyHeader = req?.headers?.get('x-eluvix-confidential');
    const quantizationPolicyHeader = req?.headers?.get('x-eluvix-quantization');
    const fabricPolicyHeader = req?.headers?.get('x-eluvix-fabric');

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

    if (confidentialPolicyHeader && VALID_CONFIDENTIAL.has(confidentialPolicyHeader)) {
      metadata.confidentialPolicy = confidentialPolicyHeader;
    }
    if (quantizationPolicyHeader && VALID_QUANT.has(quantizationPolicyHeader)) {
      metadata.quantizationPolicy = quantizationPolicyHeader;
    }
    if (fabricPolicyHeader && VALID_FABRIC.has(fabricPolicyHeader)) {
      metadata.fabricPolicy = fabricPolicyHeader;
    }

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
        hops,
        memoryTainted: Boolean(body.memoryTainted)
      }
    );
    return NextResponse.json(explanation);
  } catch (error) {
    const err = error as Error;
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}
