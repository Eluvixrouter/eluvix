import vm from 'node:vm';

export interface SandboxConfig {
  enabled?: boolean;
  runtime?: 'docker-local' | 'daytona' | 'e2b';
  endpoint?: string;
  image?: string;
  networkPolicy?: 'none' | 'local-only' | 'bridge';
  allowNetwork?: boolean;
  timeoutSec?: number;
  memoryLimitMb?: number;
  cpuCores?: number;
}

export interface SandboxExecutionResult {
  exitCode: number;
  stdout: string;
  stderr?: string;
  result?: string;
  durationMs: number;
  runtimeUsed: string;
}

export async function executeInSandbox(
  code: string,
  config?: SandboxConfig,
  signal?: AbortSignal
): Promise<SandboxExecutionResult> {
  const start = Date.now();
  const timeoutMs = Math.min(60000, Math.max(500, (config?.timeoutSec ?? 15) * 1000));
  const endpoint = (config?.endpoint || 'http://localhost:3986').replace(/\/+$/, '');
  const runtime = config?.runtime || 'docker-local';

  // Execute in isolated container/remote sandbox sidecar
  if (config?.enabled === false) {
    return {
      exitCode: 1,
      stdout: '',
      stderr: 'Sandbox execution is disabled by configuration',
      durationMs: 0,
      runtimeUsed: 'disabled'
    };
  }

  // Remote or sidecar sandbox execution (docker-local, daytona, e2b)
  try {
    const res = await fetch(`${endpoint}/v1/execute`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        code,
        runtime,
        image: config?.image || 'node:22-alpine',
        networkPolicy: config?.allowNetwork ? (config?.networkPolicy || 'bridge') : (config?.networkPolicy || 'none'),
        allowNetwork: config?.allowNetwork ?? false,
        timeoutMs,
        memoryLimitMb: config?.memoryLimitMb ?? 512,
        cpuCores: config?.cpuCores ?? 1
      }),
      signal
    });
    if (res.ok) {
      const data: any = await res.json();
      return {
        exitCode: typeof data.exitCode === 'number' ? data.exitCode : 0,
        stdout: String(data.stdout || ''),
        stderr: data.stderr ? String(data.stderr) : undefined,
        result: data.result !== undefined ? String(data.result) : undefined,
        durationMs: typeof data.durationMs === 'number' ? data.durationMs : Date.now() - start,
        runtimeUsed: `${runtime}-sidecar`
      };
    }
    const errText = await res.text().catch(() => res.statusText);
    return {
      exitCode: 1,
      stdout: '',
      stderr: `Sandbox container execution failed (HTTP ${res.status}): ${errText}`,
      durationMs: Date.now() - start,
      runtimeUsed: `${runtime}-sidecar`
    };
  } catch (err: any) {
    // Fail-closed: Never silently fall open to in-process host VM execution for container runtimes
    return {
      exitCode: 1,
      stdout: '',
      stderr: `Sandbox sidecar unavailable at ${endpoint}: ${err instanceof Error ? err.message : String(err)}`,
      durationMs: Date.now() - start,
      runtimeUsed: `${runtime}-sidecar`
    };
  }
}
