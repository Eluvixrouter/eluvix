import { NextResponse } from 'next/server';
import {
  addMemoryItem,
  clearUserMemories,
  deleteMemoryItem,
  invalidateUserCache,
  listMemoryItems,
  searchMemoryItems
} from '@eluvix/router-core';
import { getConfig, getRouter } from '@/lib/router';
import { resolveCallerIdentity, type CallerIdentityResult } from '@/lib/caller-identity';

export const dynamic = 'force-dynamic';

/**
 * Memory data is per-user, so every handler scopes strictly to the
 * authenticated caller's identity (named elx_ key, admin bearer, or the
 * NextAuth session — see lib/caller-identity). A userId supplied via
 * query string or request body is deliberately ignored: it must never
 * widen access beyond the caller's own store.
 */
function unauthorized(identity: Extract<CallerIdentityResult, { ok: false }>) {
  return NextResponse.json(
    {
      error: {
        message:
          identity.reason === 'invalid-key'
            ? 'Incorrect API key provided.'
            : 'You must provide a valid API key or an authenticated session.',
        code: identity.reason === 'invalid-key' ? 'invalid_api_key' : 'unauthorized'
      }
    },
    { status: 401 }
  );
}

export async function GET(req: Request) {
  const identity = await resolveCallerIdentity(req);
  if (!identity.ok) {
    return unauthorized(identity);
  }
  const userId = identity.userId;

  const url = new URL(req.url);
  const query = url.searchParams.get('q') || url.searchParams.get('query') || '';
  const limit = Math.min(200, Math.max(1, parseInt(url.searchParams.get('limit') || '50', 10) || 50));

  const config = getConfig();
  const router = getRouter();
  const contextProvider = router.getContextProvider();
  const providerHealthy = contextProvider ? await contextProvider.health().catch(() => false) : true;

  if (query.trim().length > 0 && contextProvider) {
    try {
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
    } catch {
      // Fall back to local SQLite search if external memory container is unreachable
    }
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
  const identity = await resolveCallerIdentity(req);
  if (!identity.ok) {
    return unauthorized(identity);
  }
  const userId = identity.userId;

  let body: any;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

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

  const sessionId = typeof body?.sessionId === 'string' ? body.sessionId : undefined;
  const item = addMemoryItem({
    userId,
    sessionId,
    uri: typeof body?.uri === 'string' ? body.uri : undefined,
    level: body?.level === 'L0' || body?.level === 'L1' || body?.level === 'L2' ? body.level : 'L1',
    content,
    metadata: body?.metadata && typeof body.metadata === 'object' ? body.metadata : undefined
  });

  // Also sync manual memory notes to the active external ContextProvider (e.g., OpenViking / Mem0)
  if (contextProvider && contextProvider.id !== 'builtin') {
    await contextProvider
      .remember(
        { user: { role: 'user', content }, assistant: '' },
        { userId, sessionId, origin: 'client' }
      )
      .catch(() => {});
  }

  return NextResponse.json({ success: true, item });
}

export async function DELETE(req: Request) {
  const identity = await resolveCallerIdentity(req);
  if (!identity.ok) {
    return unauthorized(identity);
  }
  const userId = identity.userId;

  const url = new URL(req.url);
  const idParam = url.searchParams.get('id');
  const clearAll = url.searchParams.get('clearAll') === 'true';

  if (clearAll) {
    const deletedCount = clearUserMemories(userId);
    // Answers derived from the cleared memories must stop being served
    // from the response cache immediately (audit M-10).
    invalidateUserCache(userId);
    return NextResponse.json({ success: true, deletedCount, userId });
  }

  if (!idParam) {
    return NextResponse.json({ error: "Provide '?id=<number>' or '?clearAll=true'" }, { status: 400 });
  }

  const parsedId = parseInt(idParam, 10);
  if (!Number.isFinite(parsedId) || parsedId <= 0) {
    return NextResponse.json({ error: "Invalid '?id=<number>' parameter" }, { status: 400 });
  }

  // Scoped delete: the item is removed only if it belongs to the caller.
  const deleted = deleteMemoryItem(parsedId, userId);
  if (deleted) {
    invalidateUserCache(userId);
  }
  return NextResponse.json({ success: deleted });
}
