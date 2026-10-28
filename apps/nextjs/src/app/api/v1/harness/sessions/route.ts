import { NextResponse } from 'next/server';
import {
  deleteHarnessSession,
  getChatHistory,
  getHarnessSession,
  listHarnessSessions,
  upsertHarnessSession,
} from '@eluvix/router-core';
import { resolveCallerIdentity } from '@/lib/caller-identity';

export const dynamic = 'force-dynamic';

export async function GET(req: Request) {
  try {
    const identity = await resolveCallerIdentity(req);
    const userId = identity.ok ? identity.userId : 'default';

    const { searchParams } = new URL(req.url);
    const sessionId = searchParams.get('session_id');
    const harnessKind = searchParams.get('kind') || undefined;
    const search = searchParams.get('q') || undefined;

    if (sessionId) {
      const session = getHarnessSession(sessionId, userId);
      const messages = getChatHistory(sessionId, userId);
      return NextResponse.json({
        success: true,
        data: {
          session,
          messages,
        },
      });
    }

    const sessions = listHarnessSessions(userId, {
      harnessKind,
      search,
    });
    return NextResponse.json({
      success: true,
      data: sessions,
    });
  } catch (err: any) {
    return NextResponse.json({ success: false, error: err.message }, { status: 500 });
  }
}

export async function POST(req: Request) {
  try {
    const identity = await resolveCallerIdentity(req);
    const userId = identity.ok ? identity.userId : 'default';
    const body = await req.json();
    if (!body?.sessionId) {
      return NextResponse.json({ success: false, error: 'Missing sessionId' }, { status: 400 });
    }
    const updated = upsertHarnessSession({
      sessionId: String(body.sessionId),
      userId,
      title: body.title,
      harnessKind: body.harnessKind,
      agentId: body.agentId,
      nodeId: body.nodeId,
      endpoint: body.endpoint,
    });
    return NextResponse.json({ success: true, data: updated });
  } catch (err: any) {
    return NextResponse.json({ success: false, error: err.message }, { status: 500 });
  }
}

export async function DELETE(req: Request) {
  try {
    const identity = await resolveCallerIdentity(req);
    const userId = identity.ok ? identity.userId : 'default';
    const { searchParams } = new URL(req.url);
    const sessionId = searchParams.get('session_id');
    if (!sessionId) {
      return NextResponse.json({ success: false, error: 'Missing session_id' }, { status: 400 });
    }
    const deleted = deleteHarnessSession(sessionId, userId);
    return NextResponse.json({ success: deleted });
  } catch (err: any) {
    return NextResponse.json({ success: false, error: err.message }, { status: 500 });
  }
}
