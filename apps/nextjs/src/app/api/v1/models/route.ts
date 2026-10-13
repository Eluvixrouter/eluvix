import { NextResponse } from 'next/server';
import { getRouter } from '@/lib/router';

export const dynamic = 'force-dynamic';

export async function GET() {
  const router = getRouter();
  const upstreams = router.getUpstreams();
  
  // Aggregate all models from upstreams
  const modelSet = new Set<string>();
  modelSet.add('auto');
  upstreams.forEach(u => {
    (u.models || []).forEach(m => {
      if (m !== '*') {
        modelSet.add(m);
      }
    });
  });

  const data = Array.from(modelSet).map(m => ({
    id: m,
    object: "model",
    created: Math.floor(Date.now() / 1000),
    owned_by: "eluvix"
  }));

  return NextResponse.json({
    object: "list",
    data: data
  });
}
