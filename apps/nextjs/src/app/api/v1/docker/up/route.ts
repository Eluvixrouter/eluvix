import { NextResponse } from 'next/server';
import { exec } from 'child_process';
import util from 'util';
import path from 'path';
import fs from 'fs';

const execAsync = util.promisify(exec);

export const dynamic = 'force-dynamic';

function getProjectRoot(): string {
  const current = process.cwd();
  if (fs.existsSync(path.join(current, 'docker-compose.yml'))) {
    return current;
  }
  const parent2 = path.resolve(current, '../..');
  if (fs.existsSync(path.join(parent2, 'docker-compose.yml'))) {
    return parent2;
  }
  return current;
}

export async function POST() {
  try {
    const rootDir = getProjectRoot();
    console.log(`[Docker Up] Executing hardware detection & docker compose up in ${rootDir}`);

    // Pre-flight: detect GPU acceleration (NVIDIA CUDA / AMD ROCm / CPU)
    const detectScript = path.join(rootDir, 'scripts', 'docker-detect-and-spinup.sh');
    let hardwareInfo: Record<string, unknown> | null = null;
    if (fs.existsSync(detectScript)) {
      try {
        const { stdout: detectOut } = await execAsync(`bash "${detectScript}" detect --json`, {
          cwd: rootDir,
          timeout: 15000
        });
        try {
          hardwareInfo = JSON.parse(detectOut.trim());
          console.log('[Docker Up] Hardware acceleration configured:', hardwareInfo);
        } catch {
          // non-json output
        }
      } catch (detectErr) {
        console.warn('[Docker Up] Hardware detection non-fatal warning:', detectErr);
      }
    }

    const { stdout, stderr } = await execAsync('docker compose up -d --build', {
      cwd: rootDir,
      timeout: 180000 // 3 minutes
    });

    return NextResponse.json({
      success: true,
      message: 'Containers spin-up initiated successfully.',
      hardware: hardwareInfo,
      stdout: stdout.trim(),
      stderr: stderr.trim()
    });
  } catch (error) {
    const err = error as Error;
    console.error('[Docker Up Error]', err);
    return NextResponse.json({
      success: false,
      error: err.message
    }, { status: 500 });
  }
}
