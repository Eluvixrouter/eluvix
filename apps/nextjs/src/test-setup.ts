// Test isolation (runs once per vitest worker, before any test file):
// point Eluvix's app paths at a fresh per-worker temp dir so suites
// never share the real on-disk state. Most importantly this covers the
// single shared eluvix.db SQLite file — test files execute in parallel
// worker processes, and writes from concurrent processes against one
// WAL database can interleave so a save silently misses and a later
// read-back in another file sees nothing (this suite's api-bugs
// multimodal chat-logging test failed intermittently in CI for exactly
// this reason). Paths are resolved lazily from the environment on
// every getAppPaths() call, so setting the XDG roots here is
// sufficient. Tests that need a specific config dir still override
// XDG_CONFIG_HOME themselves.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'eluvix-test-'));
process.env.XDG_CONFIG_HOME = path.join(root, 'config');
process.env.XDG_DATA_HOME = path.join(root, 'data');
