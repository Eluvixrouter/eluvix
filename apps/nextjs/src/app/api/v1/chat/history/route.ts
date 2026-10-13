import { NextResponse } from 'next/server';
import { getChatHistory, getChatSessions } from '@eluvix/router-core';

export const dynamic = 'force-dynamic';

export async function GET(req: Request) {
  try {
    const { searchParams } = new URL(req.url);
    const sessionId = searchParams.get('session_id');

    if (sessionId) {
      const history = getChatHistory(sessionId);
      return NextResponse.json({ success: true, data: history });
    }

    const sessions = getChatSessions();
    return NextResponse.json({ success: true, data: sessions });
  } catch (err: any) {
    return NextResponse.json({ success: false, error: err.message }, { status: 500 });
  }
}
