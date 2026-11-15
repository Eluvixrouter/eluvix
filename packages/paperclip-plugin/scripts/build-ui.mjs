import * as esbuild from 'esbuild';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const pkgRoot = resolve(__dirname, '..');

await esbuild.build({
  entryPoints: [resolve(pkgRoot, 'src/ui/index.tsx')],
  outfile: resolve(pkgRoot, 'dist/ui/index.js'),
  bundle: true,
  format: 'esm',
  platform: 'browser',
  target: ['es2022'],
  sourcemap: true,
  external: [
    'react',
    'react-dom',
    'react/jsx-runtime',
    '@paperclipai/plugin-sdk/ui',
  ],
});
