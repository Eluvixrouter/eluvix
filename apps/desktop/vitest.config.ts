import { defineConfig } from 'vitest/config';
import path from 'node:path';

export default defineConfig({
  test: {
    environment: 'node',
    exclude: ['**/node_modules/**', '**/dist/**'],
  },
  resolve: {
    alias: {
      '@eluvix/router-core': path.resolve(__dirname, '../../packages/router-core/src/index.ts'),
    },
  },
});
