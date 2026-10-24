import vm from 'node:vm';

export interface SandboxConfig {
  enabled?: boolean;
  runtime?: 'docker-local' | 'daytona' | 'e2b';
  endpoint?: string;
  image?: string;
  networkPolicy?: 'none' | 'local-only' | 'bridge';
  timeoutSec?: number;
  memoryLimitMb?: number;
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

  // First try remote/sidecar sandbox container if configured
  if (config?.enabled !== false) {
    try {
      const res = await fetch(`${endpoint}/v1/execute`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          code,
          runtime,
          image: config?.image || 'node:22-alpine',
          networkPolicy: config?.networkPolicy || 'none',
          timeoutMs,
          memoryLimitMb: config?.memoryLimitMb ?? 512
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
    } catch {
      // Fall back to in-process isolated vm.Context when sidecar is not running
    }
  }

  const logs: string[] = [];
  try {
    const sandboxConsole = {
      log: (...args: unknown[]) => logs.push(args.map(String).join(' ')),
      error: (...args: unknown[]) => logs.push(args.map(String).join(' '))
    };
    const ctx = vm.createContext({ console: sandboxConsole, Math, JSON, Date });
    const val = vm.runInContext(code, ctx, { timeout: timeoutMs });
    return {
      exitCode: 0,
      stdout: logs.join('\n'),
      result: val !== undefined ? String(val) : undefined,
      durationMs: Date.now() - start,
      runtimeUsed: 'isolated-vm-fallback'
    };
  } catch (err) {
    return {
      exitCode: 1,
      stdout: logs.join('\n'),
      stderr: err instanceof Error ? err.message : String(err),
      durationMs: Date.now() - start,
      runtimeUsed: 'isolated-vm-fallback'
    };
  }
}
