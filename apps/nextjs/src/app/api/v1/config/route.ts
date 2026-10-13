import { NextResponse } from 'next/server';
import { getConfig, saveConfig, ConfigValidationError } from '@/lib/router';

export const dynamic = 'force-dynamic';

export async function GET() {
  return NextResponse.json(getConfig());
}

export async function POST(req: Request) {
  let body: any;
  try {
    body = await req.json();
  } catch (err: any) {
    return NextResponse.json({ error: `Malformed JSON: ${err.message}` }, { status: 400 });
  }

  try {
    const updated = saveConfig(body);
    return NextResponse.json({ success: true, config: updated });
  } catch (error) {
    const err = error as Error;
    const isValidationError = err instanceof ConfigValidationError || err.message.startsWith('Invalid');
    return NextResponse.json({ error: err.message }, { status: isValidationError ? 400 : 500 });
  }
}
