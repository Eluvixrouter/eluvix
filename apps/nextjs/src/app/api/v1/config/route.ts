import { NextResponse } from 'next/server';
import { getConfig, saveConfig, ConfigValidationError } from '@/lib/router';
import { resolveCallerIdentity } from '@/lib/caller-identity';

export const dynamic = 'force-dynamic';

export async function GET(req: Request) {
  const identity = await resolveCallerIdentity(req);
  const isAdmin = identity.ok && identity.role === 'admin';
  const rawConfig = getConfig();
  if (isAdmin) {
    return NextResponse.json(rawConfig);
  }
  const sanitized = {
    ...rawConfig,
    upstreams: rawConfig.upstreams?.map(u => ({
      ...u,
      apiKey: u.apiKey ? '[REDACTED]' : undefined
    })),
    memory: rawConfig.memory ? {
      ...rawConfig.memory,
      apiKey: rawConfig.memory.apiKey ? '[REDACTED]' : undefined
    } : undefined
  };
  return NextResponse.json(sanitized);
}

export async function POST(req: Request) {
  const identity = await resolveCallerIdentity(req);
  if (identity.ok && identity.role === 'readonly') {
    return NextResponse.json({ error: 'Forbidden: read-only users cannot modify router configuration' }, { status: 403 });
  }

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
