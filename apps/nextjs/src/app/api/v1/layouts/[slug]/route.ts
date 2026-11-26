import { NextResponse } from 'next/server';
import {
  readLayout,
  writeLayout,
  deleteLayout,
  sanitizeSlug,
  setLastActiveLayoutSlug,
  getLastActiveLayoutSlug,
  LayoutError
} from '@/lib/layouts';
import { resolveCallerIdentity } from '@/lib/caller-identity';

export const dynamic = 'force-dynamic';

/**
 * Hunt-3 C-L6: layouts routes had no in-handler identity check. Any
 * authenticated caller may read; only non-readonly callers may overwrite
 * or delete shared global layouts.
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

function errorResponse(err: any, fallback: string) {
  if (err instanceof LayoutError) {
    return NextResponse.json({ error: err.message, code: err.code }, { status: err.statusCode });
  }
  return NextResponse.json({ error: err?.message || fallback }, { status: 500 });
}

export async function GET(req: Request, { params }: { params: Promise<{ slug: string }> }) {
  const denied = await requireLayoutCaller(req, false);
  if (denied) return denied;
  try {
    const slug = sanitizeSlug((await params).slug);
    const layout = readLayout(slug);
    if (!layout) {
      return NextResponse.json({ error: `Layout "${slug}" not found` }, { status: 404 });
    }
    return NextResponse.json({ layout });
  } catch (err: any) {
    return errorResponse(err, 'Failed to fetch layout');
  }
}

export async function PUT(req: Request, { params }: { params: Promise<{ slug: string }> }) {
  const denied = await requireLayoutCaller(req, true);
  if (denied) return denied;
  let body: any;
  try {
    body = await req.json();
  } catch (err: any) {
    return NextResponse.json({ error: `Malformed JSON: ${err.message}` }, { status: 400 });
  }

  try {
    const slug = sanitizeSlug((await params).slug);
    const existing = readLayout(slug);
    if (!existing) {
      return NextResponse.json(
        { error: `Layout "${slug}" does not exist. Use POST to create a new layout.` },
        { status: 404 }
      );
    }

    const graphChanged =
      (body.nodes !== undefined && JSON.stringify(body.nodes) !== JSON.stringify(existing.nodes)) ||
      (body.edges !== undefined && JSON.stringify(body.edges) !== JSON.stringify(existing.edges));

    const updated = writeLayout(
      slug,
      {
        name: body.name ?? existing.name,
        description: body.description ?? existing.description,
        category: body.category ?? existing.category,
        tags: body.tags ?? existing.tags,
        // A modified example becomes a regular custom layout so "Restore examples" won't silently clobber it.
        isExample: existing.isExample && !graphChanged,
        nodes: body.nodes ?? existing.nodes,
        edges: body.edges ?? existing.edges,
        viewport: body.viewport ?? existing.viewport
      },
      { overwrite: true }
    );

    if (body.setActive !== false) {
      setLastActiveLayoutSlug(slug);
    }

    return NextResponse.json({ success: true, layout: updated });
  } catch (err: any) {
    return errorResponse(err, 'Failed to update layout');
  }
}

export async function DELETE(req: Request, { params }: { params: Promise<{ slug: string }> }) {
  const denied = await requireLayoutCaller(req, true);
  if (denied) return denied;
  try {
    const slug = sanitizeSlug((await params).slug);
    if (!deleteLayout(slug)) {
      return NextResponse.json({ error: `Layout "${slug}" not found` }, { status: 404 });
    }
    if (getLastActiveLayoutSlug() === slug) {
      setLastActiveLayoutSlug('default');
    }
    return NextResponse.json({ success: true, deletedSlug: slug });
  } catch (err: any) {
    return errorResponse(err, 'Failed to delete layout');
  }
}
