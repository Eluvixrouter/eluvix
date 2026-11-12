import crypto from 'node:crypto';
import { getDb } from './db.js';

export const GENESIS_AUDIT_HASH = '0'.repeat(64);

export interface AuditEventInput {
  id?: string;
  timestamp?: string;
  actorId?: string;
  actorRole?: string;
  action: string;
  resourceType: string;
  resourceId?: string | null;
  details?: Record<string, any>;
}

export interface AuditEventRecord {
  seq: number;
  id: string;
  timestamp: string;
  actorId: string;
  actorRole: string;
  action: string;
  resourceType: string;
  resourceId: string | null;
  details: Record<string, any>;
  prevHash: string;
  entryHash: string;
}

export interface AuditChainVerificationResult {
  valid: boolean;
  checkedCount: number;
  latestEntryHash: string;
  firstTamperedSeq?: number;
  firstTamperedId?: string;
  expectedHash?: string;
  actualHash?: string;
  reason?: string;
}

/**
 * Deterministic canonical JSON stringification so hash verification is stable across runs.
 */
export function canonicalJsonStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value ?? {});
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalJsonStringify(item)).join(',')}]`;
  }
  const obj = value as Record<string, unknown>;
  const sortedKeys = Object.keys(obj)
    .filter((k) => obj[k] !== undefined)
    .sort();
  const pairs = sortedKeys.map((k) => `${JSON.stringify(k)}:${canonicalJsonStringify(obj[k])}`);
  return `{${pairs.join(',')}}`;
}

/**
 * Computes the SHA-256 tamper-evident hash for a single audit log row linked to `prevHash`.
 */
export function computeAuditEntryHash(params: {
  prevHash: string;
  id: string;
  timestamp: string;
  actorId: string;
  actorRole: string;
  action: string;
  resourceType: string;
  resourceId?: string | null;
  detailsJson: string;
}): string {
  const payload = [
    params.prevHash,
    params.id,
    params.timestamp,
    params.actorId,
    params.actorRole,
    params.action,
    params.resourceType,
    params.resourceId ?? '',
    params.detailsJson,
  ].join('|');
  return crypto.createHash('sha256').update(payload, 'utf8').digest('hex');
}

/**
 * Appends a tamper-evident audit event to the SQLite `audit_events` hash chain.
 */
export function recordAuditEvent(input: AuditEventInput): AuditEventRecord {
  const db = getDb();
  const id = input.id || `aud_${crypto.randomBytes(8).toString('hex')}`;
  const timestamp = input.timestamp || new Date().toISOString();
  const actorId = (input.actorId || 'default').trim() || 'default';
  const actorRole = (input.actorRole || 'admin').trim() || 'admin';
  const action = input.action.trim();
  const resourceType = input.resourceType.trim();
  const resourceId = input.resourceId ?? null;
  const detailsObj = input.details && typeof input.details === 'object' ? input.details : {};
  const detailsJson = canonicalJsonStringify(detailsObj);

  const lastRow = db
    .prepare('SELECT entry_hash FROM audit_events ORDER BY seq DESC LIMIT 1')
    .get() as { entry_hash?: string } | undefined;
  const prevHash = lastRow?.entry_hash || GENESIS_AUDIT_HASH;

  const entryHash = computeAuditEntryHash({
    prevHash,
    id,
    timestamp,
    actorId,
    actorRole,
    action,
    resourceType,
    resourceId,
    detailsJson,
  });

  const info = db
    .prepare(
      `INSERT INTO audit_events (
        id, timestamp, actor_id, actor_role, action, resource_type, resource_id, details_json, prev_hash, entry_hash
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      id,
      timestamp,
      actorId,
      actorRole,
      action,
      resourceType,
      resourceId,
      detailsJson,
      prevHash,
      entryHash
    );

  const seq = Number(info?.lastInsertRowid || 0);
  return {
    seq,
    id,
    timestamp,
    actorId,
    actorRole,
    action,
    resourceType,
    resourceId,
    details: detailsObj,
    prevHash,
    entryHash,
  };
}

/**
 * Lists recent audit events in reverse chronological order (or ascending when `order = 'asc'`).
 */
export function listAuditEvents(options?: {
  limit?: number;
  action?: string;
  actorId?: string;
  order?: 'asc' | 'desc';
}): AuditEventRecord[] {
  const db = getDb();
  const limit = Math.max(1, Math.min(1000, options?.limit ?? 100));
  const dir = options?.order === 'asc' ? 'ASC' : 'DESC';

  const clauses: string[] = [];
  const params: any[] = [];
  if (options?.action) {
    clauses.push('action = ?');
    params.push(options.action);
  }
  if (options?.actorId) {
    clauses.push('actor_id = ?');
    params.push(options.actorId);
  }

  const whereSql = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
  const rows = db
    .prepare(`SELECT * FROM audit_events ${whereSql} ORDER BY seq ${dir} LIMIT ?`)
    .all(...params, limit) as Array<Record<string, any>>;

  return rows.map((row) => {
    let details: Record<string, any> = {};
    try {
      details = JSON.parse(row.details_json || '{}');
    } catch {
      details = {};
    }
    return {
      seq: Number(row.seq),
      id: String(row.id),
      timestamp: String(row.timestamp),
      actorId: String(row.actor_id),
      actorRole: String(row.actor_role),
      action: String(row.action),
      resourceType: String(row.resource_type),
      resourceId: row.resource_id ?? null,
      details,
      prevHash: String(row.prev_hash),
      entryHash: String(row.entry_hash),
    };
  });
}

/**
 * Verifies the cryptographic integrity of the entire `audit_events` hash chain from genesis (`seq = 1..N`).
 */
export function verifyAuditChain(): AuditChainVerificationResult {
  const db = getDb();
  const rows = db
    .prepare('SELECT * FROM audit_events ORDER BY seq ASC')
    .all() as Array<Record<string, any>>;

  let expectedPrevHash = GENESIS_AUDIT_HASH;
  let checkedCount = 0;

  for (const row of rows) {
    checkedCount += 1;
    const seq = Number(row.seq);
    const id = String(row.id);
    const actualPrevHash = String(row.prev_hash || '');
    const actualEntryHash = String(row.entry_hash || '');

    if (actualPrevHash !== expectedPrevHash) {
      return {
        valid: false,
        checkedCount,
        latestEntryHash: actualEntryHash,
        firstTamperedSeq: seq,
        firstTamperedId: id,
        expectedHash: expectedPrevHash,
        actualHash: actualPrevHash,
        reason: `Broken prev_hash link at seq=${seq} (${id})`,
      };
    }

    const recomputed = computeAuditEntryHash({
      prevHash: expectedPrevHash,
      id,
      timestamp: String(row.timestamp),
      actorId: String(row.actor_id),
      actorRole: String(row.actor_role),
      action: String(row.action),
      resourceType: String(row.resource_type),
      resourceId: row.resource_id ?? null,
      detailsJson: String(row.details_json || '{}'),
    });

    if (recomputed !== actualEntryHash) {
      return {
        valid: false,
        checkedCount,
        latestEntryHash: actualEntryHash,
        firstTamperedSeq: seq,
        firstTamperedId: id,
        expectedHash: recomputed,
        actualHash: actualEntryHash,
        reason: `Tampered payload or entry_hash mismatch at seq=${seq} (${id})`,
      };
    }

    expectedPrevHash = actualEntryHash;
  }

  return {
    valid: true,
    checkedCount,
    latestEntryHash: expectedPrevHash,
  };
}
