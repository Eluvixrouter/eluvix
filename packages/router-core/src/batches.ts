import crypto from 'node:crypto';
import { getDb } from './db.js';
import { globalVramArbiter } from './vram-arbiter.js';

export interface BatchFileRecord {
  id: string;
  object: 'file';
  bytes: number;
  created_at: number;
  filename: string;
  purpose: string;
  userId: string;
}

export interface BatchRequestCounts {
  total: number;
  completed: number;
  failed: number;
}

export interface BatchJobRecord {
  id: string;
  object: 'batch';
  endpoint: string;
  errors: null | { object: 'list'; data: Array<{ code: string; message: string; line?: number }> };
  input_file_id: string;
  completion_window: string;
  status: 'validating' | 'in_progress' | 'finalizing' | 'completed' | 'failed' | 'cancelled';
  output_file_id: string | null;
  error_file_id: string | null;
  created_at: number;
  in_progress_at: number | null;
  completed_at: number | null;
  failed_at: number | null;
  cancelled_at: number | null;
  request_counts: BatchRequestCounts;
  metadata: Record<string, string> | null;
}

export interface ParsedBatchJsonlLine {
  custom_id: string;
  method: string;
  url: string;
  body: Record<string, any>;
}

/**
 * Parses and validates an OpenAI Batch JSONL input string.
 */
export function parseBatchInputJsonl(contentJsonl: string): {
  valid: boolean;
  items: ParsedBatchJsonlLine[];
  errors: Array<{ code: string; message: string; line: number }>;
} {
  const items: ParsedBatchJsonlLine[] = [];
  const errors: Array<{ code: string; message: string; line: number }> = [];
  const seenCustomIds = new Set<string>();

  const lines = (contentJsonl || '').split('\n');
  let lineNum = 0;

  for (const rawLine of lines) {
    lineNum += 1;
    const trimmed = rawLine.trim();
    if (!trimmed) continue;

    let parsed: any;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      errors.push({
        code: 'invalid_json_line',
        message: `Line ${lineNum} is not valid JSON.`,
        line: lineNum,
      });
      continue;
    }

    const customId = typeof parsed?.custom_id === 'string' ? parsed.custom_id.trim() : '';
    if (!customId) {
      errors.push({
        code: 'missing_custom_id',
        message: `Line ${lineNum} is missing a non-empty string "custom_id".`,
        line: lineNum,
      });
      continue;
    }
    if (seenCustomIds.has(customId)) {
      errors.push({
        code: 'duplicate_custom_id',
        message: `Line ${lineNum} has duplicate custom_id "${customId}".`,
        line: lineNum,
      });
      continue;
    }
    seenCustomIds.add(customId);

    const method = typeof parsed?.method === 'string' ? parsed.method.toUpperCase() : 'POST';
    const url = typeof parsed?.url === 'string' ? parsed.url.trim() : '/v1/chat/completions';
    const body = parsed?.body && typeof parsed.body === 'object' ? parsed.body : {};

    items.push({
      custom_id: customId,
      method,
      url,
      body,
    });
  }

  if (items.length === 0 && errors.length === 0) {
    errors.push({
      code: 'empty_batch_file',
      message: 'Batch input JSONL contains zero request lines.',
      line: 1,
    });
  }

  return {
    valid: errors.length === 0 && items.length > 0,
    items,
    errors,
  };
}

