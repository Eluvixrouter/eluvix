import { NextResponse } from 'next/server';
import {
  captureDistillationPair,
  recordBanditArmOutcome,
  estimatePromptComplexity,
} from '@eluvix/router-core';
import { resolveCallerIdentity } from '@/lib/caller-identity';
import { getConfig } from '@/lib/router';

/**
 * Records a human A/B Split Arena preference vote:
 * 1. Updates Online Contextual Thompson Bandit (`bandit_arms`) posteriors (`winner` +alpha, `loser` +beta).
 * 2. Scrubs PII via `PrivacyGuard` and persists a gold-standard (`score = 1.0`) DPO preference pair
 *    scoped to `identity.userId`.
 */
export async function POST(req: Request) {
  try {
    const identity = await resolveCallerIdentity(req);
    if (!identity.ok) {
      return NextResponse.json(
        { error: { message: 'Unauthorized', type: 'authentication_error' } },
        { status: 401 }
      );
    }

    const body = await req.json().catch(() => null);
    if (!body || typeof body !== 'object') {
      return NextResponse.json(
        { error: { message: 'Invalid JSON request body', type: 'invalid_request_error' } },
        { status: 400 }
      );
    }

    const chosenText = typeof body.chosenText === 'string' ? body.chosenText.trim() : '';
    const rejectedText = typeof body.rejectedText === 'string' ? body.rejectedText.trim() : '';
    if (!chosenText || !rejectedText) {
      return NextResponse.json(
        {
          error: {
            message: 'Both chosenText and rejectedText must be non-empty strings.',
            type: 'invalid_request_error',
          },
        },
        { status: 400 }
      );
    }

    const promptMessages: Array<{ role: string; content: any }> = Array.isArray(body.messages)
      ? body.messages
      : typeof body.prompt === 'string' && body.prompt.trim().length > 0
      ? [{ role: 'user', content: body.prompt }]
      : [];

    if (promptMessages.length === 0) {
      return NextResponse.json(
        {
          error: {
            message: 'Either prompt or messages[] is required.',
            type: 'invalid_request_error',
          },
        },
        { status: 400 }
      );
    }

    const winnerUpstreamId = String(body.winnerUpstreamId || body.winnerModel || 'arena-winner');
    const loserUpstreamId = String(body.loserUpstreamId || body.loserModel || 'arena-loser');
    const winnerModel = String(body.winnerModel || winnerUpstreamId);
    const loserModel = String(body.loserModel || loserUpstreamId);

    const complexity = estimatePromptComplexity(promptMessages as any);
    const tier = typeof body.complexityTier === 'string' && body.complexityTier.trim()
      ? body.complexityTier.trim()
      : complexity.label;

    const winnerArm = recordBanditArmOutcome({
      upstreamId: winnerUpstreamId,
      complexityTier: tier,
      success: true,
      weight: 2.0,
    });
    const loserArm =
      loserUpstreamId !== winnerUpstreamId
        ? recordBanditArmOutcome({
            upstreamId: loserUpstreamId,
            complexityTier: tier,
            success: false,
            weight: 1.5,
          })
        : null;

    const cfg = getConfig();
    const pair = captureDistillationPair({
      userId: identity.userId,
      source: 'arena-vote',
      teacherUpstreamId: winnerUpstreamId,
      studentUpstreamId: loserUpstreamId,
      teacherModel: winnerModel,
      studentModel: loserModel,
      promptMessages,
      chosenText,
      rejectedText,
      privacyConfig: cfg.privacyGuard,
      judgeScoreOverride: 1.0,
    });

    return NextResponse.json({
      success: true,
      pairId: pair?.id ?? null,
      complexityTier: tier,
      winnerArm,
      loserArm,
    });
  } catch (err: any) {
    return NextResponse.json(
      { error: { message: err.message || 'Failed to record preference vote', type: 'api_error' } },
      { status: 500 }
    );
  }
}
