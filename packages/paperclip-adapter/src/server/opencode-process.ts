import { spawn, type ChildProcess } from 'node:child_process';
import net from 'node:net';

export async function findFreeLoopbackPort(): Promise<number> {
  return await new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      srv.close((err) => (err ? reject(err) : resolve(port)));
    });
  });
}

export function buildOpenCodeConfigContent(opts: {
  eluvixBaseUrl: string;
  eluvixApiKey: string;
  model: string;
  paperclipHeaders: Record<string, string>;
  egressPolicy?: string;
  runtimeMcp?: { url?: string; token?: string };
}): string {
  const headers: Record<string, string> = {
    ...opts.paperclipHeaders,
  };
  if (opts.egressPolicy && opts.egressPolicy !== 'inherit') {
    headers['x-eluvix-egress'] = opts.egressPolicy;
  }

  const normalizedModel = opts.model.trim() || 'eluvix/auto';
  const modelKey = normalizedModel.startsWith('eluvix/')
    ? normalizedModel.slice('eluvix/'.length)
    : normalizedModel;

  const configObj: Record<string, unknown> = {
    $schema: 'https://opencode.ai/config.json',
    provider: {
      eluvix: {
        npm: '@ai-sdk/openai-compatible',
        name: 'Eluvix Switchyard',
        options: {
          baseURL: `${opts.eluvixBaseUrl.replace(/\/$/, '')}/v1`,
          apiKey: opts.eluvixApiKey,
          headers,
        },
        models: {
          [modelKey]: {
            name: normalizedModel,
          },
        },
      },
    },
    model: `eluvix/${modelKey}`,
  };

  if (opts.runtimeMcp?.url) {
    configObj.mcp = {
      paperclip: {
        type: 'remote',
        url: opts.runtimeMcp.url,
        ...(opts.runtimeMcp.token
          ? { headers: { Authorization: `Bearer ${opts.runtimeMcp.token}` } }
          : {}),
      },
    };
  }

  return JSON.stringify(configObj);
}

export interface SpawnedOpenCodeServer {
  baseUrl: string;
  port: number;
  proc: ChildProcess;
  stop: () => Promise<void>;
}

export async function spawnOpenCodeServer(opts: {
  binary: string;
  cwd: string;
  env: Record<string, string | undefined>;
  signal?: AbortSignal;
  onLog: (stream: 'stdout' | 'stderr', chunk: string) => void | Promise<void>;
}): Promise<SpawnedOpenCodeServer> {
  const port = await findFreeLoopbackPort();
  const baseUrl = `http://127.0.0.1:${port}`;

  const proc = spawn(
    opts.binary,
    ['serve', '--hostname', '127.0.0.1', '--port', String(port)],
    {
      cwd: opts.cwd,
      env: opts.env as NodeJS.ProcessEnv,
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: false,
    }
  );

  proc.stdout?.on('data', (d) => {
    void opts.onLog('stdout', String(d));
  });
  proc.stderr?.on('data', (d) => {
    void opts.onLog('stderr', String(d));
  });

  const stop = async () => {
    if (proc.killed || proc.exitCode !== null) return;
    proc.kill('SIGTERM');
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        try {
          if (proc.exitCode === null) proc.kill('SIGKILL');
        } catch {}
        resolve();
      }, 3000);
      proc.once('exit', () => {
        clearTimeout(timer);
        resolve();
      });
    });
  };

  if (opts.signal) {
    if (opts.signal.aborted) {
      await stop();
      throw new Error('Execution aborted');
    }
    opts.signal.addEventListener('abort', () => {
      void stop();
    });
  }

  // Poll readiness on /global/health or /session
  const deadline = Date.now() + 15_000;
  let ready = false;
  while (Date.now() < deadline) {
    if (proc.exitCode !== null) {
      throw new Error(`opencode serve exited prematurely with code ${proc.exitCode}`);
    }
    try {
      const res = await fetch(`${baseUrl}/session`);
      if (res.ok || res.status === 404) {
        ready = true;
        break;
      }
    } catch {
      // keep polling
    }
    await new Promise((r) => setTimeout(r, 150));
  }

  if (!ready) {
    await stop();
    throw new Error(`Timed out waiting for opencode serve on ${baseUrl}`);
  }

  return { baseUrl, port, proc, stop };
}
