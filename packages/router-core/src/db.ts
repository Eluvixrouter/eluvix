import path from 'node:path';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import { getAppPaths } from './paths.js';

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
  ttft_ms?: number;
  itl_ms?: number;
  kv_cache_kb?: number;
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
      ttft_ms INTEGER,
      itl_ms REAL,
      kv_cache_kb REAL
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
  `);

  // Migration for databases created before chat_history carried a user
  // dimension: add user_id (existing rows take the column default,
  // 'default' — the admin's partition, which is who wrote them) and index
  // the (user_id, session_id) lookup the history queries now perform.
  const chatCols = db.prepare('PRAGMA table_info(chat_history)').all() as Array<{ name: string }>;
  if (!chatCols.some(c => c.name === 'user_id')) {
    db.exec("ALTER TABLE chat_history ADD COLUMN user_id TEXT NOT NULL DEFAULT 'default'");
  }
  db.exec('CREATE INDEX IF NOT EXISTS idx_chat_history_user_session ON chat_history(user_id, session_id, id)');

  // Migration for request_logs: add ttft_ms, itl_ms, and kv_cache_kb columns for disaggregated serving telemetry
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
}

export function getDb(): SqliteDb {
  if (dbInstance) return dbInstance;

  const { dataDir } = getAppPaths('eluvix');

  if (!fs.existsSync(dataDir)) {
    fs.mkdirSync(dataDir, { recursive: true });
  }

  const dbPath = path.join(dataDir, 'eluvix.db');

  // Try native node:sqlite first (Node.js 22.8+ built-in, no binary addon issues)
  try {
    const sqliteModule = require('node:sqlite');
    if (sqliteModule && sqliteModule.DatabaseSync) {
      const db: SqliteDb = new sqliteModule.DatabaseSync(dbPath);
      db.exec('PRAGMA journal_mode = WAL;');
      initSchema(db);
      dbInstance = db;
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
    initSchema(db);
    dbInstance = db;
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
      INSERT INTO request_logs (model, upstream_id, status, duration_ms, prompt_tokens, completion_tokens, ttft_ms, itl_ms, kv_cache_kb)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    
    stmt.run(
      log.model,
      log.upstream_id,
      log.status,
      log.duration_ms,
      log.prompt_tokens || 0,
      log.completion_tokens || 0,
      log.ttft_ms ?? null,
      log.itl_ms ?? null,
      log.kv_cache_kb ?? null
    );
  } catch (err: any) {
    console.error('Failed to log request to DB:', err.message);
  }
}

export function getRequestLogs(limit = 50): RequestLog[] {
  try {
    const db = getDb();
    return db.prepare('SELECT * FROM request_logs ORDER BY id DESC LIMIT ?').all(limit) as RequestLog[];
  } catch (err: any) {
    console.error('Failed to query request logs from DB:', err.message);
    return [];
  }
}

export function saveChatMessage(sessionId: string, role: string, content: any, userId: string = 'default') {
  try {
    const db = getDb();
    const textContent = typeof content === 'string' ? content : JSON.stringify(content);
    const stmt = db.prepare(`
      INSERT INTO chat_history (session_id, user_id, role, content)
      VALUES (?, ?, ?, ?)
    `);
    stmt.run(sessionId, userId, role, textContent);
  } catch (err: any) {
    console.error('Failed to log chat message:', err.message);
  }
}

export function getChatHistory(sessionId: string, userId: string = 'default'): any[] {
  try {
    const db = getDb();
    return db.prepare('SELECT role, content, timestamp FROM chat_history WHERE session_id = ? AND user_id = ? ORDER BY id ASC').all(sessionId, userId);
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
    const uri = item.uri || `viking://user/${userId}/memories/${Date.now()}`;
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

function tokenizeForSearch(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9_\-\s]/g, ' ')
    .split(/\s+/)
    .filter(t => t.length >= 2 && !STOP_WORDS.has(t));
}

export function searchMemoryItems(
  query: string,
  userId = 'default',
  limit = 8
): MemoryDbItem[] {
  try {
    const db = getDb();
    const candidates = db
      .prepare('SELECT * FROM memory_items WHERE user_id = ? ORDER BY id DESC LIMIT 250')
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
        if (docTokens.has(qt) || contentLower.includes(qt)) {
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

