import { describe, it, expect } from 'vitest';
import path from 'node:path';
import { getAppPaths } from '../paths.js';

describe('App Paths & XDG Layouts Directory', () => {
  it('includes layoutsDir under configDir', () => {
    const paths = getAppPaths('eluvix');
    expect(paths.configDir).toBeDefined();
    expect(paths.dataDir).toBeDefined();
    expect(paths.layoutsDir).toBeDefined();
    expect(paths.layoutsDir).toBe(path.join(paths.configDir, 'layouts'));
  });

  it('respects custom appName', () => {
    const paths = getAppPaths('custom-app');
    expect(paths.layoutsDir).toBe(path.join(paths.configDir, 'layouts'));
    expect(paths.layoutsDir.includes('custom-app')).toBe(true);
  });
});
