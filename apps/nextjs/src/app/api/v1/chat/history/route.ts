import { NextResponse } from 'next/server';
import { getChatHistory, getChatSessions } from '@eluvix/router-core';
import { resolveCallerIdentity } from '@/lib/caller-identity';

export const dynamic = 'force-dynamic';

/**
 * Chat history is per-user data: sessions are namespaced by the
 * authenticated caller's identity, so two users who happen to share a
 * session_id never see each other's messages (audit L-2 / S-1).
 */
export async function GET(req: Request) {
  try {
    const identity = await resolveCallerIdentity(req);
    if (!identity.ok) {
      return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 });
    }
    const userId = identity.userId;

    const { searchParams } = new URL(req.url);
    const sessionId = searchParams.get('session_id');

    if (sessionId) {
      const history = getChatHistory(sessionId, userId);
      return NextResponse.json({ success: true, data: history });
    }

    const sessions = getChatSessions(userId);
    return NextResponse.json({ success: true, data: sessions });
  } catch (err: any) {
    return NextResponse.json({ success: false, error: err.message }, { status: 500 });
  }
}
