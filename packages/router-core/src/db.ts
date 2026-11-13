import path from 'node:path';
import fs from 'node:fs';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';
import { getAppPaths } from './paths.js';
import type { BanditArmStats } from './cascade.js';

const require = createRequire(import.meta.url);

export interface RequestLog {
  id?: number;
  timestamp?: string;
  model: string;
  upstream_id: string;
  status: number;
  duration_ms: number;
  prompt_tokens?: number;
  completion_tokens?: number;
  cache_read_tokens?: number;
  cache_write_tokens?: number;
  ttft_ms?: number;
  itl_ms?: number;
  kv_cache_kb?: number;
  cost_usd?: number;
  user_id?: string;
  correlation_id?: string;
  pc_issue_id?: string;
  pc_agent_id?: string;
  pc_company_id?: string;
  pc_priority?: string;
}

export interface SqliteDb {
  exec(sql: string): void;
  prepare(sql: string): {
    all(...params: any[]): any[];
    get(...params: any[]): any;
    run(...params: any[]): any;
  };
}

let dbInstance: SqliteDb | null = null;
let dbInstancePath: string | null = null;

function initSchema(db: SqliteDb) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS request_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
      model TEXT NOT NULL,
      upstream_id TEXT NOT NULL,
      status INTEGER NOT NULL,
      duration_ms INTEGER,
      prompt_tokens INTEGER DEFAULT 0,
      completion_tokens INTEGER DEFAULT 0,
      cache_read_tokens INTEGER DEFAULT 0,
      cache_write_tokens INTEGER DEFAULT 0,
      ttft_ms INTEGER,
      itl_ms REAL,
      kv_cache_kb REAL,
      cost_usd REAL DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS chat_history (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL,
      user_id TEXT NOT NULL DEFAULT 'default',
      timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
      role TEXT NOT NULL,
      content TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS provider_settings (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      enabled INTEGER DEFAULT 0,
      server_url TEXT DEFAULT 'https://api.billama.dev',
      node_token TEXT,
      node_id TEXT,
      node_name TEXT,
      engine_url TEXT DEFAULT 'http://localhost:11434',
      engine_type TEXT DEFAULT 'ollama',
      pricing_mode TEXT DEFAULT 'market',
      floor_price_in REAL DEFAULT 0,
      floor_price_out REAL DEFAULT 0,
      pause_on_user_active INTEGER DEFAULT 1,
      max_gpu_temp_c INTEGER DEFAULT 82,
      max_concurrency INTEGER DEFAULT 1,
      total_jobs_completed INTEGER DEFAULT 0,
      total_tokens_served INTEGER DEFAULT 0,
      total_earned_usd REAL DEFAULT 0.0,
      reputation_score REAL DEFAULT 100.0,
      last_heartbeat_at DATETIME
    );

    INSERT OR IGNORE INTO provider_settings (id, enabled, server_url, engine_url, engine_type)
    VALUES (1, 0, 'https://api.billama.dev', 'http://localhost:11434', 'ollama');

    CREATE TABLE IF NOT EXISTS provider_job_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      job_id TEXT NOT NULL,
      timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
      model TEXT NOT NULL,
      prompt_tokens INTEGER DEFAULT 0,
      completion_tokens INTEGER DEFAULT 0,
      duration_ms INTEGER DEFAULT 0,
      earned_usd REAL DEFAULT 0.0,
      status TEXT NOT NULL,
      error_message TEXT
    );

    CREATE TABLE IF NOT EXISTS memory_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id TEXT NOT NULL DEFAULT 'default',
      session_id TEXT,
      uri TEXT,
      level TEXT DEFAULT 'L1',
      content TEXT NOT NULL,
      metadata TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE INDEX IF NOT EXISTS idx_memory_items_user ON memory_items(user_id, id DESC);

    CREATE TABLE IF NOT EXISTS harness_sessions (
      session_id TEXT NOT NULL,
      user_id TEXT NOT NULL DEFAULT 'default',
      title TEXT NOT NULL DEFAULT 'Untitled Harness Session',
      harness_kind TEXT NOT NULL DEFAULT 'opencode',
      agent_id TEXT DEFAULT 'build',
      node_id TEXT,
      endpoint TEXT,
      kv_prefix_hash TEXT,
      last_tier TEXT,
      redaction_count INTEGER DEFAULT 0,
      injection_count INTEGER DEFAULT 0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (user_id, session_id)
    );

    CREATE INDEX IF NOT EXISTS idx_harness_sessions_user_updated ON harness_sessions(user_id, updated_at DESC);

    CREATE TABLE IF NOT EXISTS response_store (
      id TEXT NOT NULL,
      user_id TEXT NOT NULL DEFAULT 'default',
      previous_response_id TEXT,
      model TEXT NOT NULL,
      messages_json TEXT NOT NULL,
      response_json TEXT NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (user_id, id)
    );

    CREATE INDEX IF NOT EXISTS idx_response_store_user_created ON response_store(user_id, created_at DESC);

    CREATE TABLE IF NOT EXISTS bandit_arms (
      arm_key TEXT PRIMARY KEY,
      upstream_id TEXT NOT NULL,
      complexity_tier TEXT NOT NULL,
      alpha REAL NOT NULL DEFAULT 2.0,
      beta REAL NOT NULL DEFAULT 1.0,
      ewma_ttft_ms REAL,
      ewma_itl_ms REAL,
      total_pulls INTEGER NOT NULL DEFAULT 0,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE INDEX IF NOT EXISTS idx_bandit_arms_tier ON bandit_arms(complexity_tier);

    CREATE TABLE IF NOT EXISTS distillation_pairs (
      id TEXT NOT NULL,
      user_id TEXT NOT NULL DEFAULT 'default',
      source TEXT NOT NULL DEFAULT 'shadow',
      teacher_upstream_id TEXT NOT NULL,
      student_upstream_id TEXT NOT NULL,
      teacher_model TEXT NOT NULL,
      student_model TEXT NOT NULL,
      prompt_messages_json TEXT NOT NULL,
      chosen_text TEXT NOT NULL,
      rejected_text TEXT NOT NULL,
      judge_score REAL NOT NULL DEFAULT 1.0,
      privacy_scrubbed INTEGER NOT NULL DEFAULT 1,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (user_id, id)
    );

    CREATE INDEX IF NOT EXISTS idx_distillation_pairs_user_score ON distillation_pairs(user_id, judge_score DESC, created_at DESC);

    CREATE TABLE IF NOT EXISTS audit_events (
      seq INTEGER PRIMARY KEY AUTOINCREMENT,
      id TEXT NOT NULL UNIQUE,
      timestamp TEXT NOT NULL,
      actor_id TEXT NOT NULL,
      actor_role TEXT NOT NULL,
      action TEXT NOT NULL,
      resource_type TEXT NOT NULL,
      resource_id TEXT,
      details_json TEXT NOT NULL,
      prev_hash TEXT NOT NULL,
      entry_hash TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_audit_events_seq ON audit_events(seq DESC);
    CREATE INDEX IF NOT EXISTS idx_audit_events_action ON audit_events(action, seq DESC);

    CREATE TABLE IF NOT EXISTS batch_files (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL DEFAULT 'default',
      filename TEXT NOT NULL,
      purpose TEXT NOT NULL DEFAULT 'batch',
      bytes INTEGER NOT NULL DEFAULT 0,
      content_jsonl TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_batch_files_user ON batch_files(user_id, created_at DESC);

    CREATE TABLE IF NOT EXISTS batch_jobs (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL DEFAULT 'default',
      input_file_id TEXT NOT NULL,
      output_file_id TEXT,
      error_file_id TEXT,
      endpoint TEXT NOT NULL DEFAULT '/v1/chat/completions',
      completion_window TEXT NOT NULL DEFAULT '24h',
      status TEXT NOT NULL DEFAULT 'validating',
      total_requests INTEGER NOT NULL DEFAULT 0,
      completed_requests INTEGER NOT NULL DEFAULT 0,
      failed_requests INTEGER NOT NULL DEFAULT 0,
      metadata_json TEXT,
      created_at INTEGER NOT NULL,
      in_progress_at INTEGER,
      completed_at INTEGER,
      failed_at INTEGER,
      cancelled_at INTEGER
    );

    CREATE INDEX IF NOT EXISTS idx_batch_jobs_user ON batch_jobs(user_id, created_at DESC);

    CREATE TABLE IF NOT EXISTS batch_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      batch_id TEXT NOT NULL,
      custom_id TEXT NOT NULL,
      method TEXT NOT NULL DEFAULT 'POST',
      url TEXT NOT NULL DEFAULT '/v1/chat/completions',
      body_json TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      response_status INTEGER,
      response_body_json TEXT,
      error_json TEXT,
      completed_at INTEGER
    );

    CREATE INDEX IF NOT EXISTS idx_batch_items_batch ON batch_items(batch_id, id ASC);

    CREATE TABLE IF NOT EXISTS prompt_registry (
      id TEXT NOT NULL,
      version INTEGER NOT NULL,
      user_id TEXT NOT NULL DEFAULT 'default',
      description TEXT,
      system_template TEXT NOT NULL,
      variables_schema_json TEXT,
      model_hint TEXT,
      eval_score REAL,
      created_at TEXT NOT NULL,
      PRIMARY KEY (id, version)
    );

    CREATE TABLE IF NOT EXISTS prompt_aliases (
      prompt_id TEXT NOT NULL,
      alias TEXT NOT NULL,
      version INTEGER NOT NULL,
      updated_at TEXT NOT NULL,
      updated_by TEXT NOT NULL DEFAULT 'default',
      PRIMARY KEY (prompt_id, alias)
    );

    CREATE TABLE IF NOT EXISTS alert_webhooks (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL DEFAULT 'default',
      name TEXT NOT NULL,
      url TEXT NOT NULL,
      provider TEXT NOT NULL DEFAULT 'json',
      secret TEXT,
      events_json TEXT NOT NULL,
      enabled INTEGER NOT NULL DEFAULT 1,
      last_status INTEGER,
      last_triggered_at TEXT,
      created_at TEXT NOT NULL
    );
  `);

  // Migration for databases created before chat_history carried a user
  // dimension: add user_id (existing rows take the column default,
  // 'default' — the admin's partition, which is who wrote them) and index
  // the (user_id, session_id) lookup the history queries now perform.
  const chatCols = db.prepare('PRAGMA table_info(chat_history)').all() as Array<{ name: string }>;
  if (!chatCols.some(c => c.name === 'user_id')) {
    db.exec("ALTER TABLE chat_history ADD COLUMN user_id TEXT NOT NULL DEFAULT 'default'");
  }
  if (!chatCols.some(c => c.name === 'metadata')) {
    db.exec('ALTER TABLE chat_history ADD COLUMN metadata TEXT');
  }
  db.exec('CREATE INDEX IF NOT EXISTS idx_chat_history_user_session ON chat_history(user_id, session_id, id)');

  // Migration for request_logs: add ttft_ms, itl_ms, kv_cache_kb, and prompt-cache columns
  const reqCols = db.prepare('PRAGMA table_info(request_logs)').all() as Array<{ name: string }>;
  if (!reqCols.some(c => c.name === 'ttft_ms')) {
    db.exec('ALTER TABLE request_logs ADD COLUMN ttft_ms INTEGER');
  }
  if (!reqCols.some(c => c.name === 'itl_ms')) {
    db.exec('ALTER TABLE request_logs ADD COLUMN itl_ms REAL');
  }
  if (!reqCols.some(c => c.name === 'kv_cache_kb')) {
    db.exec('ALTER TABLE request_logs ADD COLUMN kv_cache_kb REAL');
  }
  if (!reqCols.some(c => c.name === 'cost_usd')) {
    db.exec('ALTER TABLE request_logs ADD COLUMN cost_usd REAL DEFAULT 0');
  }
  if (!reqCols.some(c => c.name === 'user_id')) {
    db.exec("ALTER TABLE request_logs ADD COLUMN user_id TEXT NOT NULL DEFAULT 'default'");
  }
  if (!reqCols.some(c => c.name === 'cache_read_tokens')) {
    db.exec('ALTER TABLE request_logs ADD COLUMN cache_read_tokens INTEGER DEFAULT 0');
  }
  if (!reqCols.some(c => c.name === 'cache_write_tokens')) {
    db.exec('ALTER TABLE request_logs ADD COLUMN cache_write_tokens INTEGER DEFAULT 0');
  }
  if (!reqCols.some(c => c.name === 'correlation_id')) {
    db.exec('ALTER TABLE request_logs ADD COLUMN correlation_id TEXT');
  }
  if (!reqCols.some(c => c.name === 'pc_issue_id')) {
    db.exec('ALTER TABLE request_logs ADD COLUMN pc_issue_id TEXT');
  }
  if (!reqCols.some(c => c.name === 'pc_agent_id')) {
    db.exec('ALTER TABLE request_logs ADD COLUMN pc_agent_id TEXT');
  }
  if (!reqCols.some(c => c.name === 'pc_company_id')) {
    db.exec('ALTER TABLE request_logs ADD COLUMN pc_company_id TEXT');
  }
  if (!reqCols.some(c => c.name === 'pc_priority')) {
    db.exec('ALTER TABLE request_logs ADD COLUMN pc_priority TEXT');
  }
  db.exec('CREATE INDEX IF NOT EXISTS idx_request_logs_user ON request_logs(user_id, id DESC)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_request_logs_timestamp ON request_logs(timestamp DESC)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_request_logs_correlation_id ON request_logs(correlation_id)');
  db.exec(`
    CREATE TABLE IF NOT EXISTS paperclip_assignment_outcomes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
      user_id TEXT NOT NULL DEFAULT 'default',
      issue_id TEXT NOT NULL,
      agent_id TEXT NOT NULL,
      task_class TEXT NOT NULL,
      success INTEGER NOT NULL DEFAULT 1,
      cost_usd REAL DEFAULT 0,
      duration_ms INTEGER DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS idx_pc_outcomes_agent_class
      ON paperclip_assignment_outcomes(task_class, agent_id);
  `);
}

export function getDb(): SqliteDb {
  const { dataDir } = getAppPaths('eluvix');
  const dbPath = path.join(dataDir, 'eluvix.db');

  if (dbInstance && dbInstancePath === dbPath) return dbInstance;

  if (!fs.existsSync(dataDir)) {
    fs.mkdirSync(dataDir, { recursive: true });
  }

  // Try native node:sqlite first (Node.js 22.8+ built-in, no binary addon issues)
  try {
    const sqliteModule = require('node:sqlite');
    if (sqliteModule && sqliteModule.DatabaseSync) {
      const db: SqliteDb = new sqliteModule.DatabaseSync(dbPath);
      db.exec('PRAGMA journal_mode = WAL;');
      // Contended writers (desktop server + Next.js dashboard both open
      // eluvix.db) must wait instead of failing instantly with SQLITE_BUSY
      // and silently dropping the write. 5000 ms matches the
      // better-sqlite3 fallback default.
      db.exec('PRAGMA busy_timeout = 5000;');
      initSchema(db);
      dbInstance = db;
      dbInstancePath = dbPath;
      return db;
    }
  } catch (err: any) {
    // node:sqlite not available or disabled, fall through to better-sqlite3
  }

  // Fallback to better-sqlite3
  try {
    const BetterSqlite = require('better-sqlite3');
    const db: SqliteDb = new BetterSqlite(dbPath);
    db.exec('PRAGMA journal_mode = WAL;');
    db.exec('PRAGMA busy_timeout = 5000;');
    initSchema(db);
    dbInstance = db;
    dbInstancePath = dbPath;
    return db;
  } catch (err: any) {
    console.error('[Eluvix DB] Failed to initialize SQLite backend:', err.message);
    throw err;
  }
}

export function logRequest(log: RequestLog) {
  try {
    const db = getDb();
    const stmt = db.prepare(`
      INSERT INTO request_logs (
        model, upstream_id, status, duration_ms, prompt_tokens, completion_tokens,
        cache_read_tokens, cache_write_tokens, ttft_ms, itl_ms, kv_cache_kb, cost_usd,
        user_id, correlation_id, pc_issue_id, pc_agent_id, pc_company_id, pc_priority
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    
    stmt.run(
      log.model,
      log.upstream_id,
      log.status,
      log.duration_ms,
      log.prompt_tokens || 0,
      log.completion_tokens || 0,
      log.cache_read_tokens || 0,
      log.cache_write_tokens || 0,
      log.ttft_ms ?? null,
      log.itl_ms ?? null,
      log.kv_cache_kb ?? null,
      typeof log.cost_usd === 'number' && Number.isFinite(log.cost_usd) ? log.cost_usd : 0,
      log.user_id || 'default',
      log.correlation_id ?? null,
      log.pc_issue_id ?? null,
      log.pc_agent_id ?? null,
      log.pc_company_id ?? null,
      log.pc_priority ?? null
    );
  } catch (err: any) {
    console.error('Failed to log request to DB:', err.message);
  }
}

export function getRollingSpendUsd(windowHours = 24, userId?: string): number {
  try {
    const db = getDb();
    const safeHours = Math.max(0.01, Number(windowHours) || 24);
    const modifier = `-${safeHours} hours`;
    if (userId) {
      const row = db
        .prepare(
          "SELECT COALESCE(SUM(cost_usd), 0) AS total FROM request_logs WHERE user_id = ? AND timestamp >= datetime('now', ?)"
        )
        .get(userId, modifier) as { total?: number } | undefined;
      return Number(Number(row?.total || 0).toFixed(6));
    }
    const row = db
      .prepare("SELECT COALESCE(SUM(cost_usd), 0) AS total FROM request_logs WHERE timestamp >= datetime('now', ?)")
      .get(modifier) as { total?: number } | undefined;
    return Number(Number(row?.total || 0).toFixed(6));
  } catch (err: any) {
    console.error('Failed to query rolling spend from DB:', err.message);
    return 0;
  }
}

export function getRequestLogs(limit = 50, userId?: string): RequestLog[] {
  try {
    const db = getDb();
    // Clamp like listHarnessSessions (1–200): the observability route passes
    // a user-controlled limit straight through, and SQLite LIMIT -1 means
    // "unlimited" — an unbounded row dump / memory-CPU DoS vector.
    const safeLimit = Number.isFinite(limit) ? Math.max(1, Math.min(200, Math.floor(limit))) : 50;
    if (userId) {
      return db
        .prepare('SELECT * FROM request_logs WHERE user_id = ? ORDER BY id DESC LIMIT ?')
        .all(userId, safeLimit) as RequestLog[];
    }
    return db.prepare('SELECT * FROM request_logs ORDER BY id DESC LIMIT ?').all(safeLimit) as RequestLog[];
  } catch (err: any) {
    console.error('Failed to query request logs from DB:', err.message);
    return [];
  }
}

export function saveChatMessage(
  sessionId: string,
  role: string,
  content: any,
  userId: string = 'default',
  metadata?: Record<string, any> | null
) {
  try {
    const db = getDb();
    const textContent = typeof content === 'string' ? content : JSON.stringify(content);
    const metaJson = metadata && Object.keys(metadata).length > 0 ? JSON.stringify(metadata) : null;
    const stmt = db.prepare(`
      INSERT INTO chat_history (session_id, user_id, role, content, metadata)
      VALUES (?, ?, ?, ?, ?)
    `);
    stmt.run(sessionId, userId, role, textContent, metaJson);
  } catch (err: any) {
    console.error('Failed to log chat message:', err.message);
  }
}

export function getChatHistory(sessionId: string, userId: string = 'default'): any[] {
  try {
    const db = getDb();
    const rows = db
      .prepare('SELECT role, content, timestamp, metadata FROM chat_history WHERE session_id = ? AND user_id = ? ORDER BY id ASC')
      .all(sessionId, userId) as Array<{ role: string; content: string; timestamp: string; metadata?: string | null }>;
    return rows.map((row) => {
      let parsedMeta: any = undefined;
      if (row.metadata) {
        try {
          parsedMeta = JSON.parse(row.metadata);
        } catch {}
      }
      return parsedMeta !== undefined
        ? { role: row.role, content: row.content, timestamp: row.timestamp, metadata: parsedMeta }
        : { role: row.role, content: row.content, timestamp: row.timestamp };
    });
  } catch (err: any) {
    console.error('Failed to get chat history:', err.message);
    return [];
  }
}

export function getChatSessions(userId: string = 'default'): any[] {
  try {
    const db = getDb();
    return db.prepare('SELECT session_id, MAX(timestamp) as last_updated, COUNT(id) as message_count FROM chat_history WHERE user_id = ? GROUP BY session_id ORDER BY last_updated DESC LIMIT 50').all(userId);
  } catch (err: any) {
    console.error('Failed to get chat sessions:', err.message);
    return [];
  }
}

export interface HarnessSessionRecord {
  session_id: string;
  user_id: string;
  title: string;
  harness_kind: string;
  agent_id: string;
  node_id?: string | null;
  endpoint?: string | null;
  kv_prefix_hash?: string | null;
  last_tier?: string | null;
  redaction_count: number;
  injection_count: number;
  message_count?: number;
  created_at: string;
  updated_at: string;
}

export interface HarnessSessionUpsertInput {
  sessionId: string;
  userId?: string;
  title?: string;
  harnessKind?: string;
  agentId?: string;
  nodeId?: string | null;
  endpoint?: string | null;
  kvPrefixHash?: string | null;
  lastTier?: string | null;
  redactionDelta?: number;
  injectionDelta?: number;
}

export function upsertHarnessSession(input: HarnessSessionUpsertInput): HarnessSessionRecord | null {
  try {
    const db = getDb();
    const userId = input.userId || 'default';

    db.exec('BEGIN IMMEDIATE');
    try {
      const existing = db
        .prepare('SELECT * FROM harness_sessions WHERE user_id = ? AND session_id = ?')
        .get(userId, input.sessionId) as HarnessSessionRecord | undefined;

      const title =
        input.title && input.title.trim().length > 0
          ? input.title.trim().slice(0, 120)
          : existing?.title || 'Untitled Harness Session';
      const harnessKind = input.harnessKind || existing?.harness_kind || 'opencode';
      const agentId = input.agentId || existing?.agent_id || 'build';
      const nodeId = input.nodeId !== undefined ? input.nodeId : existing?.node_id ?? null;
      const endpoint = input.endpoint !== undefined ? input.endpoint : existing?.endpoint ?? null;
      const kvPrefixHash = input.kvPrefixHash || existing?.kv_prefix_hash || null;
      const lastTier = input.lastTier || existing?.last_tier || null;
      const redactionCount = (existing?.redaction_count || 0) + (input.redactionDelta || 0);
      const injectionCount = (existing?.injection_count || 0) + (input.injectionDelta || 0);

      if (existing) {
        db.prepare(`
          UPDATE harness_sessions
          SET title = ?,
              harness_kind = ?,
              agent_id = ?,
              node_id = ?,
              endpoint = ?,
              kv_prefix_hash = ?,
              last_tier = ?,
              redaction_count = ?,
              injection_count = ?,
              updated_at = CURRENT_TIMESTAMP
          WHERE user_id = ? AND session_id = ?
        `).run(
          title,
          harnessKind,
          agentId,
          nodeId,
          endpoint,
          kvPrefixHash,
          lastTier,
          redactionCount,
          injectionCount,
          userId,
          input.sessionId
        );
      } else {
        db.prepare(`
          INSERT INTO harness_sessions (
            session_id, user_id, title, harness_kind, agent_id,
            node_id, endpoint, kv_prefix_hash, last_tier, redaction_count, injection_count
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          input.sessionId,
          userId,
          title,
          harnessKind,
          agentId,
          nodeId,
          endpoint,
          kvPrefixHash,
          lastTier,
          redactionCount,
          injectionCount
        );
      }
      db.exec('COMMIT');
    } catch (txnErr) {
      try {
        db.exec('ROLLBACK');
      } catch {}
      throw txnErr;
    }
    return getHarnessSession(input.sessionId, userId);
  } catch (err: any) {
    console.error('Failed to upsert harness session:', err.message);
    return null;
  }
}

export function getHarnessSession(sessionId: string, userId: string = 'default'): HarnessSessionRecord | null {
  try {
    const db = getDb();
    const row = db
      .prepare(`
        SELECT hs.*,
               (SELECT COUNT(id) FROM chat_history ch WHERE ch.user_id = hs.user_id AND ch.session_id = hs.session_id) AS message_count
        FROM harness_sessions hs
        WHERE hs.user_id = ? AND hs.session_id = ?
      `)
      .get(userId, sessionId) as HarnessSessionRecord | undefined;
    return row || null;
  } catch (err: any) {
    console.error('Failed to get harness session:', err.message);
    return null;
  }
}

export function listHarnessSessions(
  userId: string = 'default',
  filter?: { harnessKind?: string; search?: string; limit?: number }
): HarnessSessionRecord[] {
  try {
    const db = getDb();
    const limit = Math.max(1, Math.min(200, filter?.limit ?? 60));

    const conditions: string[] = ['hs.user_id = ?'];
    const params: any[] = [userId];

    if (filter?.harnessKind && filter.harnessKind !== 'all') {
      conditions.push('hs.harness_kind = ?');
      params.push(filter.harnessKind);
    }
    if (filter?.search && filter.search.trim().length > 0) {
      const escaped = filter.search.trim().replace(/[\\%_]/g, '\\$&');
      const q = `%${escaped}%`;
      conditions.push("(hs.title LIKE ? ESCAPE '\\' OR hs.session_id LIKE ? ESCAPE '\\' OR hs.agent_id LIKE ? ESCAPE '\\')");
      params.push(q, q, q);
    }

    params.push(limit);

    const sql = `
      SELECT hs.*,
             (SELECT COUNT(id) FROM chat_history ch WHERE ch.user_id = hs.user_id AND ch.session_id = hs.session_id) AS message_count
      FROM harness_sessions hs
      WHERE ${conditions.join(' AND ')}
      ORDER BY hs.updated_at DESC, hs.created_at DESC
      LIMIT ?
    `;
    const stored = db.prepare(sql).all(...params) as HarnessSessionRecord[];

    // Legacy chat_history sessions with no harness_sessions row are
    // synthesized in memory instead of upserted: a list call must not
    // write. The synthesized records apply the same filters the SQL
    // applied to stored rows, then merge, sort, and honor the limit.
    const storedIds = new Set(stored.map(r => r.session_id));
    const searchNeedle = filter?.search?.trim().toLowerCase() || '';
    const legacy: HarnessSessionRecord[] = [];
    for (const s of getChatSessions(userId)) {
      if (!s?.session_id || storedIds.has(s.session_id)) continue;
      if (filter?.harnessKind && filter.harnessKind !== 'all' && filter.harnessKind !== 'opencode') continue;
      const firstMsg = db
        .prepare('SELECT content FROM chat_history WHERE user_id = ? AND session_id = ? ORDER BY id ASC LIMIT 1')
        .get(userId, s.session_id) as { content?: string } | undefined;
      const title = firstMsg?.content
        ? String(firstMsg.content).replace(/\s+/g, ' ').trim().slice(0, 64) || `Session ${String(s.session_id).slice(0, 8)}`
        : `Session ${String(s.session_id).slice(0, 8)}`;
      const record: HarnessSessionRecord = {
        session_id: s.session_id,
        user_id: userId,
        title,
        harness_kind: 'opencode',
        agent_id: 'build',
        redaction_count: 0,
        injection_count: 0,
        message_count: Number(s.message_count || 0),
        created_at: String(s.last_updated || ''),
        updated_at: String(s.last_updated || ''),
      };
      if (searchNeedle) {
        const hay = `${record.title} ${record.session_id} ${record.agent_id}`.toLowerCase();
        if (!hay.includes(searchNeedle)) continue;
      }
      legacy.push(record);
    }
    const merged = [...stored, ...legacy].sort((a, b) =>
      String(b.updated_at).localeCompare(String(a.updated_at)) ||
      String(b.created_at).localeCompare(String(a.created_at)));
    return merged.slice(0, limit);
  } catch (err: any) {
    console.error('Failed to list harness sessions:', err.message);
    return [];
  }
}

export function deleteHarnessSession(sessionId: string, userId: string = 'default'): boolean {
  try {
    const db = getDb();
    db.prepare('DELETE FROM chat_history WHERE user_id = ? AND session_id = ?').run(userId, sessionId);
    db.prepare('DELETE FROM harness_sessions WHERE user_id = ? AND session_id = ?').run(userId, sessionId);
    return true;
  } catch (err: any) {
    console.error('Failed to delete harness session:', err.message);
    return false;
  }
}

export interface ProviderDbSettings {
  id: number;
  enabled: number;
  server_url: string;
  node_token?: string;
  node_id?: string;
  node_name?: string;
  engine_url: string;
  engine_type: string;
  pricing_mode: string;
  floor_price_in: number;
  floor_price_out: number;
  pause_on_user_active: number;
  max_gpu_temp_c: number;
  max_concurrency: number;
  total_jobs_completed: number;
  total_tokens_served: number;
  total_earned_usd: number;
  reputation_score: number;
  last_heartbeat_at?: string;
}

export function getProviderSettings(): ProviderDbSettings | null {
  try {
    const db = getDb();
    const row = db.prepare('SELECT * FROM provider_settings WHERE id = 1').get() as ProviderDbSettings | undefined;
    return row || null;
  } catch (err) {
    console.error('Failed to get provider settings:', err);
    return null;
  }
}

export function saveProviderSettings(updates: Partial<ProviderDbSettings>): ProviderDbSettings | null {
  try {
    const db = getDb();
    const current = getProviderSettings();
    const merged = { ...current, ...updates, id: 1 };
    
    const stmt = db.prepare(`
      INSERT OR REPLACE INTO provider_settings (
        id, enabled, server_url, node_token, node_id, node_name,
        engine_url, engine_type, pricing_mode, floor_price_in, floor_price_out,
        pause_on_user_active, max_gpu_temp_c, max_concurrency,
        total_jobs_completed, total_tokens_served, total_earned_usd,
        reputation_score, last_heartbeat_at
      ) VALUES (
        @id, @enabled, @server_url, @node_token, @node_id, @node_name,
        @engine_url, @engine_type, @pricing_mode, @floor_price_in, @floor_price_out,
        @pause_on_user_active, @max_gpu_temp_c, @max_concurrency,
        @total_jobs_completed, @total_tokens_served, @total_earned_usd,
        @reputation_score, @last_heartbeat_at
      )
    `);

    stmt.run({
      id: 1,
      enabled: merged.enabled ?? 0,
      server_url: merged.server_url || 'https://api.billama.dev',
      node_token: merged.node_token || null,
      node_id: merged.node_id || null,
      node_name: merged.node_name || null,
      engine_url: merged.engine_url || 'http://localhost:11434',
      engine_type: merged.engine_type || 'ollama',
      pricing_mode: merged.pricing_mode || 'market',
      floor_price_in: merged.floor_price_in ?? 0,
      floor_price_out: merged.floor_price_out ?? 0,
      pause_on_user_active: merged.pause_on_user_active ?? 1,
      max_gpu_temp_c: merged.max_gpu_temp_c ?? 82,
      max_concurrency: merged.max_concurrency ?? 1,
      total_jobs_completed: merged.total_jobs_completed ?? 0,
      total_tokens_served: merged.total_tokens_served ?? 0,
      total_earned_usd: merged.total_earned_usd ?? 0.0,
      reputation_score: merged.reputation_score ?? 100.0,
      last_heartbeat_at: merged.last_heartbeat_at || null
    });

    return getProviderSettings();
  } catch (err) {
    console.error('Failed to save provider settings:', err);
    return null;
  }
}

export function logProviderJob(log: {
  job_id: string;
  model: string;
  prompt_tokens?: number;
  completion_tokens?: number;
  duration_ms?: number;
  earned_usd?: number;
  status: string;
  error_message?: string;
}) {
  try {
    const db = getDb();
    const stmt = db.prepare(`
      INSERT INTO provider_job_logs (job_id, model, prompt_tokens, completion_tokens, duration_ms, earned_usd, status, error_message)
      VALUES (@job_id, @model, @prompt_tokens, @completion_tokens, @duration_ms, @earned_usd, @status, @error_message)
    `);
    
    stmt.run({
      job_id: log.job_id,
      model: log.model,
      prompt_tokens: log.prompt_tokens || 0,
      completion_tokens: log.completion_tokens || 0,
      duration_ms: log.duration_ms || 0,
      earned_usd: log.earned_usd || 0.0,
      status: log.status,
      error_message: log.error_message || null
    });

    // Automatically update cumulative totals in provider_settings
    if (log.status === 'SUCCESS') {
      const addedTokens = (log.prompt_tokens || 0) + (log.completion_tokens || 0);
      const addedEarned = log.earned_usd || 0.0;
      db.prepare(`
        UPDATE provider_settings
        SET total_jobs_completed = total_jobs_completed + 1,
            total_tokens_served = total_tokens_served + ?,
            total_earned_usd = total_earned_usd + ?
        WHERE id = 1
      `).run(addedTokens, addedEarned);
    }
  } catch (err) {
    console.error('Failed to log provider job:', err);
  }
}

export function getProviderJobLogs(limit = 50): any[] {
  try {
    const db = getDb();
    return db.prepare('SELECT * FROM provider_job_logs ORDER BY id DESC LIMIT ?').all(limit);
  } catch (err) {
    console.error('Failed to get provider job logs:', err);
    return [];
  }
}

export interface MemoryDbItem {
  id: number;
  user_id: string;
  session_id?: string | null;
  uri?: string | null;
  level: 'L0' | 'L1' | 'L2';
  content: string;
  metadata?: string | null;
  created_at: string;
  score?: number;
}

export function addMemoryItem(item: {
  userId?: string;
  sessionId?: string;
  uri?: string;
  level?: 'L0' | 'L1' | 'L2';
  content: string;
  metadata?: Record<string, any>;
}): MemoryDbItem | null {
  try {
    const db = getDb();
    const userId = item.userId || 'default';
    const level = item.level || 'L1';
    // Date.now() alone collides for two writes in the same millisecond; the
    // random suffix makes the default URI unique per write.
    const uri = item.uri || `viking://user/${userId}/memories/${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
    const metaStr = item.metadata ? JSON.stringify(item.metadata) : null;

    const stmt = db.prepare(`
      INSERT INTO memory_items (user_id, session_id, uri, level, content, metadata)
      VALUES (?, ?, ?, ?, ?, ?)
    `);
    const info = stmt.run(userId, item.sessionId || null, uri, level, item.content, metaStr);
    const insertedId = Number(info?.lastInsertRowid || 0);
    if (insertedId > 0) {
      return db.prepare('SELECT * FROM memory_items WHERE id = ?').get(insertedId) as MemoryDbItem;
    }
    return {
      id: insertedId,
      user_id: userId,
      session_id: item.sessionId || null,
      uri,
      level,
      content: item.content,
      metadata: metaStr,
      created_at: new Date().toISOString()
    };
  } catch (err: any) {
    console.error('Failed to add memory item:', err.message);
    return null;
  }
}

const STOP_WORDS = new Set([
  'the', 'a', 'an', 'and', 'or', 'but', 'in', 'on', 'at', 'to', 'for', 'of', 'with',
  'by', 'is', 'are', 'was', 'were', 'be', 'been', 'being', 'it', 'this', 'that',
  'what', 'which', 'who', 'whom', 'how', 'when', 'where', 'why', 'do', 'does', 'did',
  'can', 'could', 'will', 'would', 'should', 'my', 'your', 'me', 'you', 'i', 'we'
]);

// CJK ranges: CJK Unified Ideographs (+Ext A), Hiragana, Katakana, Hangul.
const CJK_RE = /[\u3400-\u9FFF\uF900-\uFAFF\u3040-\u30FF\uAC00-\uD7AF]/;
const CJK_SEGMENT_RE = /[\u3400-\u9FFF\uF900-\uFAFF\u3040-\u30FF\uAC00-\uD7AF]+|[^\u3400-\u9FFF\uF900-\uFAFF\u3040-\u30FF\uAC00-\uD7AF]+/g;

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function tokenizeForSearch(text: string): string[] {
  // Keep all Unicode letters/marks/numbers (not just ASCII): the old
  // [^a-z0-9] strip turned every CJK query into zero tokens, so recall
  // silently returned [] for Chinese/Japanese/Korean. CJK runs carry no
  // spaces, so split them into individual characters — otherwise a query
  // token only matches content containing the exact same run.
  const normalized = text
    .toLowerCase()
    .replace(/[^\p{L}\p{M}\p{N}_\- \s\p{Extended_Pictographic}]/gu, ' ');
  const tokens: string[] = [];
  for (const raw of normalized.split(/\s+/).filter(Boolean)) {
    if (CJK_RE.test(raw)) {
      for (const seg of raw.match(CJK_SEGMENT_RE) || []) {
        if (CJK_RE.test(seg[0])) {
          for (const ch of seg) tokens.push(ch);
        } else if (seg.length >= 2 && !STOP_WORDS.has(seg)) {
          tokens.push(seg);
        }
      }
    } else if (raw.length >= 2 && !STOP_WORDS.has(raw)) {
      tokens.push(raw);
    } else if (/^\p{Extended_Pictographic}$/u.test(raw)) {
      tokens.push(raw);
    }
  }
  return tokens;
}

export function searchMemoryItems(
  query: string,
  userId = 'default',
  limit = 8
): MemoryDbItem[] {
  try {
    const db = getDb();
    const candidates = db
      .prepare('SELECT * FROM memory_items WHERE user_id = ? ORDER BY id DESC LIMIT 1000')
      .all(userId) as MemoryDbItem[];

    if (candidates.length === 0) return [];

    const queryTokens = tokenizeForSearch(query);
    if (queryTokens.length === 0) {
      // A query with no searchable tokens (e.g. stop-word-only small talk
      // like "how are you") has no relevance signal. Returning the most
      // recent items scored 0.5 would inject unrelated memories into the
      // prompt and memory-taint the request, so return nothing.
      return [];
    }

    // Score each candidate by token overlap + phrase match + slight recency bonus
    const scored = candidates.map((item, idx) => {
      const contentLower = item.content.toLowerCase();
      const docTokens = new Set(tokenizeForSearch(item.content));
      let matches = 0;
      for (const qt of queryTokens) {
        // Substring fallback must be word-boundary aware: the old bare
        // includes() let "art" match "start"/"heart" and inject unrelated
        // memories. A match counts only at a token boundary (start of
        // content or after a non-word character), which still covers
        // hyphenated words ("quantum" in "quantum-computing").
        const boundaryMatch = new RegExp(`(^|[^\\p{L}\\p{N}_-])${escapeRegExp(qt)}`, 'u').test(contentLower);
        if (docTokens.has(qt) || boundaryMatch) {
          matches += 1;
        }
      }
      if (matches === 0) {
        return { item, score: 0 };
      }
      const coverage = matches / queryTokens.length;
      const recencyBonus = Math.max(0, 0.15 * (1 - idx / candidates.length));
      const score = Number(Math.min(1, coverage * 0.85 + recencyBonus).toFixed(3));
      return { item: { ...item, score }, score };
    });

    return scored
      .filter(s => s.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, limit)
      .map(s => s.item);
  } catch (err: any) {
    console.error('Failed to search memory items:', err.message);
    return [];
  }
}

export function listMemoryItems(userId = 'default', limit = 50): MemoryDbItem[] {
  try {
    const db = getDb();
    return db
      .prepare('SELECT * FROM memory_items WHERE user_id = ? ORDER BY id DESC LIMIT ?')
      .all(userId, limit) as MemoryDbItem[];
  } catch (err: any) {
    console.error('Failed to list memory items:', err.message);
    return [];
  }
}

export function deleteMemoryItem(id: number, userId: string): boolean {
  try {
    const db = getDb();
    // userId is required (security audit S-8): an unscoped delete-by-id
    // overload is an IDOR footgun for any future caller, so there is no
    // way to express one.
    const res = db.prepare('DELETE FROM memory_items WHERE id = ? AND user_id = ?').run(id, userId);
    return Number(res?.changes || 0) > 0;
  } catch (err: any) {
    console.error('Failed to delete memory item:', err.message);
    return false;
  }
}

export function clearUserMemories(userId = 'default'): number {
  try {
    const db = getDb();
    const res = db.prepare('DELETE FROM memory_items WHERE user_id = ?').run(userId);
    return Number(res?.changes || 0);
  } catch (err: any) {
    console.error('Failed to clear user memories:', err.message);
    return 0;
  }
}

export interface StoredResponseRecord {
  id: string;
  user_id: string;
  previous_response_id: string | null;
  model: string;
  messages: Array<Record<string, any>>;
  response: Record<string, any>;
  created_at: string;
}

export function saveStoredResponse(input: {
  id: string;
  userId?: string;
  previousResponseId?: string | null;
  model: string;
  messages: Array<Record<string, any>>;
  response: Record<string, any>;
}): boolean {
  try {
    const db = getDb();
    const userId = input.userId || 'default';
    db.prepare(`
      INSERT OR REPLACE INTO response_store (
        id, user_id, previous_response_id, model, messages_json, response_json
      ) VALUES (?, ?, ?, ?, ?, ?)
    `).run(
      input.id,
      userId,
      input.previousResponseId ?? null,
      input.model || 'auto',
      JSON.stringify(input.messages || []),
      JSON.stringify(input.response || {})
    );
    return true;
  } catch (err: any) {
    console.error('Failed to save stored response:', err.message);
    return false;
  }
}

export function getStoredResponse(
  id: string,
  userId = 'default'
): StoredResponseRecord | null {
  try {
    const db = getDb();
    const row = db
      .prepare('SELECT * FROM response_store WHERE id = ? AND user_id = ?')
      .get(id, userId) as
      | {
          id: string;
          user_id: string;
          previous_response_id: string | null;
          model: string;
          messages_json: string;
          response_json: string;
          created_at: string;
        }
      | undefined;
    if (!row) return null;
    let messages: Array<Record<string, any>> = [];
    let response: Record<string, any> = {};
    try {
      messages = JSON.parse(row.messages_json);
    } catch {}
    try {
      response = JSON.parse(row.response_json);
    } catch {}
    return {
      id: row.id,
      user_id: row.user_id,
      previous_response_id: row.previous_response_id,
      model: row.model,
      messages,
      response,
      created_at: row.created_at,
    };
  } catch (err: any) {
    console.error('Failed to get stored response:', err.message);
    return null;
  }
}

export function deleteStoredResponse(id: string, userId = 'default'): boolean {
  try {
    const db = getDb();
    const res = db
      .prepare('DELETE FROM response_store WHERE id = ? AND user_id = ?')
      .run(id, userId);
    return Number(res?.changes || 0) > 0;
  } catch (err: any) {
    console.error('Failed to delete stored response:', err.message);
    return false;
  }
}

function mapBanditArmRow(row: any): BanditArmStats {
  return {
    armKey: row.arm_key,
    upstreamId: row.upstream_id,
    complexityTier: row.complexity_tier,
    alpha: Number(row.alpha ?? 2.0),
    beta: Number(row.beta ?? 1.0),
    ewmaTtftMs: row.ewma_ttft_ms != null ? Number(row.ewma_ttft_ms) : null,
    ewmaItlMs: row.ewma_itl_ms != null ? Number(row.ewma_itl_ms) : null,
    totalPulls: Number(row.total_pulls ?? 0),
    updatedAt: row.updated_at,
  };
}

export function getBanditArmsForTier(complexityTier: string): BanditArmStats[] {
  try {
    const db = getDb();
    const rows = db
      .prepare('SELECT * FROM bandit_arms WHERE complexity_tier = ? ORDER BY total_pulls DESC')
      .all(complexityTier);
    return rows.map(mapBanditArmRow);
  } catch (err: any) {
    console.error('Failed to query bandit arms:', err.message);
    return [];
  }
}

export function listBanditArms(): BanditArmStats[] {
  try {
    const db = getDb();
    const rows = db
      .prepare('SELECT * FROM bandit_arms ORDER BY complexity_tier ASC, alpha / (alpha + beta) DESC')
      .all();
    return rows.map(mapBanditArmRow);
  } catch (err: any) {
    console.error('Failed to list bandit arms:', err.message);
    return [];
  }
}

export function recordBanditArmOutcome(input: {
  upstreamId: string;
  complexityTier: string;
  success: boolean;
  weight?: number;
  ttftMs?: number;
  itlMs?: number;
  decayFactor?: number;
}): BanditArmStats | null {
  try {
    const db = getDb();
    const tier = input.complexityTier || 'simple';
    const armKey = `${input.upstreamId}::${tier}`;
    const weight = Math.max(0.1, Number.isFinite(input.weight) ? Number(input.weight) : 1.0);
    // Exponential forgetting toward baseline Beta(1, 1) so previously degraded nodes recover
    const decay = Math.max(0.8, Math.min(1.0, input.decayFactor ?? 0.985));

    const existing = db
      .prepare('SELECT * FROM bandit_arms WHERE arm_key = ?')
      .get(armKey) as any;

    const prevAlpha = existing ? Number(existing.alpha ?? 2.0) : 2.0;
    const prevBeta = existing ? Number(existing.beta ?? 1.0) : 1.0;
    const decayedAlpha = 1.0 + (prevAlpha - 1.0) * decay;
    const decayedBeta = 1.0 + (prevBeta - 1.0) * decay;

    const nextAlpha = Number((decayedAlpha + (input.success ? weight : 0)).toFixed(4));
    const nextBeta = Number((decayedBeta + (input.success ? 0 : weight)).toFixed(4));

    let nextEwmaTtft: number | null =
      existing?.ewma_ttft_ms != null ? Number(existing.ewma_ttft_ms) : null;
    if (typeof input.ttftMs === 'number' && Number.isFinite(input.ttftMs) && input.ttftMs >= 0) {
      nextEwmaTtft =
        nextEwmaTtft == null
          ? input.ttftMs
          : Number((0.75 * nextEwmaTtft + 0.25 * input.ttftMs).toFixed(2));
    }

    let nextEwmaItl: number | null =
      existing?.ewma_itl_ms != null ? Number(existing.ewma_itl_ms) : null;
    if (typeof input.itlMs === 'number' && Number.isFinite(input.itlMs) && input.itlMs >= 0) {
      nextEwmaItl =
        nextEwmaItl == null
          ? input.itlMs
          : Number((0.75 * nextEwmaItl + 0.25 * input.itlMs).toFixed(2));
    }

    const nextPulls = (existing ? Number(existing.total_pulls ?? 0) : 0) + 1;

    db.prepare(`
      INSERT INTO bandit_arms (
        arm_key, upstream_id, complexity_tier, alpha, beta, ewma_ttft_ms, ewma_itl_ms, total_pulls, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
      ON CONFLICT(arm_key) DO UPDATE SET
        alpha = excluded.alpha,
        beta = excluded.beta,
        ewma_ttft_ms = excluded.ewma_ttft_ms,
        ewma_itl_ms = excluded.ewma_itl_ms,
        total_pulls = excluded.total_pulls,
        updated_at = CURRENT_TIMESTAMP
    `).run(
      armKey,
      input.upstreamId,
      tier,
      nextAlpha,
      nextBeta,
      nextEwmaTtft,
      nextEwmaItl,
      nextPulls
    );

    const updated = db.prepare('SELECT * FROM bandit_arms WHERE arm_key = ?').get(armKey);
    return updated ? mapBanditArmRow(updated) : null;
  } catch (err: any) {
    console.error('Failed to record bandit arm outcome:', err.message);
    return null;
  }
}

export interface DistillationPairRecord {
  id: string;
  user_id: string;
  source: 'shadow' | 'cascade-escalation' | 'arena-vote';
  teacher_upstream_id: string;
  student_upstream_id: string;
  teacher_model: string;
  student_model: string;
  prompt_messages: Array<Record<string, any>>;
  chosen_text: string;
  rejected_text: string;
  judge_score: number;
  privacy_scrubbed: boolean;
  created_at: string;
}

export function saveDistillationPair(input: {
  id?: string;
  userId?: string;
  source?: 'shadow' | 'cascade-escalation' | 'arena-vote';
  teacherUpstreamId: string;
  studentUpstreamId: string;
  teacherModel: string;
  studentModel: string;
  promptMessages: Array<Record<string, any>>;
  chosenText: string;
  rejectedText: string;
  judgeScore?: number;
  privacyScrubbed?: boolean;
}): DistillationPairRecord | null {
  try {
    const db = getDb();
    const id = input.id || `distill_${crypto.randomBytes(10).toString('hex')}`;
    const userId = input.userId || 'default';
    const source = input.source || 'shadow';
    const judgeScore =
      typeof input.judgeScore === 'number' && Number.isFinite(input.judgeScore)
        ? Number(Math.max(0, Math.min(1, input.judgeScore)).toFixed(4))
        : 1.0;
    const privacyScrubbed = input.privacyScrubbed !== false ? 1 : 0;

    db.prepare(`
      INSERT OR REPLACE INTO distillation_pairs (
        id, user_id, source, teacher_upstream_id, student_upstream_id,
        teacher_model, student_model, prompt_messages_json,
        chosen_text, rejected_text, judge_score, privacy_scrubbed
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id,
      userId,
      source,
      input.teacherUpstreamId,
      input.studentUpstreamId,
      input.teacherModel || 'auto',
      input.studentModel || 'auto',
      JSON.stringify(input.promptMessages || []),
      input.chosenText || '',
      input.rejectedText || '',
      judgeScore,
      privacyScrubbed
    );

    const row = db
      .prepare('SELECT * FROM distillation_pairs WHERE user_id = ? AND id = ?')
      .get(userId, id) as any;
    if (!row) return null;
    let promptMessages: Array<Record<string, any>> = [];
    try {
      promptMessages = JSON.parse(row.prompt_messages_json);
    } catch {}
    return {
      id: row.id,
      user_id: row.user_id,
      source: row.source,
      teacher_upstream_id: row.teacher_upstream_id,
      student_upstream_id: row.student_upstream_id,
      teacher_model: row.teacher_model,
      student_model: row.student_model,
      prompt_messages: promptMessages,
      chosen_text: row.chosen_text,
      rejected_text: row.rejected_text,
      judge_score: Number(row.judge_score ?? 1.0),
      privacy_scrubbed: Boolean(row.privacy_scrubbed),
      created_at: row.created_at,
    };
  } catch (err: any) {
    console.error('Failed to save distillation pair:', err.message);
    return null;
  }
}

export function listDistillationPairs(
  userId = 'default',
  options?: { minScore?: number; limit?: number; source?: string }
): DistillationPairRecord[] {
  try {
    const db = getDb();
    const minScore =
      typeof options?.minScore === 'number' && Number.isFinite(options.minScore)
        ? options.minScore
        : 0;
    const limit = Math.max(1, Math.min(5000, options?.limit ?? 500));

    const rows = options?.source
      ? (db
          .prepare(
            'SELECT * FROM distillation_pairs WHERE user_id = ? AND judge_score >= ? AND source = ? ORDER BY created_at DESC LIMIT ?'
          )
          .all(userId, minScore, options.source, limit) as any[])
      : (db
          .prepare(
            'SELECT * FROM distillation_pairs WHERE user_id = ? AND judge_score >= ? ORDER BY created_at DESC LIMIT ?'
          )
          .all(userId, minScore, limit) as any[]);

    return rows.map((row) => {
      let promptMessages: Array<Record<string, any>> = [];
      try {
        promptMessages = JSON.parse(row.prompt_messages_json);
      } catch {}
      return {
        id: row.id,
        user_id: row.user_id,
        source: row.source,
        teacher_upstream_id: row.teacher_upstream_id,
        student_upstream_id: row.student_upstream_id,
        teacher_model: row.teacher_model,
        student_model: row.student_model,
        prompt_messages: promptMessages,
        chosen_text: row.chosen_text,
        rejected_text: row.rejected_text,
        judge_score: Number(row.judge_score ?? 1.0),
        privacy_scrubbed: Boolean(row.privacy_scrubbed),
        created_at: row.created_at,
      };
    });
  } catch (err: any) {
    console.error('Failed to list distillation pairs:', err.message);
    return [];
  }
}


