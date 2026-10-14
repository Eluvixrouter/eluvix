import { NextResponse } from 'next/server';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { getOrCreateAuthConfig, getAppPaths, getCachedAntigravityModels } from '@eluvix/router-core';
import { getRouter } from '@/lib/router';

export const dynamic = 'force-dynamic';

interface ModelMetadata {
  id: string;
  name: string;
  contextLimit: number;
  outputLimit: number;
  provider: string;
  isFrontier?: boolean;
  isCode?: boolean;
}

function resolveHostname(): string {
  const envHost = process.env.ELUVIX_HOST;
  if (envHost) return envHost;
  const raw = process.env.HOSTNAME || '';
  if (!raw || /^[0-9a-f]{12,}$/i.test(raw) || raw === '0.0.0.0') {
    return '127.0.0.1';
  }
  return raw;
}

export async function GET() {
  try {
    const auth = getOrCreateAuthConfig();
    const hostname = resolveHostname();
    const httpsPort = parseInt(process.env.PORT || '3000', 10);
    const httpPort = parseInt(process.env.HTTP_PORT || '3080', 10);
    const httpsBaseUrl = `https://${hostname}:${httpsPort}/api/v1`;
    const httpBaseUrl = `http://${hostname}:${httpPort}/api/v1`;

    const homeDir = os.homedir();
    const xdgConfigHome = process.env.XDG_CONFIG_HOME || path.join(homeDir, '.config');

    // Check CA root cert path
    const { configDir } = getAppPaths('eluvix');
    let rootCaPath: string | null = null;
    const tlsDir = path.join(configDir, 'tls');
    const candidateCa = path.join(tlsDir, 'rootCA.pem');
    if (fs.existsSync(candidateCa)) {
      rootCaPath = candidateCa;
    }

    // Check OpenCode config detection
    const opencodeDir = path.join(xdgConfigHome, 'opencode');
    const opencodeConfig = path.join(opencodeDir, 'opencode.json');
    const opencodeInstalled = fs.existsSync(opencodeDir) || fs.existsSync(opencodeConfig);

    // Check Continue config detection
    const continueDir = path.join(homeDir, '.continue');
    const continueConfig = path.join(continueDir, 'config.json');
    const continueInstalled = fs.existsSync(continueDir) || fs.existsSync(continueConfig);

    // Aggregate models from router and upstreams
    const router = getRouter();
    const upstreams = router.getUpstreams();

    const modelList: ModelMetadata[] = [];
    const seenModelIds = new Set<string>();

    // 1. Add Auto-Router synthetic model
    modelList.push({
      id: 'auto',
      name: 'Auto (Intelligent Mesh Router)',
      contextLimit: 131072,
      outputLimit: 4096,
      provider: 'Eluvix Switchyard',
      isFrontier: true,
      isCode: true
    });
    seenModelIds.add('auto');

    // 2. Discover models from all active upstreams
    const agyCatalog = getCachedAntigravityModels();
    for (const upstream of upstreams) {
      const models = [...(upstream.models || [])];
      if (upstream.type === 'antigravity' || upstream.endpoint?.startsWith('cli://')) {
        for (const entry of agyCatalog) {
          if (!models.includes(entry.baseId)) {
            models.push(entry.baseId);
          }
        }
      }
      for (const m of models) {
        if (!m || m === '*' || seenModelIds.has(m)) continue;
        seenModelIds.add(m);

        let contextLimit = 32768;
        let outputLimit = 4096;
        let isFrontier = false;
        let isCode = false;

        const lower = m.toLowerCase();
        if (lower.includes('70b') || lower.includes('sonnet') || lower.includes('opus') || lower.includes('120b') || lower.includes('gpt-4') || lower.includes('gemini') || lower.includes('frontier')) {
          isFrontier = true;
          contextLimit = 131072;
        }
        if (lower.includes('gemini-4') || lower.includes('argon') || lower.includes('argo')) {
          contextLimit = 2097152;
          outputLimit = 65536;
        } else if (lower.includes('gemini-3.8')) {
          contextLimit = 1048576;
          outputLimit = 65536;
        } else if (lower.includes('opus') || lower.includes('sonnet')) {
          contextLimit = 200000;
          outputLimit = 65536;
        } else if (lower.includes('120b')) {
          contextLimit = 131072;
          outputLimit = 8192;
        }
        if (lower.includes('coder') || lower.includes('claude-code') || lower.includes('agy') || lower.includes('codex') || lower.includes('instruct')) {
          isCode = true;
        }
        if (lower.includes('qwen') || lower.includes('llama3.2') || lower.includes('gpt-oss')) {
          contextLimit = 131072;
        }

        modelList.push({
          id: m,
          name: m,
          contextLimit,
          outputLimit,
          provider: upstream.name || upstream.type,
          isFrontier,
          isCode
        });
      }
    }

    return NextResponse.json({
      success: true,
      data: {
        server: {
          hostname,
          httpsPort,
          httpPort,
          httpsBaseUrl,
          httpBaseUrl,
          rootCaPath
        },
        auth: {
          adminPassword: auth.adminPassword,
          authFile: auth.authFile
        },
        clients: {
          opencode: {
            installed: opencodeInstalled,
            configPath: opencodeConfig
          },
          continue: {
            installed: continueInstalled,
            configPath: continueConfig
          }
        },
        models: modelList,
        upstreamsCount: upstreams.length
      }
    });
  } catch (err: any) {
    console.error('Failed to generate configurator data:', err);
    return NextResponse.json(
      { success: false, error: err.message || 'Internal server error' },
      { status: 500 }
    );
  }
}
