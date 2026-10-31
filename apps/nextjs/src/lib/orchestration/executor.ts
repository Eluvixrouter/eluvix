import { spawn } from 'node:child_process';
import path from 'node:path';

export const ALLOWED_EXECUTABLES = new Set([
  'k3d',
  'kubectl',
  'helm',
  'docker',
  'bash',
  'node',
  'pnpm'
]);

export interface CommandExecutionResult {
  command: string;
  args: string[];
  exitCode: number;
  stdout: string;
  stderr: string;
  success: boolean;
  durationMs: number;
}

/**
 * Validates and executes an allowlisted command safely without shell injection.
 */
export async function executeSafeCommand(
  executable: string,
  args: string[],
  options: {
    cwd?: string;
    env?: Record<string, string>;
    timeoutMs?: number;
  } = {}
): Promise<CommandExecutionResult> {
  const baseCmd = path.basename(executable);
  if (!ALLOWED_EXECUTABLES.has(baseCmd)) {
    throw new Error(`Execution denied: '${baseCmd}' is not in the orchestrator allowlist.`);
  }

  const startTime = Date.now();
  const timeoutMs = options.timeoutMs || 120000; // 2 minute default timeout

  return new Promise((resolve, reject) => {
    let stdout = '';
    let stderr = '';
    let timedOut = false;

    const child = spawn(executable, args, {
      cwd: options.cwd || process.cwd(),
      env: { ...process.env, ...options.env },
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe']
    });

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
    }, timeoutMs);

    child.stdout.on('data', (data) => {
      stdout += data.toString();
    });

    child.stderr.on('data', (data) => {
      stderr += data.toString();
    });

    child.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });

    child.on('close', (code) => {
      clearTimeout(timer);
      const durationMs = Date.now() - startTime;
      if (timedOut) {
        resolve({
          command: executable,
          args,
          exitCode: -1,
          stdout,
          stderr: stderr + `\nCommand timed out after ${timeoutMs}ms`,
          success: false,
          durationMs
        });
      } else {
        resolve({
          command: executable,
          args,
          exitCode: code ?? 0,
          stdout,
          stderr,
          success: code === 0,
          durationMs
        });
      }
    });
  });
}
