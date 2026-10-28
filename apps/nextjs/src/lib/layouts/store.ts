import fs from 'node:fs';
import path from 'node:path';
import { getAppPaths } from '@eluvix/router-core';
import { Layout, LayoutMetadata, LayoutsState } from './types';
import { EXAMPLE_LAYOUTS } from './examples';

const MAX_LAYOUT_SIZE_BYTES = 1024 * 1024; // 1MB limit
const MAX_NODES = 500;
const MAX_EDGES = 2000;
/** Bump when EXAMPLE_LAYOUTS gains new templates so they get seeded once. */
export const EXAMPLES_SEED_VERSION = 4;

export class LayoutError extends Error {
  constructor(message: string, public code: string, public statusCode: number = 400) {
    super(message);
    this.name = 'LayoutError';
  }
}

// Paths are resolved lazily so XDG_CONFIG_HOME changes (tests, env overrides) are honored.
function getDirs() {
  const { configDir, layoutsDir } = getAppPaths('eluvix');
  return { configDir, layoutsDir, stateFile: path.join(layoutsDir, '.state.json') };
}

export function getLayoutsDirectoryPath(): string {
  return getDirs().layoutsDir;
}

function atomicWrite(filePath: string, contents: string): void {
  const tmpPath = `${filePath}.tmp.${process.pid}.${Date.now()}`;
  try {
    fs.writeFileSync(tmpPath, contents, { encoding: 'utf-8', mode: 0o600 });
    fs.renameSync(tmpPath, filePath);
  } catch (err) {
    try { fs.unlinkSync(tmpPath); } catch {}
    throw err;
  }
}

function readState(): LayoutsState {
  const { stateFile } = getDirs();
  try {
    if (fs.existsSync(stateFile)) {
      return JSON.parse(fs.readFileSync(stateFile, 'utf-8'));
    }
  } catch {}
  return {};
}

function writeState(state: LayoutsState): void {
  try {
    atomicWrite(getDirs().stateFile, JSON.stringify(state, null, 2));
  } catch (err) {
    console.error('[LayoutStore] Failed to write layouts state file:', err);
  }
}

export function sanitizeSlug(rawSlug: string): string {
  if (!rawSlug || typeof rawSlug !== 'string') {
    throw new LayoutError('Layout slug is required', 'invalid_slug', 400);
  }
  const slug = rawSlug.trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(slug)) {
    throw new LayoutError(
      'Invalid slug: must contain only lowercase alphanumeric characters and hyphens, starting with an alphanumeric character (max 64 chars)',
      'invalid_slug',
      400
    );
  }
  return slug;
}

export function ensureLayoutsDirectory(): string {
  const { layoutsDir } = getDirs();
  fs.mkdirSync(layoutsDir, { recursive: true });
  return layoutsDir;
}

/**
 * Seeds example templates.
 * - force=false: only runs once per EXAMPLES_SEED_VERSION, and never recreates files the user deleted.
 * - force=true: overwrites all example files (explicit "restore"). Returns the slugs that were overwritten.
 */
export function ensureExamplesSeeded(force = false): string[] {
  const layoutsDir = ensureLayoutsDirectory();
  const state = readState();
  if (!force && (state.examplesSeededVersion ?? 0) >= EXAMPLES_SEED_VERSION) {
    return [];
  }

  const overwritten: string[] = [];
  for (const example of EXAMPLE_LAYOUTS) {
    const filePath = path.join(layoutsDir, `${example.id}.json`);
    const exists = fs.existsSync(filePath);
    if (force || !exists) {
      try {
        atomicWrite(filePath, JSON.stringify(example, null, 2));
        if (exists) overwritten.push(example.id);
      } catch (err) {
        console.error(`[LayoutStore] Failed to seed example layout ${example.id}:`, err);
      }
    }
  }

  state.examplesSeededVersion = EXAMPLES_SEED_VERSION;
  if (!state.lastActiveSlug) state.lastActiveSlug = 'default';
  writeState(state);
  return overwritten;
}

/** Lists which existing example files would be overwritten by a forced restore. */
export function listExampleConflicts(): string[] {
  const { layoutsDir } = getDirs();
  return EXAMPLE_LAYOUTS.filter(e => fs.existsSync(path.join(layoutsDir, `${e.id}.json`))).map(e => e.id);
}

function validateGraph(nodes: unknown, edges: unknown): void {
  if (!Array.isArray(nodes) || !Array.isArray(edges)) {
    throw new LayoutError('"nodes" and "edges" must be arrays', 'invalid_graph', 400);
  }
  if (nodes.length > MAX_NODES) {
    throw new LayoutError(`Too many nodes (max ${MAX_NODES})`, 'invalid_graph', 400);
  }
  if (edges.length > MAX_EDGES) {
    throw new LayoutError(`Too many edges (max ${MAX_EDGES})`, 'invalid_graph', 400);
  }
  const ids = new Set<string>();
  for (const n of nodes as any[]) {
    if (!n || typeof n !== 'object' || typeof n.id !== 'string' || !n.id || typeof n.type !== 'string' ||
        !n.position || typeof n.position.x !== 'number' || typeof n.position.y !== 'number') {
      throw new LayoutError('Each node requires string "id", string "type" and numeric "position.x/y"', 'invalid_graph', 400);
    }
    if (ids.has(n.id)) {
      throw new LayoutError(`Duplicate node id "${n.id}"`, 'invalid_graph', 400);
    }
    ids.add(n.id);
  }
  for (const e of edges as any[]) {
    if (!e || typeof e !== 'object' || typeof e.id !== 'string' ||
        typeof e.source !== 'string' || typeof e.target !== 'string') {
      throw new LayoutError('Each edge requires string "id", "source" and "target"', 'invalid_graph', 400);
    }
  }
}

