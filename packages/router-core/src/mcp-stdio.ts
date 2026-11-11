#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { Eluvix, getAppPaths, type RouterConfig } from './index.js';
import { handleEluvixMcpPayload } from './mcp-server.js';

function loadConfigForStdio(explicitPath?: string): RouterConfig {
  const targetPath =
    explicitPath ||
    process.env.ELUVIX_CONFIG_PATH ||
    path.join(getAppPaths('eluvix').configDir, 'config.json');

  try {
    if (fs.existsSync(targetPath)) {
      const parsed = JSON.parse(fs.readFileSync(targetPath, 'utf-8'));
      if (parsed && Array.isArray(parsed.upstreams)) {
        return parsed as RouterConfig;
      }
    }
  } catch (err: any) {
    process.stderr.write(`[eluvix-mcp] Warning: failed to parse ${targetPath}: ${err?.message}\n`);
  }

  return {
    egressPolicy: 'local-only',
    upstreams: [
      {
        id: 'local-ollama',
        name: 'Local Ollama',
        type: 'ollama',
        endpoint: 'http://127.0.0.1:11434',
        priority: 20,
        models: ['*'],
      },
    ],
  };
}

export async function runEluvixMcpStdioServer(argv: string[] = process.argv.slice(2)): Promise<void> {
  // Redirect console.log / info / warn to stderr so stdout remains pure JSON-RPC 2.0 NDJSON
  const writeStderr = (...args: unknown[]) => {
    process.stderr.write(args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' ') + '\n');
  };
  console.log = writeStderr;
  console.info = writeStderr;
  console.warn = writeStderr;

  let configPath: string | undefined;
  let userId = process.env.ELUVIX_USER_ID || 'default';

  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--config' && argv[i + 1]) {
      configPath = argv[++i];
    } else if (argv[i] === '--user' && argv[i + 1]) {
      userId = argv[++i];
    }
  }

  const rl = readline.createInterface({
    input: process.stdin,
    crlfDelay: Infinity,
  });

  for await (const rawLine of rl) {
    const trimmed = rawLine.trim();
    if (!trimmed) continue;

    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      process.stdout.write(
        JSON.stringify({
          jsonrpc: '2.0',
          id: null,
          error: { code: -32700, message: 'Parse error: invalid JSON on stdin' },
        }) + '\n'
      );
      continue;
    }

    const config = loadConfigForStdio(configPath);
    const router = new Eluvix(config);
    const response = await handleEluvixMcpPayload(parsed, {
      router,
      config,
      scope: { userId },
      hops: 0,
    });

    if (response !== null) {
      process.stdout.write(JSON.stringify(response) + '\n');
    }
  }
}

const isDirectExecution =
  typeof process !== 'undefined' &&
  Array.isArray(process.argv) &&
  Boolean(process.argv[1]) &&
  /mcp-stdio(?:\.[cm]?[jt]s)?$/.test(process.argv[1]);

if (isDirectExecution) {
  runEluvixMcpStdioServer().catch((err) => {
    process.stderr.write(`[eluvix-mcp] Fatal error: ${err?.message || err}\n`);
    process.exit(1);
  });
}
