import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { sanitizeSafeIdentifier } from './shell-utils.js';
import { tryResolveCliExecutable, ARTCRAFT_CLI_BINARIES } from './cli-exec.js';

const MAX_POSTPROCESS_MEDIA_BYTES = 50 * 1024 * 1024;

export interface ArtCraftPostProcessResult {
  app: 'vectorcraft' | 'photocraft' | 'filmcraft';
  cliBinary: string;
  executed: boolean;
  status: 'completed' | 'cli-not-installed' | 'execution-failed';
  outputFormat: string;
  outputBase64?: string;
  suggestedCommand: string;
  error?: string;
}

/**
 * Pillar 3: Executes optional headless ArtCraft CLI post-processing (`vectorcraft-cli`,
 * `photocraft-cli`, `filmcraft-cli`) on a rendered ComfyUI media artifact when the
 * authorized binary is installed on the host, or gracefully degrades with structured metadata.
 */
export async function executeArtCraftPostProcess(params: {
  app: string;
  sourceUrl: string;
  filename?: string;
  timeoutMs?: number;
  signal?: AbortSignal;
}): Promise<ArtCraftPostProcessResult> {
  const normalizedApp =
    params.app === 'vectorcraft' || params.app === 'filmcraft' ? params.app : 'photocraft';
  const cliBinary = `${normalizedApp}-cli`;
  const outputFormat =
    normalizedApp === 'vectorcraft' ? 'svg' : normalizedApp === 'filmcraft' ? 'mp4' : 'png';
  const safeInputHint = sanitizeSafeIdentifier(params.filename || 'comfy_output', 'comfy_output');
  const suggestedCommand =
    normalizedApp === 'vectorcraft'
      ? `${cliBinary} trace --input ${safeInputHint}.png --output ${safeInputHint}.svg`
      : `${cliBinary} export --input ${safeInputHint} --format ${outputFormat}`;

  const resolvedBin = tryResolveCliExecutable(cliBinary, {
    allowedBasenames: ARTCRAFT_CLI_BINARIES,
  });

  if (!resolvedBin) {
    return {
      app: normalizedApp,
      cliBinary,
      executed: false,
      status: 'cli-not-installed',
      outputFormat,
      suggestedCommand,
    };
  }

  let tmpDir: string | null = null;
  try {
    const mediaRes = await fetch(params.sourceUrl, { method: 'GET', signal: params.signal });
    if (!mediaRes.ok) {
      throw new Error(`Failed to fetch source media (${mediaRes.status})`);
    }
    const ab = await mediaRes.arrayBuffer();
    if (ab.byteLength > MAX_POSTPROCESS_MEDIA_BYTES) {
      throw new Error('Source media exceeds post-processing size limit');
    }

    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'eluvix-artcraft-'));
    const ext = path.extname(params.filename || '').replace(/[^.a-zA-Z0-9]/g, '') || '.png';
    const inPath = path.join(tmpDir, `input${ext}`);
    const outPath = path.join(tmpDir, `output.${outputFormat}`);
    fs.writeFileSync(inPath, Buffer.from(ab));

    const cliArgs =
      normalizedApp === 'vectorcraft'
        ? ['trace', '--input', inPath, '--output', outPath]
        : ['export', '--input', inPath, '--output', outPath, '--format', outputFormat];

    await new Promise<void>((resolve, reject) => {
      execFile(
        resolvedBin,
        cliArgs,
        { timeout: params.timeoutMs ?? 20000, maxBuffer: 16 * 1024 * 1024 },
        (err) => {
          if (err) reject(err);
          else resolve();
        }
      );
    });

    const outBuf = fs.existsSync(outPath) ? fs.readFileSync(outPath) : undefined;
    return {
      app: normalizedApp,
      cliBinary,
      executed: true,
      status: 'completed',
      outputFormat,
      outputBase64: outBuf ? outBuf.toString('base64') : undefined,
      suggestedCommand,
    };
  } catch (err: any) {
    return {
      app: normalizedApp,
      cliBinary,
      executed: false,
      status: 'execution-failed',
      outputFormat,
      suggestedCommand,
      error: err?.message || 'ArtCraft post-processing failed',
    };
  } finally {
    if (tmpDir) {
      try {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      } catch {}
    }
  }
}
