import { NextResponse } from 'next/server';
import { execFile } from 'child_process';
import util from 'util';
import path from 'path';
import fs from 'fs';
import { isValidContainerName, isAuthorizedAdminAsync } from '@/lib/api-helpers';
import {
  type DockerServiceCategory,
  getComposeServiceCatalog,
  getComposeServicesForConfig,
  getServicesByCategory
} from '@/lib/docker-catalog';
import { getConfig } from '@/lib/router';

const execFileAsync = util.promisify(execFile);

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

export async function POST(req: Request) {
  if (!(await isAuthorizedAdminAsync(req))) {
    return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 });
  }
  try {
    const rootDir = getProjectRoot();
    console.log(`[Docker Up] Executing hardware detection & modular docker compose up in ${rootDir}`);

    let requestedServices: string[] = [];
    let requestedProfile: string | undefined;
    try {
      const body = await req.json();
      if (body && typeof body.profile === 'string') {
        requestedProfile = body.profile.trim().toLowerCase();
      }
      if (body && Array.isArray(body.services)) {
        requestedServices = body.services
          .filter((s: unknown): s is string => typeof s === 'string' && isValidContainerName(s));
      } else if (body && typeof body.service === 'string' && isValidContainerName(body.service)) {
        requestedServices = [body.service];
      }
    } catch {
      // Body empty or not JSON
    }

    const composeServiceSet = new Set(getComposeServiceCatalog().map((s) => s.name));

    if (requestedServices.length === 0 && requestedProfile) {
      if (requestedProfile === 'topology') {
        requestedServices = getComposeServicesForConfig(getConfig());
      } else if (
        requestedProfile === 'core' ||
        requestedProfile === 'inference' ||
        requestedProfile === 'memory' ||
        requestedProfile === 'harnesses'
      ) {
        requestedServices = getServicesByCategory(requestedProfile as DockerServiceCategory);
      } else if (requestedProfile === 'all') {
        requestedServices = getComposeServiceCatalog().map((s) => s.name);
      }
    }

    // Default to all compose-backed services when no specific service or profile is requested
    const targetList = (
      requestedServices.length > 0
        ? requestedServices
        : getComposeServiceCatalog().map((s) => s.name)
    ).filter((s) => composeServiceSet.has(s));

    if (targetList.length === 0) {
      return NextResponse.json(
        { success: false, error: 'No valid Docker Compose services selected.' },
        { status: 400 }
      );
    }

    // Pre-flight: detect GPU acceleration (NVIDIA CUDA / AMD ROCm / CPU)
    const detectScript = path.join(rootDir, 'scripts', 'docker-detect-and-spinup.sh');
    let hardwareInfo: Record<string, unknown> | null = null;
    if (fs.existsSync(detectScript)) {
      try {
        const { stdout: detectOut } = await execFileAsync('bash', [detectScript, 'detect', '--json'], {
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

    const { stdout, stderr } = await execFileAsync(
      'docker',
      ['compose', '--profile', 'all', 'up', '-d', '--build', ...targetList],
      {
        cwd: rootDir,
        timeout: 180000 // 3 minutes
      }
    );

    return NextResponse.json({
      success: true,
      message: `Containers (${targetList.join(', ')}) spin-up initiated.`,
      services: targetList,
      profile: requestedProfile || (requestedServices.length > 0 ? 'custom' : 'all'),
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
