import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const desktopDir = path.resolve(__dirname, '..');
const distDir = path.join(desktopDir, 'dist');

fs.mkdirSync(distDir, { recursive: true });

const rendererSrc = path.join(desktopDir, 'src', 'renderer');
const rendererDest = path.join(distDir, 'renderer');
if (fs.existsSync(rendererSrc)) {
  fs.cpSync(rendererSrc, rendererDest, { recursive: true });
}

const assetsSrc = path.join(desktopDir, 'assets');
const assetsDest = path.join(distDir, 'assets');
if (fs.existsSync(assetsSrc)) {
  fs.cpSync(assetsSrc, assetsDest, { recursive: true });
}
