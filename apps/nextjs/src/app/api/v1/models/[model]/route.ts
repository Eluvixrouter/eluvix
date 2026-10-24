import { NextResponse } from 'next/server';
import { getCachedAntigravityModels, resolveBearerToken } from '@eluvix/router-core';
import { getRouter } from '@/lib/router';

export const dynamic = 'force-dynamic';

export async function GET(
  req: Request,
  { params }: { params: { model: string } }
) {
  const authHeader = req?.headers?.get('authorization');
  if (authHeader && authHeader.startsWith('Bearer ')) {
    const token = authHeader.slice(7).trim();
    if (token.startsWith('elx_')) {
      const resolved = resolveBearerToken(token);
      if (!resolved.valid) {
        return NextResponse.json(
          {
            error: {
              message: 'Incorrect API key provided.',
              type: 'invalid_request_error',
              code: 'invalid_api_key'
            }
          },
          { status: 401 }
        );
      }
    }
  }
  const modelId = decodeURIComponent(params.model);
  const router = getRouter();
  const upstreams = router.getUpstreams();
  const agyCatalog = getCachedAntigravityModels();

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

  if (!modelSet.has(modelId)) {
    return NextResponse.json(
      {
        error: {
          message: `The model '${modelId}' does not exist or you do not have access to it.`,
          type: 'invalid_request_error',
          param: 'model',
          code: 'model_not_found'
        }
      },
      { status: 404 }
    );
  }

  return NextResponse.json({
    id: modelId,
    object: 'model',
    created: Math.floor(Date.now() / 1000),
    owned_by: 'eluvix'
  });
}
