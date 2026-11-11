import { NextResponse } from 'next/server';
import {
  getDb,
  listDistillationPairs,
  formatDistillationAsSftJsonl,
  formatDistillationAsDpoJsonl,
} from '@eluvix/router-core';
import { resolveCallerIdentity } from '@/lib/caller-identity';

/**
 * Fine-tuning & Distillation export is strictly scoped to the authenticated caller's
 * own partition (`identity.userId`):
 * - `?format=chat` (default): exports session chat history in OpenAI Fine-Tuning JSONL.
 * - `?format=sft&minScore=0.75`: exports `PrivacyGuard`-scrubbed SFT distillation pairs.
 * - `?format=dpo&minScore=0.8`: exports TRL / Unsloth / Axolotl DPO preference JSONL (`{ prompt, chosen, rejected }`).
 */
export async function GET(req: Request) {
  try {
    const identity = await resolveCallerIdentity(req);
    if (!identity.ok) {
      return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 });
    }

    const url = new URL(req.url);
    const format = (url.searchParams.get('format') || 'chat').toLowerCase();
    const minScoreRaw = url.searchParams.get('minScore');
    const minScore =
      minScoreRaw !== null && Number.isFinite(parseFloat(minScoreRaw))
        ? Math.max(0, Math.min(1, parseFloat(minScoreRaw)))
        : format === 'dpo'
        ? 0.75
        : 0.6;
    const limitRaw = url.searchParams.get('limit');
    const limit =
      limitRaw !== null && Number.isFinite(parseInt(limitRaw, 10))
        ? Math.max(1, Math.min(5000, parseInt(limitRaw, 10)))
        : 1000;

    if (format === 'sft') {
      const pairs = listDistillationPairs(identity.userId, { minScore, limit });
      const rawJsonl = formatDistillationAsSftJsonl(pairs);
      const jsonl = rawJsonl ? `${rawJsonl}\n` : '';
      return new NextResponse(jsonl, {
        status: 200,
        headers: {
          'Content-Type': 'application/jsonl',
          'Content-Disposition': 'attachment; filename="eluvix_sft_dataset.jsonl"',
          'x-eluvix-export-format': 'sft',
          'x-eluvix-export-count': String(pairs.length),
        },
      });
    }

    if (format === 'dpo') {
      const pairs = listDistillationPairs(identity.userId, { minScore, limit });
      const rawJsonl = formatDistillationAsDpoJsonl(pairs);
      const jsonl = rawJsonl ? `${rawJsonl}\n` : '';
      const lineCount = rawJsonl ? rawJsonl.split('\n').filter(Boolean).length : 0;
      return new NextResponse(jsonl, {
        status: 200,
        headers: {
          'Content-Type': 'application/jsonl',
          'Content-Disposition': 'attachment; filename="eluvix_dpo_preferences.jsonl"',
          'x-eluvix-export-format': 'dpo',
          'x-eluvix-export-count': String(lineCount),
        },
      });
    }

    if (format !== 'chat') {
      return NextResponse.json(
        {
          success: false,
          error: `Unsupported export format "${format}". Expected "chat", "sft", or "dpo".`,
        },
        { status: 400 }
      );
    }

    const db = getDb();

    // Group the caller's messages by session_id
    const messages = db
      .prepare(
        'SELECT session_id, role, content FROM chat_history WHERE user_id = ? ORDER BY session_id, id ASC'
      )
      .all(identity.userId) as Array<{
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
        content: msg.content,
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
        'Content-Disposition': 'attachment; filename="eluvix_finetuning_dataset.jsonl"',
      },
    });
  } catch (err: any) {
    return NextResponse.json({ success: false, error: err.message }, { status: 500 });
  }
}