export function createBatchFile(input: {
  filename: string;
  purpose?: string;
  contentJsonl: string;
  userId?: string;
}): BatchFileRecord {
  const db = getDb();
  const id = `file_${crypto.randomBytes(9).toString('hex')}`;
  const userId = (input.userId || 'default').trim() || 'default';
  const filename = (input.filename || 'batch_input.jsonl').trim();
  const purpose = (input.purpose || 'batch').trim();
  const contentJsonl = input.contentJsonl || '';
  const bytes = Buffer.byteLength(contentJsonl, 'utf8');
  const created_at = Math.floor(Date.now() / 1000);

  db.prepare(
    `INSERT INTO batch_files (id, user_id, filename, purpose, bytes, content_jsonl, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run(id, userId, filename, purpose, bytes, contentJsonl, created_at);

  return {
    id,
    object: 'file',
    bytes,
    created_at,
    filename,
    purpose,
    userId,
  };
}

export function getBatchFile(fileId: string, userId = 'default'): BatchFileRecord | null {
  const db = getDb();
  const row = db
    .prepare('SELECT id, user_id, filename, purpose, bytes, created_at FROM batch_files WHERE id = ? AND user_id = ?')
    .get(fileId, userId) as Record<string, any> | undefined;
  if (!row) return null;
  return {
    id: String(row.id),
    object: 'file',
    bytes: Number(row.bytes),
    created_at: Number(row.created_at),
    filename: String(row.filename),
    purpose: String(row.purpose),
    userId: String(row.user_id),
  };
}

export function getBatchFileContent(fileId: string, userId = 'default'): string | null {
  const db = getDb();
  const row = db
    .prepare('SELECT content_jsonl FROM batch_files WHERE id = ? AND user_id = ?')
    .get(fileId, userId) as { content_jsonl?: string } | undefined;
  return typeof row?.content_jsonl === 'string' ? row.content_jsonl : null;
}

export function listBatchFiles(userId = 'default', limit = 50): BatchFileRecord[] {
  const db = getDb();
  const rows = db
    .prepare(
      'SELECT id, user_id, filename, purpose, bytes, created_at FROM batch_files WHERE user_id = ? ORDER BY created_at DESC LIMIT ?'
    )
    .all(userId, Math.max(1, Math.min(200, limit))) as Array<Record<string, any>>;
  return rows.map((row) => ({
    id: String(row.id),
    object: 'file',
    bytes: Number(row.bytes),
    created_at: Number(row.created_at),
    filename: String(row.filename),
    purpose: String(row.purpose),
    userId: String(row.user_id),
  }));
}

function rowToBatchJobRecord(row: Record<string, any>): BatchJobRecord {
  let metadata: Record<string, string> | null = null;
  if (row.metadata_json) {
    try {
      metadata = JSON.parse(row.metadata_json);
    } catch {
      metadata = null;
    }
  }
  return {
    id: String(row.id),
    object: 'batch',
    endpoint: String(row.endpoint || '/v1/chat/completions'),
    errors: null,
    input_file_id: String(row.input_file_id),
    completion_window: String(row.completion_window || '24h'),
    status: row.status as BatchJobRecord['status'],
    output_file_id: row.output_file_id ? String(row.output_file_id) : null,
    error_file_id: row.error_file_id ? String(row.error_file_id) : null,
    created_at: Number(row.created_at),
    in_progress_at: row.in_progress_at ? Number(row.in_progress_at) : null,
    completed_at: row.completed_at ? Number(row.completed_at) : null,
    failed_at: row.failed_at ? Number(row.failed_at) : null,
    cancelled_at: row.cancelled_at ? Number(row.cancelled_at) : null,
    request_counts: {
      total: Number(row.total_requests || 0),
      completed: Number(row.completed_requests || 0),
      failed: Number(row.failed_requests || 0),
    },
    metadata,
  };
}

export function createBatchJob(input: {
  input_file_id: string;
  endpoint?: string;
  completion_window?: string;
  metadata?: Record<string, string> | null;
  userId?: string;
}): BatchJobRecord {
  const db = getDb();
  const userId = (input.userId || 'default').trim() || 'default';
  const fileContent = getBatchFileContent(input.input_file_id, userId);
  if (fileContent === null) {
    throw new Error(`Input file "${input.input_file_id}" not found for user "${userId}".`);
  }

  const parsed = parseBatchInputJsonl(fileContent);
  const id = `batch_${crypto.randomBytes(9).toString('hex')}`;
  const nowSec = Math.floor(Date.now() / 1000);
  const endpoint = (input.endpoint || '/v1/chat/completions').trim();
  const completionWindow = (input.completion_window || '24h').trim();
  const metadataJson = input.metadata ? JSON.stringify(input.metadata) : null;

  if (!parsed.valid) {
    db.prepare(
      `INSERT INTO batch_jobs (
        id, user_id, input_file_id, endpoint, completion_window, status,
        total_requests, completed_requests, failed_requests, metadata_json, created_at, failed_at
      ) VALUES (?, ?, ?, ?, ?, 'failed', 0, 0, ?, ?, ?, ?)`
    ).run(
      id,
      userId,
      input.input_file_id,
      endpoint,
      completionWindow,
      parsed.errors.length,
      metadataJson,
      nowSec,
      nowSec
    );

    const rec = getBatchJob(id, userId)!;
    rec.errors = { object: 'list', data: parsed.errors };
    return rec;
  }

  db.prepare(
    `INSERT INTO batch_jobs (
      id, user_id, input_file_id, endpoint, completion_window, status,
      total_requests, completed_requests, failed_requests, metadata_json, created_at, in_progress_at
    ) VALUES (?, ?, ?, ?, ?, 'in_progress', ?, 0, 0, ?, ?, ?)`
  ).run(
    id,
    userId,
    input.input_file_id,
    endpoint,
    completionWindow,
    parsed.items.length,
    metadataJson,
    nowSec,
    nowSec
  );

  const insertItemStmt = db.prepare(
    `INSERT INTO batch_items (batch_id, custom_id, method, url, body_json, status)
     VALUES (?, ?, ?, ?, ?, 'pending')`
  );
  for (const item of parsed.items) {
    insertItemStmt.run(id, item.custom_id, item.method, item.url, JSON.stringify(item.body));
  }

  return getBatchJob(id, userId)!;
}

export function getBatchJob(batchId: string, userId = 'default'): BatchJobRecord | null {
  const db = getDb();
  const row = db
    .prepare('SELECT * FROM batch_jobs WHERE id = ? AND user_id = ?')
    .get(batchId, userId) as Record<string, any> | undefined;
  if (!row) return null;
  return rowToBatchJobRecord(row);
}

export function listBatchJobs(userId = 'default', limit = 50): BatchJobRecord[] {
  const db = getDb();
  const rows = db
    .prepare('SELECT * FROM batch_jobs WHERE user_id = ? ORDER BY created_at DESC LIMIT ?')
    .all(userId, Math.max(1, Math.min(200, limit))) as Array<Record<string, any>>;
  return rows.map(rowToBatchJobRecord);
}

export function cancelBatchJob(batchId: string, userId = 'default'): BatchJobRecord | null {
  const db = getDb();
  const existing = getBatchJob(batchId, userId);
  if (!existing) return null;
  if (existing.status === 'completed' || existing.status === 'failed' || existing.status === 'cancelled') {
    return existing;
  }
  const nowSec = Math.floor(Date.now() / 1000);
  db.prepare(
    `UPDATE batch_jobs SET status = 'cancelled', cancelled_at = ? WHERE id = ? AND user_id = ?`
  ).run(nowSec, batchId, userId);
  db.prepare(
    `UPDATE batch_items SET status = 'cancelled' WHERE batch_id = ? AND status = 'pending'`
  ).run(batchId);
  return getBatchJob(batchId, userId);
}

/**
 * Executes all pending items in a batch job sequentially or with bounded concurrency,
 * yielding when interactive foreground GPU requests hold VRAM leases.
 */
export async function executeBatchJob(
  batchId: string,
  router: {
    routeChatCompletion: (req: any, opts?: any) => Promise<Response>;
    routeEmbeddings: (req: any, opts?: any) => Promise<Response>;
  },
  options?: {
    userId?: string;
    yieldIfVramBusy?: boolean;
  }
): Promise<BatchJobRecord | null> {
  const db = getDb();
  const userId = (options?.userId || 'default').trim() || 'default';
  const job = getBatchJob(batchId, userId);
  if (!job) return null;
  if (job.status === 'cancelled' || job.status === 'completed' || job.status === 'failed') {
    return job;
  }

  const items = db
    .prepare('SELECT * FROM batch_items WHERE batch_id = ? ORDER BY id ASC')
    .all(batchId) as Array<Record<string, any>>;

  const outputLines: string[] = [];
  const errorLines: string[] = [];
  let completedCount = 0;
  let failedCount = 0;

  for (const item of items) {
    // Check if cancelled mid-flight
    const refreshed = getBatchJob(batchId, userId);
    if (!refreshed || refreshed.status === 'cancelled') {
      return refreshed;
    }

    // Yield briefly if interactive foreground requests are holding local GPU VRAM
    if (options?.yieldIfVramBusy !== false) {
      const stats = globalVramArbiter.getStats();
      const totalActive =
        stats.activeInFlight.llm + stats.activeInFlight.media + stats.activeInFlight.audio;
      if (totalActive > 0) {
        await new Promise((r) => setTimeout(r, 15));
      }
    }

    const customId = String(item.custom_id);
    const url = String(item.url || job.endpoint || '/v1/chat/completions');
    let body: Record<string, any> = {};
    try {
      body = JSON.parse(item.body_json || '{}');
    } catch {
      body = {};
    }

    try {
      let res: Response;
      if (url.includes('/embeddings')) {
        res = await router.routeEmbeddings(body as any, {
          scope: { userId, origin: 'client' },
        });
      } else {
        res = await router.routeChatCompletion(
          { ...body, stream: false },
          { scope: { userId, origin: 'client' } }
        );
      }

      const status = res.status;
      let resBody: any;
      try {
        resBody = await res.json();
      } catch {
        resBody = { error: { message: 'Non-JSON upstream response' } };
      }

      const nowSec = Math.floor(Date.now() / 1000);
      const requestId = `batch_req_${crypto.randomBytes(6).toString('hex')}`;

      if (status >= 200 && status < 300) {
        completedCount += 1;
        const outLine = JSON.stringify({
          id: requestId,
          custom_id: customId,
          response: {
            status_code: status,
            request_id: requestId,
            body: resBody,
          },
          error: null,
        });
        outputLines.push(outLine);
        db.prepare(
          `UPDATE batch_items SET status = 'completed', response_status = ?, response_body_json = ?, completed_at = ? WHERE id = ?`
        ).run(status, JSON.stringify(resBody), nowSec, item.id);
      } else {
        failedCount += 1;
        const errObj = {
          code: resBody?.error?.code || `http_${status}`,
          message: resBody?.error?.message || `Request failed with status ${status}`,
        };
        const errLine = JSON.stringify({
          id: requestId,
          custom_id: customId,
          response: {
            status_code: status,
            request_id: requestId,
            body: resBody,
          },
          error: errObj,
        });
        errorLines.push(errLine);
        db.prepare(
          `UPDATE batch_items SET status = 'failed', response_status = ?, error_json = ?, completed_at = ? WHERE id = ?`
        ).run(status, JSON.stringify(errObj), nowSec, item.id);
      }
    } catch (err: any) {
      failedCount += 1;
      const nowSec = Math.floor(Date.now() / 1000);
      const errObj = {
        code: 'batch_execution_exception',
        message: err?.message || 'Batch item execution failed',
      };
      errorLines.push(
        JSON.stringify({
          id: `batch_req_${crypto.randomBytes(6).toString('hex')}`,
          custom_id: customId,
          response: null,
          error: errObj,
        })
      );
      db.prepare(
        `UPDATE batch_items SET status = 'failed', error_json = ?, completed_at = ? WHERE id = ?`
      ).run(JSON.stringify(errObj), nowSec, item.id);
    }

    db.prepare(
      `UPDATE batch_jobs SET completed_requests = ?, failed_requests = ? WHERE id = ?`
    ).run(completedCount, failedCount, batchId);
  }

  let outputFileId: string | null = null;
  if (outputLines.length > 0) {
    const outFile = createBatchFile({
      filename: `${batchId}_output.jsonl`,
      purpose: 'batch_output',
      contentJsonl: `${outputLines.join('\n')}\n`,
      userId,
    });
    outputFileId = outFile.id;
  }

  let errorFileId: string | null = null;
  if (errorLines.length > 0) {
    const errFile = createBatchFile({
      filename: `${batchId}_error.jsonl`,
      purpose: 'batch_output',
      contentJsonl: `${errorLines.join('\n')}\n`,
      userId,
    });
    errorFileId = errFile.id;
  }

  const doneSec = Math.floor(Date.now() / 1000);
  db.prepare(
    `UPDATE batch_jobs
     SET status = 'completed', output_file_id = ?, error_file_id = ?, completed_requests = ?, failed_requests = ?, completed_at = ?
     WHERE id = ? AND user_id = ?`
  ).run(outputFileId, errorFileId, completedCount, failedCount, doneSec, batchId, userId);

  return getBatchJob(batchId, userId);
}
