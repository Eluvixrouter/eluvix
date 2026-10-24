import { describe, it, expect, beforeAll } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

/**
 * Security remediation Tier 3 — chat_history user scoping (L-2 + S-1).
 *
 * chat_history gains a user_id dimension: a migration adds the column
 * (pre-existing rows land in the admin's 'default' partition), writes
 * record the writer's identity, and reads filter by the caller's. The
 * S-1 settling question — can two key holders who share one session_id
 * read each other's history? — is answered by the scoping test below:
 * no, each identity sees only its own rows.
 *
 * The legacy-schema database is seeded BEFORE the first getDb() call in
 * this worker (dynamic imports only), so initSchema runs its migration
 * against a genuinely pre-column table.
 */

type DbModule = typeof import('../db.js');
let db: DbModule;

beforeAll(async () => {
  const dataHome = process.env.XDG_DATA_HOME;
  if (!dataHome) throw new Error('XDG_DATA_HOME not set by test setup');
  const dbDir = path.join(dataHome, 'eluvix');
  fs.mkdirSync(dbDir, { recursive: true });
  const dbPath = path.join(dbDir, 'eluvix.db');

  const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite');
  const legacy = new DatabaseSync(dbPath);
  legacy.exec(`
    CREATE TABLE chat_history (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL,
      timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
      role TEXT NOT NULL,
      content TEXT NOT NULL
    );
    INSERT INTO chat_history (session_id, role, content)
      VALUES ('legacy-session', 'user', 'legacy hello');
  `);
  legacy.close();

  db = await import('../db.js');
});

describe('chat_history user_id migration', () => {
  it('pre-existing rows land in the default partition', () => {
    const rows = db.getChatHistory('legacy-session');
    expect(rows).toHaveLength(1);
    expect(rows[0].content).toBe('legacy hello');

    // …and are NOT visible to any named user.
    expect(db.getChatHistory('legacy-session', 'alice')).toHaveLength(0);
    expect(db.getChatSessions('default').some(s => s.session_id === 'legacy-session')).toBe(true);
    expect(db.getChatSessions('alice').some(s => s.session_id === 'legacy-session')).toBe(false);
  });
});

describe('S-1: two identities sharing one session_id', () => {
  it('each identity reads only its own messages', () => {
    const sessionId = `shared-${Date.now()}`;
    db.saveChatMessage(sessionId, 'user', 'alice secret words', 'alice');
    db.saveChatMessage(sessionId, 'assistant', 'reply for alice', 'alice');
    db.saveChatMessage(sessionId, 'user', 'bob secret words', 'bob');

    const aliceRows = db.getChatHistory(sessionId, 'alice');
    expect(aliceRows.map(r => r.content)).toEqual(['alice secret words', 'reply for alice']);

    const bobRows = db.getChatHistory(sessionId, 'bob');
    expect(bobRows.map(r => r.content)).toEqual(['bob secret words']);

    // The default partition has none of either user's rows.
    expect(db.getChatHistory(sessionId)).toHaveLength(0);
    expect(db.getChatHistory(sessionId, 'carol')).toHaveLength(0);
  });

  it('session lists are per-user', () => {
    const sessionId = `listed-${Date.now()}`;
    db.saveChatMessage(sessionId, 'user', 'hi', 'alice');

    expect(db.getChatSessions('alice').some(s => s.session_id === sessionId)).toBe(true);
    expect(db.getChatSessions('bob').some(s => s.session_id === sessionId)).toBe(false);
    expect(db.getChatSessions().some(s => s.session_id === sessionId)).toBe(false);
  });

  it('writes without an explicit user land in the default partition', () => {
    const sessionId = `plain-${Date.now()}`;
    db.saveChatMessage(sessionId, 'user', 'unscoped note');
    expect(db.getChatHistory(sessionId, 'default')).toHaveLength(1);
    expect(db.getChatHistory(sessionId, 'alice')).toHaveLength(0);
  });
});
