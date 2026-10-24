import { NextResponse } from 'next/server';
import { exec } from 'child_process';
import util from 'util';
import {
  DOCKER_SERVICE_CATALOG,
  type DockerServiceCategory,
  getRequiredServicesForConfig
} from '@/lib/docker-catalog';
import { getConfig } from '@/lib/router';

const execAsync = util.promisify(exec);

export const dynamic = 'force-dynamic';

export interface ServiceStatus {
  name: string;
  container: string;
  port: number;
  category: DockerServiceCategory;
  composeFile: string;
  description: string;
  requiredByTopology: boolean;
  running: boolean;
  status: 'running' | 'exited' | 'not_created';
  url: string;
}

export async function GET() {
  try {
    // 1. Check if docker binary exists
    let version = '';
    try {
      const { stdout } = await execAsync('docker --version', { timeout: 3000 });
      version = stdout.trim();
    } catch {
      return NextResponse.json({
        installed: false,
        running: false,
        version: null,
        composeVersion: null,
        services: [],
        message: 'Docker is not installed or not found on PATH.'
      });
    }

    // 2. Check docker compose version
    let composeVersion = '';
    try {
      const { stdout } = await execAsync('docker compose version', { timeout: 3000 });
      composeVersion = stdout.trim();
    } catch {
      composeVersion = 'unavailable';
    }

    // 3. Check if docker daemon is running
    let daemonRunning = false;
    try {
      await execAsync('docker info', { timeout: 4000 });
      daemonRunning = true;
    } catch {
      return NextResponse.json({
        installed: true,
        running: false,
        version,
        composeVersion,
        services: [],
        message: 'Docker CLI is installed, but the Docker daemon is not running.'
      });
    }

    // 4. Query container statuses using centralized catalog
    const activeConfig = getConfig();
    const requiredSet = new Set(getRequiredServicesForConfig(activeConfig));

    let runningContainers: string[] = [];
    let allContainers: string[] = [];

    try {
      const { stdout: psOut } = await execAsync('docker ps --format "{{.Names}}"', { timeout: 3000 });
      runningContainers = psOut.split('\n').map(s => s.trim()).filter(Boolean);

      const { stdout: psAllOut } = await execAsync('docker ps -a --format "{{.Names}}"', { timeout: 3000 });
      allContainers = psAllOut.split('\n').map(s => s.trim()).filter(Boolean);
    } catch (e) {
      console.error('Error inspecting docker containers:', e);
    }

    const services: ServiceStatus[] = DOCKER_SERVICE_CATALOG.map(srv => {
      const isRunning = runningContainers.includes(srv.container);
      const exists = allContainers.includes(srv.container);
      const status = isRunning ? 'running' : exists ? 'exited' : 'not_created';

      return {
        name: srv.name,
        container: srv.container,
        port: srv.port,
        category: srv.category,
        composeFile: srv.composeFile,
        description: srv.description,
        requiredByTopology: requiredSet.has(srv.name),
        running: isRunning,
        status,
        url: `http://localhost:${srv.port}`
      };
    });

    const allRunning = services.every(s => s.running);

    return NextResponse.json({
      installed: true,
      running: daemonRunning,
      version,
      composeVersion,
      allRunning,
      topologyServices: Array.from(requiredSet),
      services,
      message: allRunning
        ? `All ${services.length} containers are actively running.`
        : `${services.filter(s => s.running).length}/${services.length} containers currently active.`
    });
  } catch (error) {
    const err = error as Error;
    return NextResponse.json({
      installed: false,
      running: false,
      error: err.message
    }, { status: 500 });
  }
}
