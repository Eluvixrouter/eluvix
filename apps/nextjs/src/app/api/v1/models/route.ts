import { NextResponse } from 'next/server';
import { getCachedAntigravityModels } from '@eluvix/router-core';
import { getRouter } from '@/lib/router';

export const dynamic = 'force-dynamic';

export async function GET() {
  const router = getRouter();
  const upstreams = router.getUpstreams();
  const agyCatalog = getCachedAntigravityModels();
  
  // Aggregate all models from upstreams
  const modelSet = new Set<string>();
  modelSet.add('auto');
  upstreams.forEach(u => {
    (u.models || []).forEach(m => {
      if (m !== '*' && !/^gemini-(?:3\.1|3\.6|3\.7|2\.5)/i.test(m)) {
        modelSet.add(m);
      }
    });
    if (u.type === 'antigravity' || u.endpoint?.startsWith('cli://')) {
      agyCatalog.forEach(entry => modelSet.add(entry.baseId));
    }
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
