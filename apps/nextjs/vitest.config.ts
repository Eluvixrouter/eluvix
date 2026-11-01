import { defineConfig } from 'vitest/config';
import path from 'node:path';

export default defineConfig({
  test: {
    environment: 'node',
    setupFiles: ['./src/test-setup.ts'],
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
      '@eluvix/router-core/clos-fabric': path.resolve(__dirname, '../../packages/router-core/src/clos-fabric-routing.ts'),
      '@eluvix/router-core/microscaling': path.resolve(__dirname, '../../packages/router-core/src/microscaling-quantization.ts'),
      '@eluvix/router-core/shell-utils': path.resolve(__dirname, '../../packages/router-core/src/shell-utils.ts'),
      '@eluvix/router-core/neuro-symbolic-crs': path.resolve(__dirname, '../../packages/router-core/src/neuro-symbolic-crs.ts'),
      '@eluvix/router-core/vectorcraft-mcp': path.resolve(__dirname, '../../packages/router-core/src/vectorcraft-mcp.ts'),
      '@eluvix/router-core/artcraft-mcp': path.resolve(__dirname, '../../packages/router-core/src/artcraft-mcp.ts'),
      '@eluvix/router-core': path.resolve(__dirname, '../../packages/router-core/src/index.ts'),
    },
  },
});
