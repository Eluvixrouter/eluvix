import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';

import {
  sanitizeSlug,
  ensureLayoutsDirectory,
  ensureExamplesSeeded,
  listLayouts,
  readLayout,
  writeLayout,
  deleteLayout,
  getLastActiveLayoutSlug,
  setLastActiveLayoutSlug,
  getLayoutsDirectoryPath,
  LayoutError
} from '../store';
import { EXAMPLE_LAYOUTS } from '../examples';

describe('Layout Storage & Template System', () => {
  let testDir: string;
  const originalConfig = process.env.XDG_CONFIG_HOME;
  const originalData = process.env.XDG_DATA_HOME;

  beforeEach(() => {
    testDir = path.join(os.tmpdir(), `eluvix-layouts-vitest-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    process.env.XDG_CONFIG_HOME = path.join(testDir, 'config');
    process.env.XDG_DATA_HOME = path.join(testDir, 'data');
  });

  afterEach(() => {
    process.env.XDG_CONFIG_HOME = originalConfig;
    process.env.XDG_DATA_HOME = originalData;
    try {
      if (testDir) {
        fs.rmSync(testDir, { recursive: true, force: true });
      }
    } catch {}
  });

  it('validates and sanitizes slugs, preventing path traversal', () => {
    expect(sanitizeSlug('default')).toBe('default');
    expect(sanitizeSlug('Cost-Cascade')).toBe('cost-cascade');
    expect(sanitizeSlug('my-test-123')).toBe('my-test-123');

    const badSlugs = ['../evil', '..\\traversal', 'has spaces', 'bad/slash', 'bad$char', '', '-starts-hyphen'];
    for (const bad of badSlugs) {
      expect(() => sanitizeSlug(bad)).toThrowError(LayoutError);
    }
  });

  it('seeds all 18 bundled example templates into layouts directory', () => {
    expect(EXAMPLE_LAYOUTS).toHaveLength(18);
    ensureLayoutsDirectory();
    ensureExamplesSeeded(false);

    const layoutsDir = getLayoutsDirectoryPath();
    expect(fs.existsSync(layoutsDir)).toBe(true);

    const files = fs.readdirSync(layoutsDir).filter(f => f.endsWith('.json') && !f.startsWith('.'));
    expect(files.length).toBe(18);

    for (const example of EXAMPLE_LAYOUTS) {
      expect(files).toContain(`${example.id}.json`);
    }
  });

  it('lists layouts with default prioritized and correct metadata', () => {
    const list = listLayouts();
    expect(list.length).toBeGreaterThanOrEqual(13);
    expect(list[0].id).toBe('default');

    for (const item of list) {
      expect(item.name).toBeTruthy();
      expect(item.nodeCount).toBeGreaterThan(0);
      expect(item.edgeCount).toBeGreaterThan(0);
    }
  });

  it('reads specific layout and handles missing layouts', () => {
    const layout = readLayout('default');
    expect(layout).not.toBeNull();
    expect(layout?.id).toBe('default');
    expect(Array.isArray(layout?.nodes)).toBe(true);
    expect(Array.isArray(layout?.edges)).toBe(true);

    const missing = readLayout('non-existent-slug');
    expect(missing).toBeNull();
  });

  it('creates, updates, and deletes layouts', () => {
    const created = writeLayout('my-custom-flow', {
      name: 'My Custom Flow',
      description: 'Test description',
      category: 'custom',
      tags: ['test', 'unit'],
      nodes: [{ id: 'input-1', type: 'inputNode', position: { x: 0, y: 0 }, data: {} }],
      edges: []
    });

    expect(created.id).toBe('my-custom-flow');
    expect(created.name).toBe('My Custom Flow');
    expect(created.version).toBe(1);

    // Overwrite without flag throws 409
    expect(() => writeLayout('my-custom-flow', { name: 'Duplicate' })).toThrowError(LayoutError);

    // Overwrite with flag succeeds
    const updated = writeLayout('my-custom-flow', { name: 'Updated Flow' }, { overwrite: true });
    expect(updated.name).toBe('Updated Flow');
    expect(updated.version).toBe(2);

    // Read back
    const readBack = readLayout('my-custom-flow');
    expect(readBack?.name).toBe('Updated Flow');

    // Delete
    const deleted = deleteLayout('my-custom-flow');
    expect(deleted).toBe(true);
    expect(readLayout('my-custom-flow')).toBeNull();
  });

  it('does not re-seed deleted example layouts on subsequent list/read calls', () => {
    ensureExamplesSeeded();
    expect(readLayout('default')).not.toBeNull();

    // Delete an example
    const deleted = deleteLayout('default');
    expect(deleted).toBe(true);
    expect(readLayout('default')).toBeNull();

    // Subsequent listing should not recreate it
    const list = listLayouts();
    expect(list.find(l => l.id === 'default')).toBeUndefined();
    expect(readLayout('default')).toBeNull();
  });

  it('restores deleted examples when force=true', () => {
    ensureExamplesSeeded();
    deleteLayout('default');
    expect(readLayout('default')).toBeNull();

    // Force restore
    ensureExamplesSeeded(true);
    expect(readLayout('default')).not.toBeNull();
  });

  it('rejects graph exceeding MAX_NODES (500)', () => {
    const bigNodes: any[] = [];
    for (let i = 0; i < 501; i++) {
      bigNodes.push({ id: `node-${i}`, type: 'inputNode', position: { x: 0, y: 0 } });
    }

    expect(() => writeLayout('too-many-nodes', { nodes: bigNodes, edges: [] })).toThrowError(
      expect.objectContaining({ code: 'invalid_graph' })
    );
  });

  it('rejects duplicate node IDs', () => {
    const nodes = [
      { id: 'duplicate-id', type: 'inputNode', position: { x: 0, y: 0 } },
      { id: 'duplicate-id', type: 'agentNode', position: { x: 10, y: 10 } }
    ];

    expect(() => writeLayout('duplicate-nodes', { nodes, edges: [] })).toThrowError(
      expect.objectContaining({ code: 'invalid_graph' })
    );
  });

  it('rejects oversized layout payloads exceeding 1MB', () => {
    const bigNodes: any[] = [];
    // 400 nodes <= 500 max limit, but each has 3KB data => ~1.2MB payload > 1MB limit
    for (let i = 0; i < 400; i++) {
      bigNodes.push({ id: `big-${i}`, type: 'test', position: { x: 0, y: 0 }, data: { padding: 'x'.repeat(3000) } });
    }

    expect(() => writeLayout('oversized-layout', { nodes: bigNodes, edges: [] })).toThrowError(
      expect.objectContaining({ code: 'payload_too_large' })
    );
  });

  it('tracks last active layout slug in state file', () => {
    expect(getLastActiveLayoutSlug()).toBe('default');
    setLastActiveLayoutSlug('cost-cascade');
    expect(getLastActiveLayoutSlug()).toBe('cost-cascade');
  });

  it('resolves paths lazily so env changes take immediate effect without polluting other paths', () => {
    const customConfig = path.join(testDir, 'other-config');
    process.env.XDG_CONFIG_HOME = customConfig;
    expect(getLayoutsDirectoryPath()).toBe(path.join(customConfig, 'eluvix', 'layouts'));
  });
});
