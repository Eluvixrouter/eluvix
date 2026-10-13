import { NextResponse } from 'next/server';

export const dynamic = 'force-dynamic';

export async function GET() {
  return NextResponse.json({
    secrets: [
      { key: 'OPENAI_API_KEY', path: 'secrets/openai' },
      { key: 'BILLAMA_API_KEY', path: 'secrets/billama' }
    ]
  });
}
