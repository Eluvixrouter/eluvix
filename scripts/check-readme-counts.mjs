#!/usr/bin/env node
/**
 * README test-count drift check (`scripts/check-readme-counts.mjs`).
 *
 * Hunt-3 D-H3-07: README's test-suite counts went stale (router-core
 * "48/476" vs measured 49/431 at hunt time) because nothing checked
 * them. This script is the cheap, deterministic guard: it counts test
 * FILES on disk and asserts README's per-suite file counts and summed
 * total match the inventory.
 *
 * It deliberately does NOT assert test totals (the "N passing tests"
 * numbers): those change with every added test and are verified by the
 * suites themselves in CI — re-measure them and update README when
 * they move. It also asserts the `pnpm build` line presents the build
 * as builds-only, not as running the tests/E2E (the other half of
 * D-H3-07: root `pnpm build` is `pnpm -r run build` and runs neither).
 *
 * Run: `node scripts/check-readme-counts.mjs` (wired into CI).
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function countTestFiles(dirs) {
  let n = 0;
  for (const dir of dirs) {
    const abs = path.join(repoRoot, dir);
    const walk = (d) => {
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        const p = path.join(d, e.name);
        if (e.isDirectory()) walk(p);
        else if (/\.test\.tsx?$/.test(e.name)) n += 1;
      }
    };
    walk(abs);
  }
  return n;
}

const readme = fs.readFileSync(path.join(repoRoot, 'README.md'), 'utf8');

const suites = [
  { name: 'router-core', dirs: ['packages/router-core/src'], re: /Test router core \((\d+) active test files,/ },
  { name: 'paperclip', dirs: ['packages/paperclip-plugin/src', 'packages/paperclip-adapter/src'], re: /Test Paperclip plugin & adapter packages \((\d+) test files,/ },
  { name: 'nextjs', dirs: ['apps/nextjs/src'], re: /Test Next\.js application & Eluvix Visual Node Routing Editor \((\d+) test files,/ },
  { name: 'desktop', dirs: ['apps/desktop/src'], re: /Test Desktop application \((\d+) test file/, },
];

const failures = [];
let totalFiles = 0;
for (const s of suites) {
  const actual = countTestFiles(s.dirs);
  totalFiles += actual;
  const m = readme.match(s.re);
  if (!m) {
    failures.push(`${s.name}: README line not found (expected pattern ${s.re})`);
    continue;
  }
  const claimed = Number(m[1]);
  if (claimed !== actual) {
    failures.push(`${s.name}: README claims ${claimed} test files, inventory has ${actual}`);
  } else {
    console.log(`ok ${s.name}: ${actual} test file${actual === 1 ? '' : 's'}`);
  }
}

const totalMatch = readme.match(/(\d+) passing Vitest files \/ \d+ tests/);
if (!totalMatch) {
  failures.push('README total line not found (expected "N passing Vitest files / M tests")');
} else if (Number(totalMatch[1]) !== totalFiles) {
  failures.push(`README total claims ${totalMatch[1]} Vitest files, inventory sums to ${totalFiles}`);
} else {
  console.log(`ok total: ${totalFiles} Vitest files`);
}

const lines = readme.split('\n');
const buildIdx = lines.findIndex((l) => l.trim() === 'pnpm build');
if (buildIdx <= 0 || !/builds only/i.test(lines[buildIdx - 1])) {
  failures.push('README line above `pnpm build` must say the build is builds-only (it runs no tests and no E2E)');
} else {
  console.log('ok pnpm build line presents the build as builds-only');
}

if (failures.length > 0) {
  console.error('❌ README test-count drift:');
  for (const f of failures) console.error(`  - ${f}`);
  console.error('Re-measure the suites and update README.md (see hunt-3 D-H3-07).');
  process.exit(1);
}
console.log('✅ README test counts match the on-disk inventory.');
