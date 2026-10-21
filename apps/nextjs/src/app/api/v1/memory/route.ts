import { NextResponse } from 'next/server';
import {
  addMemoryItem,
  clearUserMemories,
  deleteMemoryItem,
  listMemoryItems,
  resolveBearerToken,
  searchMemoryItems
} from '@eluvix/router-core';
import { getConfig, getRouter } from '@/lib/router';

export const dynamic = 'force-dynamic';

function checkNamedKeyIfPresent(req: Request): { valid: boolean; userId?: string } {
  const authHeader = req.headers.get('authorization');
  if (authHeader && authHeader.startsWith('Bearer ')) {
    const token = authHeader.slice(7).trim();
    if (token.startsWith('elx_')) {
      const resolved = resolveBearerToken(token);
      return { valid: resolved.valid, userId: resolved.userId };
    }
  }
  return { valid: true };
}

export async function GET(req: Request) {
  const auth = checkNamedKeyIfPresent(req);
  if (!auth.valid) {
    return NextResponse.json(
      { error: { message: 'Incorrect API key provided.', code: 'invalid_api_key' } },
      { status: 401 }
    );
  }

  const url = new URL(req.url);
  const userId = auth.userId || url.searchParams.get('userId') || 'default';
  const query = url.searchParams.get('q') || url.searchParams.get('query') || '';
  const limit = Math.min(200, Math.max(1, parseInt(url.searchParams.get('limit') || '50', 10) || 50));

  const config = getConfig();
  const router = getRouter();
  const contextProvider = router.getContextProvider();
  const providerHealthy = contextProvider ? await contextProvider.health().catch(() => false) : true;

  if (query.trim().length > 0 && contextProvider) {
    const recall = await contextProvider.recall(
      query,
      { userId, origin: 'client' },
      config.memory?.recallBudgetTokens ?? 600
    );
    return NextResponse.json({
      enabled: Boolean(config.memory?.enabled),
      provider: config.memory?.provider || 'builtin',
      healthy: providerHealthy,
      userId,
      recall
    });
  }

  const items = query.trim()
    ? searchMemoryItems(query, userId, limit)
    : listMemoryItems(userId, limit);

  return NextResponse.json({
    enabled: Boolean(config.memory?.enabled),
    provider: config.memory?.provider || 'builtin',
    healthy: providerHealthy,
    userId,
    items
  });
}

export async function POST(req: Request) {
  const auth = checkNamedKeyIfPresent(req);
  if (!auth.valid) {
    return NextResponse.json(
      { error: { message: 'Incorrect API key provided.', code: 'invalid_api_key' } },
      { status: 401 }
    );
  }

  let body: any;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  const userId = auth.userId || body?.userId || 'default';
  const router = getRouter();
  const contextProvider = router.getContextProvider();

  if (body?.action === 'commit' && contextProvider?.commit) {
    await contextProvider.commit({
      userId,
      sessionId: body?.sessionId,
      origin: 'client'
    });
    return NextResponse.json({ success: true, action: 'commit', userId });
  }

  const content = typeof body?.content === 'string' ? body.content.trim() : '';
  if (!content) {
    return NextResponse.json({ error: "'content' string is required" }, { status: 400 });
  }

  const item = addMemoryItem({
    userId,
    sessionId: typeof body?.sessionId === 'string' ? body.sessionId : undefined,
    uri: typeof body?.uri === 'string' ? body.uri : undefined,
    level: body?.level === 'L0' || body?.level === 'L1' || body?.level === 'L2' ? body.level : 'L1',
    content,
    metadata: body?.metadata && typeof body.metadata === 'object' ? body.metadata : undefined
  });

  return NextResponse.json({ success: true, item });
}

export async function DELETE(req: Request) {
  const auth = checkNamedKeyIfPresent(req);
  if (!auth.valid) {
    return NextResponse.json(
      { error: { message: 'Incorrect API key provided.', code: 'invalid_api_key' } },
      { status: 401 }
    );
  }

  const url = new URL(req.url);
  const idParam = url.searchParams.get('id');
  const clearAll = url.searchParams.get('clearAll') === 'true';
  const userId = auth.userId || url.searchParams.get('userId') || 'default';

  if (clearAll) {
    const deletedCount = clearUserMemories(userId);
    return NextResponse.json({ success: true, deletedCount, userId });
  }

  if (!idParam) {
    return NextResponse.json({ error: "Provide '?id=<number>' or '?clearAll=true'" }, { status: 400 });
  }

  const deleted = deleteMemoryItem(parseInt(idParam, 10));
  return NextResponse.json({ success: deleted });
}
