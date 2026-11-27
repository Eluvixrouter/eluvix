import { NextResponse } from 'next/server';
import {
  listLayouts,
  writeLayout,
  getLastActiveLayoutSlug,
  setLastActiveLayoutSlug,
  LayoutError,
  sanitizeSlug
} from '@/lib/layouts';
import { resolveCallerIdentity } from '@/lib/caller-identity';

export const dynamic = 'force-dynamic';

/**
 * Hunt-3 C-L6: layouts routes had no in-handler identity check (they
 * relied on middleware, which passes operator sessions through) and GET
 * leaked the absolute layouts dir. Any authenticated caller may read;
 * only non-readonly callers may create/overwrite shared global layouts.
 */
async function requireLayoutCaller(req: Request, mutate: boolean): Promise<NextResponse | null> {
  const caller = await resolveCallerIdentity(req);
  if (!caller.ok) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  if (mutate && caller.role === 'readonly') {
    return NextResponse.json(
      { error: 'Forbidden: read-only users cannot modify layouts' },
      { status: 403 }
    );
  }
  return null;
}

export async function GET(req: Request) {
  const denied = await requireLayoutCaller(req, false);
  if (denied) return denied;
  try {
    const layouts = listLayouts();
    const activeSlug = getLastActiveLayoutSlug();
    return NextResponse.json({ layouts, activeSlug });
  } catch (err: any) {
    console.error('[API /api/v1/layouts GET] Error:', err);
    return NextResponse.json(
      { error: err.message || 'Failed to list layouts' },
      { status: 500 }
    );
  }
}

export async function POST(req: Request) {
  const denied = await requireLayoutCaller(req, true);
  if (denied) return denied;
  let body: any;
  try {
    body = await req.json();
  } catch (err: any) {
    return NextResponse.json({ error: `Malformed JSON: ${err.message}` }, { status: 400 });
  }

  try {
    let slug = body.slug;
    if (!slug && body.name) {
      slug = body.name
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '');
    }

    if (!slug) {
      return NextResponse.json(
        { error: 'Slug or name is required to save a layout' },
        { status: 400 }
      );
    }

    const sanitizedSlug = sanitizeSlug(slug);

    if (!Array.isArray(body.nodes) || !Array.isArray(body.edges)) {
      return NextResponse.json(
        { error: '"nodes" and "edges" arrays are required' },
        { status: 400 }
      );
    }

    const saved = writeLayout(
      sanitizedSlug,
      {
        name: body.name || sanitizedSlug,
        description: body.description || '',
        category: body.category || 'custom',
        tags: Array.isArray(body.tags) ? body.tags : [],
        isExample: !!body.isExample,
        nodes: body.nodes,
        edges: body.edges,
        viewport: body.viewport
      },
      { overwrite: !!body.overwrite }
    );

    if (body.setActive) {
      setLastActiveLayoutSlug(sanitizedSlug);
    }

    return NextResponse.json({ success: true, layout: saved }, { status: 201 });
  } catch (err: any) {
    if (err instanceof LayoutError) {
      return NextResponse.json(
        { error: err.message, code: err.code },
        { status: err.statusCode }
      );
    }
    return NextResponse.json(
      { error: err.message || 'Failed to save layout' },
      { status: 500 }
    );
  }
}
