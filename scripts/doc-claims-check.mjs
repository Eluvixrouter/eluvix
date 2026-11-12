#!/usr/bin/env node
/**
 * Phase 0.4 — Documentation Claims Verification Gate (`scripts/doc-claims-check.mjs`)
 *
 * Scans `apps/nextjs/src/app/docs/docs-data.ts` and `apps/githubio/src/app/docs/api/page.mdx`
 * for documented `/api/v1/*` routes and `X-Eluvix-*` headers and verifies that every claim
 * has a matching implementation in `packages/router-core/src` or `apps/nextjs/src`.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, '..');

function collectSourceFiles(dir, out = []) {
  if (!fs.existsSync(dir)) return out;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === '.next' || entry.name === 'dist' || entry.name === '__tests__') {
      continue;
    }
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      collectSourceFiles(full, out);
    } else if (/\.(ts|tsx|mjs|js)$/.test(entry.name) && entry.name !== 'docs-data.ts') {
      out.push(full);
    }
  }
  return out;
}

const sourceFiles = [
  ...collectSourceFiles(path.join(rootDir, 'packages/router-core/src')),
  ...collectSourceFiles(path.join(rootDir, 'apps/nextjs/src')),
  ...collectSourceFiles(path.join(rootDir, 'apps/desktop/src')),
];

const combinedSourceLower = sourceFiles
  .map((f) => fs.readFileSync(f, 'utf8').toLowerCase())
  .join('\n');

const docsDataPath = path.join(rootDir, 'apps/nextjs/src/app/docs/docs-data.ts');
const apiMdxPath = path.join(rootDir, 'apps/githubio/src/app/docs/api/page.mdx');

const docsText = [
  fs.existsSync(docsDataPath) ? fs.readFileSync(docsDataPath, 'utf8') : '',
  fs.existsSync(apiMdxPath) ? fs.readFileSync(apiMdxPath, 'utf8') : '',
].join('\n');

// 1. Verify documented /api/v1/<segment> routes exist in apps/nextjs/src/app/api/v1/
const routeMatches = [...docsText.matchAll(/\/api\/v1\/([a-z0-9_-]+(?:\/[a-z0-9_-]+)?)/gi)];
const uniqueRouteSegments = new Set(routeMatches.map((m) => m[1].toLowerCase()));
const missingRoutes = [];

for (const seg of uniqueRouteSegments) {
  // Ignore OpenViking external example `/api/v1/search` and `/api/v1/sessions`
  if (seg.startsWith('search') || seg.startsWith('sessions')) continue;
  const routeDir = path.join(rootDir, 'apps/nextjs/src/app/api/v1', seg);
  const topDir = path.join(rootDir, 'apps/nextjs/src/app/api/v1', seg.split('/')[0]);
  if (!fs.existsSync(routeDir) && !fs.existsSync(topDir)) {
    missingRoutes.push(`/api/v1/${seg}`);
  }
}

// 2. Verify documented concrete X-Eluvix-* headers exist in source
const headerMatches = [...docsText.matchAll(/\b(x-eluvix-[a-z0-9-]+)\b/gi)];
const uniqueHeaders = new Set(
  headerMatches
    .map((m) => m[1].toLowerCase())
    .filter((h) => !h.endsWith('-') && h !== 'x-eluvix-crs')
);
const missingHeaders = [];

for (const header of uniqueHeaders) {
  if (!combinedSourceLower.includes(header)) {
    missingHeaders.push(header);
  }
}

if (missingRoutes.length > 0 || missingHeaders.length > 0) {
  console.error('❌ Documentation claims check failed:');
  if (missingRoutes.length > 0) {
    console.error('  Missing routes:', missingRoutes.join(', '));
  }
  if (missingHeaders.length > 0) {
    console.error('  Missing headers:', missingHeaders.join(', '));
  }
  process.exit(1);
}

console.log(
  `✅ Documentation claims verified (${uniqueRouteSegments.size} routes, ${uniqueHeaders.size} X-Eluvix-* headers).`
);
