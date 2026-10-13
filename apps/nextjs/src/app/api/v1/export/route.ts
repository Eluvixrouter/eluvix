import { NextResponse } from 'next/server';
import { getDb } from '@eluvix/router-core';

export async function GET() {
  try {
    const db = getDb();
    
    // Group messages by session_id
    const messages = db.prepare('SELECT session_id, role, content FROM chat_history ORDER BY session_id, id ASC').all() as Array<{
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
