import { NextResponse } from 'next/server';
import {
  listPromptVersions,
  registerPromptVersion,
  promotePromptAlias,
  resolvePromptTemplate,
} from '@eluvix/router-core';
import { resolveCallerIdentity } from '@/lib/caller-identity';

export const dynamic = 'force-dynamic';

export async function GET(req: Request) {
  const caller = await resolveCallerIdentity(req, { requiredScope: 'prompts' });
  if (!caller.ok) {
    return NextResponse.json(
      { error: { message: 'Unauthorized', type: 'authentication_error', code: caller.reason } },
      { status: caller.reason === 'insufficient-scope' ? 403 : 401 }
    );
  }

  const url = new URL(req.url);
  const resolveRef = url.searchParams.get('resolve');
  if (resolveRef) {
    const resolved = resolvePromptTemplate(resolveRef);
    if (!resolved) {
      return NextResponse.json(
        { error: { message: `Prompt "${resolveRef}" not found.`, type: 'not_found_error' } },
        { status: 404 }
      );
    }
    return NextResponse.json(resolved);
  }

  const promptId = url.searchParams.get('id') || undefined;
  return NextResponse.json({
    object: 'list',
    data: listPromptVersions(promptId),
  });
}

export async function POST(req: Request) {
  const caller = await resolveCallerIdentity(req, { requiredScope: 'prompts' });
  if (!caller.ok) {
    return NextResponse.json(
      { error: { message: 'Unauthorized', type: 'authentication_error', code: caller.reason } },
      { status: caller.reason === 'insufficient-scope' ? 403 : 401 }
    );
  }
  if (caller.role === 'readonly') {
    return NextResponse.json(
      { error: { message: 'Forbidden: read-only user.', type: 'insufficient_role' } },
      { status: 403 }
    );
  }

  const body = await req.json().catch(() => ({}));
  try {
    if (body?.action === 'promote') {
      const aliasRecord = promotePromptAlias({
        promptId: String(body.promptId || body.id || ''),
        alias: String(body.alias || 'production'),
        version: Number(body.version || 1),
        minEvalScore: typeof body.minEvalScore === 'number' ? body.minEvalScore : undefined,
        actorId: caller.userId,
      });
      return NextResponse.json(aliasRecord, { status: 200 });
    }

    const versionRecord = registerPromptVersion({
      id: String(body.id || ''),
      systemTemplate: String(body.systemTemplate || ''),
      description: body.description,
      variablesSchema: body.variablesSchema,
      modelHint: body.modelHint,
      evalScore: typeof body.evalScore === 'number' ? body.evalScore : undefined,
      userId: caller.userId,
    });
    return NextResponse.json(versionRecord, { status: 200 });
  } catch (err: any) {
    return NextResponse.json(
      { error: { message: err?.message || 'Prompt registry operation failed.', type: 'invalid_request_error' } },
      { status: 400 }
    );
  }
}
