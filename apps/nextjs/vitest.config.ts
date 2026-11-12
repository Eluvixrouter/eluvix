import { defineConfig } from 'vitest/config';
import path from 'node:path';

export default defineConfig({
  test: {
    environment: 'node',
    setupFiles: ['./src/test-setup.ts'],
    exclude: ['**/node_modules/**', '**/e2e/**', '**/.next/**'],
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
      '@eluvix/router-core/flash-attention-kernels': path.resolve(__dirname, '../../packages/router-core/src/flash-attention-kernels.ts'),
      '@eluvix/router-core/comfyui': path.resolve(__dirname, '../../packages/router-core/src/comfyui.ts'),
      '@eluvix/router-core/comfyui-postprocess': path.resolve(__dirname, '../../packages/router-core/src/comfyui-postprocess.ts'),
      '@eluvix/router-core/modality': path.resolve(__dirname, '../../packages/router-core/src/modality.ts'),
      '@eluvix/router-core/ssrf-guard': path.resolve(__dirname, '../../packages/router-core/src/ssrf-guard.ts'),
      '@eluvix/router-core/protocol-adapters': path.resolve(__dirname, '../../packages/router-core/src/protocol-adapters.ts'),
      '@eluvix/router-core/audio': path.resolve(__dirname, '../../packages/router-core/src/audio.ts'),
      '@eluvix/router-core/cascade': path.resolve(__dirname, '../../packages/router-core/src/cascade.ts'),
      '@eluvix/router-core/eval-types': path.resolve(__dirname, '../../packages/router-core/src/eval-types.ts'),
      '@eluvix/router-core/structured-outputs': path.resolve(__dirname, '../../packages/router-core/src/structured-outputs.ts'),
      '@eluvix/router-core/output-guard': path.resolve(__dirname, '../../packages/router-core/src/output-guard.ts'),
      '@eluvix/router-core/otel-exporter': path.resolve(__dirname, '../../packages/router-core/src/otel-exporter.ts'),
      '@eluvix/router-core/engine-signals': path.resolve(__dirname, '../../packages/router-core/src/engine-signals.ts'),
      '@eluvix/router-core': path.resolve(__dirname, '../../packages/router-core/src/index.ts'),
    },
  },
});
