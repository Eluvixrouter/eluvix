import { NextResponse } from 'next/server';
import { ensureExamplesSeeded, listExampleConflicts, EXAMPLE_LAYOUTS } from '@/lib/layouts';

export const dynamic = 'force-dynamic';

/** Preview which existing files a restore would overwrite. */
export async function GET() {
  return NextResponse.json({ conflicts: listExampleConflicts(), count: EXAMPLE_LAYOUTS.length });
}

export async function POST() {
  try {
    const overwritten = ensureExamplesSeeded(true);
    return NextResponse.json({
      success: true,
      message: `Restored ${EXAMPLE_LAYOUTS.length} example templates`,
      count: EXAMPLE_LAYOUTS.length,
      overwritten
    });
  } catch (err: any) {
    console.error('[API /api/v1/layouts/restore-examples POST] Error:', err);
    return NextResponse.json({ error: err.message || 'Failed to restore example layouts' }, { status: 500 });
  }
}
