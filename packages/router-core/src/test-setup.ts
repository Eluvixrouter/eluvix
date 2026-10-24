// Test isolation (runs once per vitest worker, before any test file):
// point Eluvix's app paths at a fresh per-worker temp dir so suites
// never share the real on-disk state. Most importantly this covers the
// single shared eluvix.db SQLite file — test files execute in parallel
// worker processes, and writes from concurrent processes against one
// WAL database can interleave so a save silently misses and a later
// read-back in another file sees nothing (an intermittent CI failure
// in the nextjs api-bugs suite traced to exactly this). Paths are
// resolved lazily from the environment on every getAppPaths() call,
// so setting the XDG roots here is sufficient.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'eluvix-test-'));
process.env.XDG_CONFIG_HOME = path.join(root, 'config');
process.env.XDG_DATA_HOME = path.join(root, 'data');
