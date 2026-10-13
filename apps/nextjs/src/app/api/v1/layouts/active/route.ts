import { NextResponse } from 'next/server';
import { readLayout, sanitizeSlug, setLastActiveLayoutSlug, getLastActiveLayoutSlug, LayoutError } from '@/lib/layouts';

export const dynamic = 'force-dynamic';

export async function GET() {
  return NextResponse.json({ activeSlug: getLastActiveLayoutSlug() });
}

export async function PUT(req: Request) {
  try {
    const body = await req.json().catch(() => ({}));
    const slug = sanitizeSlug(body.slug);
    if (!readLayout(slug)) {
      return NextResponse.json({ error: `Layout "${slug}" not found` }, { status: 404 });
    }
    setLastActiveLayoutSlug(slug);
    return NextResponse.json({ success: true, activeSlug: slug });
  } catch (err: any) {
    if (err instanceof LayoutError) {
      return NextResponse.json({ error: err.message, code: err.code }, { status: err.statusCode });
    }
    return NextResponse.json({ error: err.message || 'Failed to set active layout' }, { status: 500 });
  }
}
