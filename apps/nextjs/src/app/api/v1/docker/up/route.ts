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

import { isValidContainerName } from '@/lib/api-helpers';

export async function POST(req: Request) {
  try {
    const rootDir = getProjectRoot();
    console.log(`[Docker Up] Executing hardware detection & docker compose up in ${rootDir}`);

    // Parse optional specific services requested in body
    let requestedServices: string[] = [];
    try {
      const body = await req.json();
      if (body && Array.isArray(body.services)) {
        requestedServices = body.services
          .filter((s: unknown): s is string => typeof s === 'string' && isValidContainerName(s));
      } else if (body && typeof body.service === 'string' && isValidContainerName(body.service)) {
        requestedServices = [body.service];
      }
    } catch {
      // Body empty or not JSON
    }

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

    const serviceArgs = requestedServices.length > 0 ? requestedServices.join(' ') : '';
    const composeCmd = serviceArgs ? `docker compose up -d --build ${serviceArgs}` : 'docker compose up -d --build';

    const { stdout, stderr } = await execAsync(composeCmd, {
      cwd: rootDir,
      timeout: 180000 // 3 minutes
    });

    return NextResponse.json({
      success: true,
      message: requestedServices.length > 0
        ? `Containers (${requestedServices.join(', ')}) spin-up initiated.`
        : 'All containers spin-up initiated successfully.',
      services: requestedServices.length > 0 ? requestedServices : 'all',
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
