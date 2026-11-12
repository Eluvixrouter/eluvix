import { NextResponse } from 'next/server';
import { createBatchFile, listBatchFiles } from '@eluvix/router-core';
import { resolveCallerIdentity } from '@/lib/caller-identity';

export const dynamic = 'force-dynamic';

export async function GET(req: Request) {
  const caller = await resolveCallerIdentity(req, { requiredScope: 'batches' });
  if (!caller.ok) {
    return NextResponse.json(
      { error: { message: 'Unauthorized', type: 'authentication_error', code: caller.reason } },
      { status: caller.reason === 'insufficient-scope' ? 403 : 401 }
    );
  }
  const files = listBatchFiles(caller.userId);
  return NextResponse.json({ object: 'list', data: files });
}

export async function POST(req: Request) {
  const caller = await resolveCallerIdentity(req, { requiredScope: 'batches' });
  if (!caller.ok) {
    return NextResponse.json(
      { error: { message: 'Unauthorized', type: 'authentication_error', code: caller.reason } },
      { status: caller.reason === 'insufficient-scope' ? 403 : 401 }
    );
  }
  if (caller.role === 'readonly') {
    return NextResponse.json(
      { error: { message: 'Forbidden: read-only user.', type: 'insufficient_role' } },
      { status: 403 }
    );
  }

  const contentType = req.headers.get('content-type') || '';
  let filename = 'batch_input.jsonl';
  let purpose = 'batch';
  let contentJsonl = '';

  if (contentType.includes('multipart/form-data')) {
    const form = await req.formData();
    const fileField = form.get('file');
    const purposeField = form.get('purpose');
    if (typeof purposeField === 'string' && purposeField.trim()) {
      purpose = purposeField.trim();
    }
    if (fileField && typeof (fileField as any).text === 'function') {
      contentJsonl = await (fileField as Blob).text();
      if (typeof (fileField as any).name === 'string' && (fileField as any).name) {
        filename = (fileField as any).name;
      }
    }
  } else {
    const body = await req.json().catch(() => ({}));
    filename = typeof body?.filename === 'string' ? body.filename : filename;
    purpose = typeof body?.purpose === 'string' ? body.purpose : purpose;
    contentJsonl =
      typeof body?.content === 'string'
        ? body.content
        : typeof body?.content_jsonl === 'string'
        ? body.content_jsonl
        : '';
  }

  if (!contentJsonl.trim()) {
    return NextResponse.json(
      { error: { message: 'Batch file content must not be empty.', type: 'invalid_request_error' } },
      { status: 400 }
    );
  }

  const created = createBatchFile({
    filename,
    purpose,
    contentJsonl,
    userId: caller.userId,
  });

  return NextResponse.json(created, { status: 200 });
}
