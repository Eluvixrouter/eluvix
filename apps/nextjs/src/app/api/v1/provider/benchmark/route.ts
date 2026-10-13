import { NextResponse } from 'next/server';
import { getProviderAgent } from '@/lib/router';

export const dynamic = 'force-dynamic';

export async function POST(req: Request) {
  try {
    const body = await req.json().catch(() => ({}));
    const agent = getProviderAgent();
    const model = body.model || 'llama3.1:8b';

    const testPrompt = [
      { role: 'user', content: 'Generate a short 2-sentence confirmation that this local GPU is functioning.' }
    ];

    const result = await agent.executeJob({
      jobId: `bench-${Date.now()}`,
      model,
      messages: testPrompt,
      maxTokens: 60,
      pricePerMTok: 0.50
    });

    const status = await agent.getStatus();

    return NextResponse.json({
      success: true,
      result,
      status
    });
  } catch (err: any) {
    return NextResponse.json({ success: false, error: err.message }, { status: 500 });
  }
}
