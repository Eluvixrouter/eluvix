import { NextResponse } from 'next/server';
import { getDb } from '@eluvix/router-core';
import { resolveCallerIdentity } from '@/lib/caller-identity';

/**
 * Fine-tuning export is scoped to the authenticated caller's own
 * chat-history partition (audit L-2): one user's dataset never contains
 * another user's sessions, even when session_ids collide.
 */
export async function GET(req: Request) {
  try {
    const identity = await resolveCallerIdentity(req);
    if (!identity.ok) {
      return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 });
    }

    const db = getDb();

    // Group the caller's messages by session_id
    const messages = db.prepare('SELECT session_id, role, content FROM chat_history WHERE user_id = ? ORDER BY session_id, id ASC').all(identity.userId) as Array<{
      session_id: string;
      role: string;
      content: string;
    }>;

    const sessions = new Map<string, any[]>();
    for (const msg of messages) {
      if (!sessions.has(msg.session_id)) {
        sessions.set(msg.session_id, []);
      }
      sessions.get(msg.session_id)!.push({
        role: msg.role,
        content: msg.content
      });
    }

    // Convert to JSONL OpenAI Fine-Tuning Format
    let jsonl = '';
    for (const msgs of Array.from(sessions.values())) {
      // Exclude empty sessions
      if (msgs.length > 0) {
        jsonl += JSON.stringify({ messages: msgs }) + '\n';
      }
    }

    return new NextResponse(jsonl, {
      status: 200,
      headers: {
        'Content-Type': 'application/jsonl',
        'Content-Disposition': 'attachment; filename="eluvix_finetuning_dataset.jsonl"'
      }
    });

  } catch (err: any) {
    return NextResponse.json({ success: false, error: err.message }, { status: 500 });
  }
}
