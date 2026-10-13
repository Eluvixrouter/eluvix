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
    console.log(`[Docker Down] Executing docker compose down in ${rootDir}`);

    const { stdout, stderr } = await execAsync('docker compose down', {
      cwd: rootDir,
      timeout: 60000
    });

    return NextResponse.json({
      success: true,
      message: 'Containers stopped successfully.',
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
