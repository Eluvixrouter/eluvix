import { NextResponse } from 'next/server';
import { getStoredResponse, deleteStoredResponse } from '@eluvix/router-core';
import { resolveCallerIdentity } from '@/lib/caller-identity';

export const dynamic = 'force-dynamic';

/**
 * GET /api/v1/responses/[id]
 * Retrieve a previously stored OpenAI Responses object scoped strictly to the caller's userId.
 */
export async function GET(
  req: Request,
  context: { params: Promise<{ id: string }> }
) {
  const identity = await resolveCallerIdentity(req);
  if (!identity.ok) {
    return NextResponse.json(
      {
        error: {
          message: 'Incorrect or missing API key.',
          type: 'invalid_request_error',
          code: 'invalid_api_key',
        },
      },
      { status: 401 }
    );
  }

  const { id: responseId } = await context.params;
  if (!responseId) {
    return NextResponse.json(
      { error: { message: 'Response ID is required.', type: 'invalid_request_error' } },
      { status: 400 }
    );
  }

  const stored = getStoredResponse(responseId, identity.userId);
  if (!stored) {
    return NextResponse.json(
      {
        error: {
          message: `Response '${responseId}' not found.`,
          type: 'invalid_request_error',
          code: 'response_not_found',
        },
      },
      { status: 404 }
    );
  }

  return NextResponse.json(stored.response);
}

/**
 * DELETE /api/v1/responses/[id]
 * Delete a stored OpenAI Responses object scoped strictly to the caller's userId.
 */
export async function DELETE(
  req: Request,
  context: { params: Promise<{ id: string }> }
) {
  const identity = await resolveCallerIdentity(req);
  if (!identity.ok) {
    return NextResponse.json(
      {
        error: {
          message: 'Incorrect or missing API key.',
          type: 'invalid_request_error',
          code: 'invalid_api_key',
        },
      },
      { status: 401 }
    );
  }

  if (identity.role === 'readonly') {
    return NextResponse.json(
      {
        error: {
          message: 'Forbidden: read-only users cannot delete stored responses.',
          type: 'insufficient_role',
          code: 'forbidden_readonly_user',
        },
      },
      { status: 403 }
    );
  }

  const { id: responseId } = await context.params;
  if (!responseId) {
    return NextResponse.json(
      { error: { message: 'Response ID is required.', type: 'invalid_request_error' } },
      { status: 400 }
    );
  }

  const deleted = deleteStoredResponse(responseId, identity.userId);
  if (!deleted) {
    return NextResponse.json(
      {
        error: {
          message: `Response '${responseId}' not found.`,
          type: 'invalid_request_error',
          code: 'response_not_found',
        },
      },
      { status: 404 }
    );
  }

  return NextResponse.json({
    id: responseId,
    object: 'response.deleted',
    deleted: true,
  });
}