export function listLayouts(): LayoutMetadata[] {
  const layoutsDir = ensureLayoutsDirectory();
  ensureExamplesSeeded(false);

  const layouts: LayoutMetadata[] = [];
  for (const entry of fs.readdirSync(layoutsDir, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith('.json') || entry.name.startsWith('.')) continue;
    const slug = entry.name.slice(0, -5);
    try {
      const parsed = JSON.parse(fs.readFileSync(path.join(layoutsDir, entry.name), 'utf-8')) as Layout;
      layouts.push({
        id: slug,
        name: parsed.name || slug,
        description: parsed.description,
        category: parsed.category || (parsed.isExample ? 'starter' : 'custom'),
        tags: parsed.tags || [],
        isExample: !!parsed.isExample,
        version: parsed.version || 1,
        createdAt: parsed.createdAt || new Date().toISOString(),
        updatedAt: parsed.updatedAt || new Date().toISOString(),
        nodeCount: Array.isArray(parsed.nodes) ? parsed.nodes.length : 0,
        edgeCount: Array.isArray(parsed.edges) ? parsed.edges.length : 0,
      });
    } catch (err) {
      console.warn(`[LayoutStore] Skipping corrupt layout file ${entry.name}:`, err);
    }
  }

  return layouts.sort((a, b) => {
    if (a.id === 'default') return -1;
    if (b.id === 'default') return 1;
    if (a.isExample && !b.isExample) return -1;
    if (!a.isExample && b.isExample) return 1;
    return new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime();
  });
}

export function readLayout(rawSlug: string): Layout | null {
  const slug = sanitizeSlug(rawSlug);
  const dir = ensureLayoutsDirectory();
  ensureExamplesSeeded();
  const filePath = path.join(dir, `${slug}.json`);
  if (!fs.existsSync(filePath)) return null;
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf-8')) as Layout;
  } catch (err) {
    console.error(`[LayoutStore] Failed to read layout "${slug}":`, err);
    throw new LayoutError(`Corrupted layout file for "${slug}"`, 'corrupted_layout', 500);
  }
}

export function writeLayout(
  rawSlug: string,
  layoutData: Partial<Layout>,
  options: { overwrite?: boolean } = {}
): Layout {
  const slug = sanitizeSlug(rawSlug);
  const filePath = path.join(ensureLayoutsDirectory(), `${slug}.json`);
  const exists = fs.existsSync(filePath);

  if (exists && !options.overwrite) {
    throw new LayoutError(`Layout with slug "${slug}" already exists`, 'layout_exists', 409);
  }

  let existing: Layout | null = null;
  if (exists) {
    try { existing = JSON.parse(fs.readFileSync(filePath, 'utf-8')); } catch {}
  }

  const nodes = Array.isArray(layoutData.nodes) ? layoutData.nodes : existing?.nodes || [];
  const edges = Array.isArray(layoutData.edges) ? layoutData.edges : existing?.edges || [];
  validateGraph(nodes, edges);

  const now = new Date().toISOString();
  const fullLayout: Layout = {
    id: slug,
    name: layoutData.name || existing?.name || slug,
    description: layoutData.description ?? existing?.description ?? '',
    category: layoutData.category || existing?.category || 'custom',
    tags: layoutData.tags || existing?.tags || [],
    isExample: layoutData.isExample ?? existing?.isExample ?? false,
    version: existing ? (existing.version || 1) + 1 : 1,
    createdAt: existing?.createdAt || now,
    updatedAt: now,
    viewport: layoutData.viewport || existing?.viewport || { x: 0, y: 0, zoom: 1 },
    nodes,
    edges,
  };

  const serialized = JSON.stringify(fullLayout, null, 2);
  const size = Buffer.byteLength(serialized, 'utf-8');
  if (size > MAX_LAYOUT_SIZE_BYTES) {
    throw new LayoutError(`Layout size exceeds the 1MB limit (${size} bytes)`, 'payload_too_large', 413);
  }

  atomicWrite(filePath, serialized);
  return fullLayout;
}

export function deleteLayout(rawSlug: string): boolean {
  const slug = sanitizeSlug(rawSlug);
  const filePath = path.join(ensureLayoutsDirectory(), `${slug}.json`);
  if (!fs.existsSync(filePath)) return false;
  fs.unlinkSync(filePath);
  return true;
}

export function getLastActiveLayoutSlug(): string {
  return readState().lastActiveSlug || 'default';
}

export function setLastActiveLayoutSlug(rawSlug: string): void {
  const slug = sanitizeSlug(rawSlug);
  ensureLayoutsDirectory();
  const state = readState();
  state.lastActiveSlug = slug;
  writeState(state);
}
