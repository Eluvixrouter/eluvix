import { NextResponse } from 'next/server';
import {
  runEvalSuite,
  STARTER_GOLDEN_EVAL_SUITES,
  validateUpstreamHttpEndpoint,
  type EvalRunMode,
  type EvalSuite,
  type RouterConfig,
} from '@eluvix/router-core';
import { getConfig } from '@/lib/router';
import { resolveCallerIdentity } from '@/lib/caller-identity';

export const dynamic = 'force-dynamic';

/**
 * Golden Eval Suite Runner (`POST /api/v1/evals/run`).
 * Supports `$0.00` deterministic `dry-run` assertions (via `explainRoute()` + `PromptGuard` + `PrivacyGuard`)
 * and `live` model completion assertions against either the saved `RouterConfig` or an unsaved
 * `configOverride` compiled from the Eluvix Visual Node Routing Editor canvas.
 */
export async function POST(req: Request) {
  const caller = await resolveCallerIdentity(req);
  if (!caller.ok) {
    return NextResponse.json(
      {
        error: {
          message: 'Incorrect or missing API key provided.',
          type: 'authentication_error',
          code: 'invalid_api_key',
        },
      },
      { status: 401 }
    );
  }

  let body: any;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json(
      { error: { message: 'Invalid JSON request body.', type: 'invalid_request_error' } },
      { status: 400 }
    );
  }

  const mode: EvalRunMode = body?.mode === 'live' ? 'live' : 'dry-run';

  // Read-only auditors may execute $0.00 deterministic dry-runs, never live network completions
  if (mode === 'live' && caller.role === 'readonly') {
    return NextResponse.json(
      {
        error: {
          message: 'Forbidden: read-only users may only execute mode="dry-run" Golden Evals.',
          type: 'insufficient_role',
          code: 'forbidden_readonly_user',
        },
      },
      { status: 403 }
    );
  }

  let suite: EvalSuite | undefined;
  if (body?.suite && typeof body.suite === 'object' && Array.isArray(body.suite.cases)) {
    suite = body.suite as EvalSuite;
  } else if (typeof body?.suiteId === 'string') {
    suite = STARTER_GOLDEN_EVAL_SUITES.find((s) => s.id === body.suiteId);
  } else {
    suite = STARTER_GOLDEN_EVAL_SUITES[0];
  }

  if (!suite || !Array.isArray(suite.cases) || suite.cases.length === 0) {
    return NextResponse.json(
      {
        error: {
          message: 'A valid Golden Eval "suite" (with non-empty cases[]) or "suiteId" is required.',
          type: 'invalid_request_error',
        },
      },
      { status: 400 }
    );
  }

  if (suite.cases.length > 50) {
    return NextResponse.json(
      {
        error: {
          message: 'Golden Eval suite exceeds maximum of 50 cases per API run.',
          type: 'invalid_request_error',
        },
      },
      { status: 400 }
    );
  }

  let effectiveConfig: RouterConfig = getConfig();
  if (body?.configOverride && typeof body.configOverride === 'object') {
    // Only admin/operator may supply custom configOverride, and every HTTP endpoint is SSRF-validated
    const override = body.configOverride as RouterConfig;
    if (!Array.isArray(override.upstreams)) {
      return NextResponse.json(
        {
          error: {
            message: 'configOverride.upstreams must be an array.',
            type: 'invalid_request_error',
          },
        },
        { status: 400 }
      );
    }

    for (const u of override.upstreams) {
      if (u?.endpoint && /^https?:\/\//i.test(u.endpoint)) {
        const check = validateUpstreamHttpEndpoint(u.endpoint, { allowLoopbackAndLan: true });
        if (!check.ok) {
          return NextResponse.json(
            {
              error: {
                message: `Unsafe upstream endpoint in configOverride ("${u.id}"): ${check.reason}`,
                type: 'ssrf_blocked',
              },
            },
            { status: 400 }
          );
        }
      }
    }
    effectiveConfig = override;
  }

  const report = await runEvalSuite(suite, effectiveConfig, {
    mode,
    scope: { userId: caller.userId, origin: 'playground' },
    signal: req.signal,
  });

  return NextResponse.json(report, {
    status: 200,
    headers: {
      'x-eluvix-eval-passed': String(report.passed),
      'x-eluvix-eval-mode': report.mode,
    },
  });
}
