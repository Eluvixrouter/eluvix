import { NextResponse } from 'next/server';
import {
  createNamedApiKey,
  listNamedApiKeys,
  revokeNamedApiKey,
  sanitizePaperclipKeyPolicyForDisplay,
  type ApiKeyScope,
  type EluvixRole,
  type PaperclipKeyPolicy,
  type PaperclipStepTier,
} from '@eluvix/router-core';
import { resolveCallerIdentity } from '@/lib/caller-identity';

export const dynamic = 'force-dynamic';

const VALID_SCOPES = new Set<ApiKeyScope>([
  '*',
  'chat',
  'embeddings',
  'audio',
  'mcp',
  'evals:live',
  'export',
  'admin:config',
  'batches',
  'rerank',
  'prompts',
  'webhooks',
  'paperclip',
]);

const VALID_TIERS = new Set<PaperclipStepTier>([
  'fast-local',
  'code-specialist',
  'heavy-reasoning',
  'frontier-verified',
]);

function sanitizeKeyRecord(
  entry: ReturnType<typeof listNamedApiKeys>[number],
  includePlaintextKey = false
) {
  const { keyHash: _omitHash, ...rest } = entry;
  return {
    ...rest,
    key: includePlaintextKey ? entry.key : `${entry.keyPrefix || entry.key.slice(0, 8)}...`,
    ...(entry.paperclip
      ? { paperclip: sanitizePaperclipKeyPolicyForDisplay(entry.paperclip) }
      : {}),
  };
}

function parsePaperclipPolicy(raw: unknown): PaperclipKeyPolicy | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const r = raw as Record<string, unknown>;
  const policy: PaperclipKeyPolicy = {};

  if (Array.isArray(r.companyIds)) {
    const cleaned = r.companyIds.map((v) => String(v).trim()).filter(Boolean);
    if (cleaned.length > 0) policy.companyIds = cleaned;
  }
  if (typeof r.maxTier === 'string' && VALID_TIERS.has(r.maxTier as PaperclipStepTier)) {
    policy.maxTier = r.maxTier as PaperclipStepTier;
  }
  if (
    typeof r.maxCostPer1kUsd === 'number' &&
    Number.isFinite(r.maxCostPer1kUsd) &&
    r.maxCostPer1kUsd >= 0
  ) {
    policy.maxCostPer1kUsd = r.maxCostPer1kUsd;
  }
  if (typeof r.allowUnsignedContext === 'boolean') {
    policy.allowUnsignedContext = r.allowUnsignedContext;
  }
  if (typeof r.hmacSecret === 'string' && r.hmacSecret.trim()) {
    policy.hmacSecret = r.hmacSecret.trim();
  }

  return Object.keys(policy).length > 0 ? policy : undefined;
}

async function requireAdminKeyManager(req: Request) {
  const caller = await resolveCallerIdentity(req, { requiredScope: 'admin:config' });
  if (!caller.ok) {
    const status = caller.reason === 'insufficient-scope' ? 403 : 401;
    return {
      ok: false as const,
      response: NextResponse.json(
        {
          error: {
            message:
              status === 403
                ? 'API key lacks required "admin:config" scope.'
                : `Authentication failed (${caller.reason}).`,
            type: 'invalid_request_error',
            code: caller.reason,
          },
        },
        { status }
      ),
    };
  }
  if (caller.role !== 'admin') {
    return {
      ok: false as const,
      response: NextResponse.json(
        {
          error: {
            message: 'Forbidden: admin role required to manage scoped API keys.',
            type: 'insufficient_role',
            code: 'forbidden_non_admin',
          },
        },
        { status: 403 }
      ),
    };
  }
  return { ok: true as const, caller };
}

/**
 * GET /api/v1/keys
 * List all named API keys with key hashes stripped and HMAC secrets masked.
 */
export async function GET(req: Request) {
  const auth = await requireAdminKeyManager(req);
  if (!auth.ok) return auth.response;

  const keys = listNamedApiKeys('eluvix').map((k) => sanitizeKeyRecord(k, false));
  return NextResponse.json({
    object: 'list',
    data: keys,
  });
}

/**
 * POST /api/v1/keys
 * Mint a new scoped `elx_...` API key with optional Paperclip governance policy.
 * Returns plaintext `key` once on creation.
 */
export async function POST(req: Request) {
  const auth = await requireAdminKeyManager(req);
  if (!auth.ok) return auth.response;

  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json(
      { error: { message: 'Invalid JSON request body.', type: 'invalid_request_error' } },
      { status: 400 }
    );
  }

  const label =
    typeof body.label === 'string' && body.label.trim()
      ? body.label.trim().slice(0, 80)
      : 'Scoped API Key';

  let scopes: ApiKeyScope[] = ['chat'];
  if (Array.isArray(body.scopes)) {
    const filtered = body.scopes
      .map((s) => String(s).trim())
      .filter((s): s is ApiKeyScope => VALID_SCOPES.has(s as ApiKeyScope));
    if (filtered.length > 0) {
      scopes = Array.from(new Set(filtered));
    }
  }

  const role: EluvixRole =
    body.role === 'admin' || body.role === 'readonly' || body.role === 'operator'
      ? body.role
      : 'operator';
  const origin =
    body.origin === 'harness' || body.origin === 'playground' || body.origin === 'client'
      ? body.origin
      : 'client';

  const paperclip = parsePaperclipPolicy(body.paperclip);

  const created = createNamedApiKey(
    {
      label,
      origin,
      userId:
        typeof body.userId === 'string' && body.userId.trim()
          ? body.userId.trim()
          : auth.caller.userId || 'default',
      role,
      scopes,
      expiresAt:
        typeof body.expiresAt === 'string' && body.expiresAt.trim()
          ? body.expiresAt.trim()
          : undefined,
      maxDailySpendUsd:
        typeof body.maxDailySpendUsd === 'number' &&
        Number.isFinite(body.maxDailySpendUsd) &&
        body.maxDailySpendUsd >= 0
          ? body.maxDailySpendUsd
          : undefined,
      rpm:
        typeof body.rpm === 'number' && Number.isFinite(body.rpm) && body.rpm > 0
          ? Math.floor(body.rpm)
          : undefined,
      paperclip,
      actorId: auth.caller.userId || 'default',
    },
    'eluvix'
  );

  return NextResponse.json(sanitizeKeyRecord(created, true), { status: 201 });
}

/**
 * DELETE /api/v1/keys?id=<id>
 * Revoke a named API key by id (query param `?id=` or JSON body `{ id }`).
 */
export async function DELETE(req: Request) {
  const auth = await requireAdminKeyManager(req);
  if (!auth.ok) return auth.response;

  const url = new URL(req.url);
  let id = url.searchParams.get('id')?.trim() || '';
  if (!id) {
    try {
      const body = await req.json();
      if (typeof body?.id === 'string') id = body.id.trim();
    } catch {
      // ignore missing body
    }
  }
  if (!id) {
    return NextResponse.json(
      { error: { message: 'Missing required "id" parameter.', type: 'invalid_request_error' } },
      { status: 400 }
    );
  }

  const deleted = revokeNamedApiKey(id, 'eluvix', auth.caller.userId || 'default');
  if (!deleted) {
    return NextResponse.json(
      { error: { message: `API key '${id}' not found.`, type: 'invalid_request_error' } },
      { status: 404 }
    );
  }

  return NextResponse.json({ id, deleted: true });
}
