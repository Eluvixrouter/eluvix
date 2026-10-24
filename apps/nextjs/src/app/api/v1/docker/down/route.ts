import { NextResponse } from 'next/server';
import { exec } from 'child_process';
import util from 'util';
import path from 'path';
import fs from 'fs';
import { isValidContainerName } from '@/lib/api-helpers';
import {
  type DockerServiceCategory,
  getServicesByCategory
} from '@/lib/docker-catalog';

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

export async function POST(req: Request) {
  try {
    const rootDir = getProjectRoot();

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

    if (
      requestedServices.length === 0 &&
      requestedProfile &&
      (requestedProfile === 'core' ||
        requestedProfile === 'inference' ||
        requestedProfile === 'memory' ||
        requestedProfile === 'harnesses')
    ) {
      requestedServices = getServicesByCategory(requestedProfile as DockerServiceCategory);
    }

    const cmd = requestedServices.length > 0
      ? `docker compose --profile all stop ${requestedServices.join(' ')}`
      : 'docker compose --profile all down';

    console.log(`[Docker Down] Executing "${cmd}" in ${rootDir}`);

    const { stdout, stderr } = await execAsync(cmd, {
      cwd: rootDir,
      timeout: 60000
    });

    return NextResponse.json({
      success: true,
      message: requestedServices.length > 0
        ? `Containers (${requestedServices.join(', ')}) stopped successfully.`
        : 'All containers stopped successfully.',
      services: requestedServices.length > 0 ? requestedServices : 'all',
      stdout: stdout.trim(),
      stderr: stderr.trim()
    });
  } catch (error) {
    const err = error as Error;
    console.error('[Docker Down Error]', err);
    return NextResponse.json({
      success: false,
      error: err.message
    }, { status: 500 });
  }
}
