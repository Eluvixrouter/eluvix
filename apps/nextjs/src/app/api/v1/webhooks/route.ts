import { NextResponse } from 'next/server';
import {
  listAlertWebhooks,
  registerAlertWebhook,
  deleteAlertWebhook,
  dispatchAlertWebhooks,
} from '@eluvix/router-core';
import { resolveCallerIdentity } from '@/lib/caller-identity';

export const dynamic = 'force-dynamic';

export async function GET(req: Request) {
  const caller = await resolveCallerIdentity(req, { requiredScope: 'webhooks' });
  if (!caller.ok) {
    return NextResponse.json(
      { error: { message: 'Unauthorized', type: 'authentication_error', code: caller.reason } },
      { status: caller.reason === 'insufficient-scope' ? 403 : 401 }
    );
  }
  return NextResponse.json({
    object: 'list',
    data: listAlertWebhooks(caller.userId),
  });
}

export async function POST(req: Request) {
  const caller = await resolveCallerIdentity(req, { requiredScope: 'webhooks' });
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
    if (body?.action === 'test') {
      const result = await dispatchAlertWebhooks({
        event: body.event || 'budget.threshold',
        severity: body.severity || 'info',
        summary: body.summary || 'Eluvix test alert webhook delivery',
        data: body.data || {},
        userId: caller.userId,
      });
      return NextResponse.json(result);
    }

    const created = registerAlertWebhook({
      name: String(body.name || 'Alert Webhook'),
      url: String(body.url || ''),
      provider: body.provider,
      secret: body.secret,
      events: body.events,
      enabled: body.enabled,
      userId: caller.userId,
    });
    return NextResponse.json(created, { status: 200 });
  } catch (err: any) {
    return NextResponse.json(
      { error: { message: err?.message || 'Failed to register webhook.', type: 'invalid_request_error' } },
      { status: 400 }
    );
  }
}

export async function DELETE(req: Request) {
  const caller = await resolveCallerIdentity(req, { requiredScope: 'webhooks' });
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
  const url = new URL(req.url);
  const id = url.searchParams.get('id') || '';
  if (!id) {
    return NextResponse.json(
      { error: { message: 'Missing query parameter "id".', type: 'invalid_request_error' } },
      { status: 400 }
    );
  }
  const deleted = deleteAlertWebhook(id, caller.userId);
  return NextResponse.json({ id, deleted });
}
