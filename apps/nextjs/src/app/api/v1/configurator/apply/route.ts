import { NextResponse } from 'next/server';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { getOrCreateAuthConfig } from '@eluvix/router-core';
import { resolveCallerIdentity } from '@/lib/caller-identity';

export const dynamic = 'force-dynamic';

interface SelectedModel {
  id: string;
  name: string;
  contextLimit: number;
  outputLimit: number;
}

interface ApplyRequestBody {
  client: 'opencode' | 'continue';
  protocol: 'https' | 'http';
  models: SelectedModel[];
}

function atomicWriteFile(filePath: string, content: string): void {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  }
  const tmpPath = `${filePath}.tmp.${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  try {
    fs.writeFileSync(tmpPath, content, { encoding: 'utf8', mode: 0o600 });
    fs.renameSync(tmpPath, filePath);
    try {
      fs.chmodSync(filePath, 0o600);
    } catch {}
  } catch (err) {
    try {
      if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath);
    } catch {}
    throw err;
  }
}

export async function POST(req: Request) {
  try {
    const caller = await resolveCallerIdentity(req);
    if (!caller.ok || caller.role !== 'admin') {
      return NextResponse.json(
        { success: false, error: 'Forbidden: only admin can modify client configuration files.' },
        { status: 403 }
      );
    }

    const body = (await req.json()) as ApplyRequestBody;
    const { client, protocol, models } = body;

    if (!client || !models || !Array.isArray(models)) {
      return NextResponse.json(
        { success: false, error: 'Invalid request: client and models array are required.' },
        { status: 400 }
      );
    }

    const auth = getOrCreateAuthConfig();
    const envHost = process.env.ELUVIX_HOST;
    const rawHost = process.env.HOSTNAME || '';
    const hostname = envHost || (!rawHost || /^[0-9a-f]{12,}$/i.test(rawHost) || rawHost === '0.0.0.0' ? '127.0.0.1' : rawHost);
    const httpsPort = parseInt(process.env.PORT || '3588', 10);
    const httpPort = parseInt(process.env.HTTP_PORT || '3580', 10);
    const baseURL = protocol === 'http'
      ? `http://${hostname}:${httpPort}/api/v1`
      : `https://${hostname}:${httpsPort}/api/v1`;

    const homeDir = os.homedir();
    const xdgConfigHome = process.env.XDG_CONFIG_HOME || path.join(homeDir, '.config');
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');

    if (client === 'opencode') {
      const opencodeDir = path.join(xdgConfigHome, 'opencode');
      const opencodePath = path.join(opencodeDir, 'opencode.json');

      if (!fs.existsSync(opencodeDir)) {
        fs.mkdirSync(opencodeDir, { recursive: true });
      }

      let opencodeConfig: any = {
        $schema: 'https://opencode.ai/config.json',
        autoupdate: false,
        provider: {}
      };

      if (fs.existsSync(opencodePath)) {
        try {
          const raw = fs.readFileSync(opencodePath, 'utf8');
          opencodeConfig = JSON.parse(raw);
          // Create backup
          const backupPath = `${opencodePath}.bak-${timestamp}`;
          fs.writeFileSync(backupPath, raw, { encoding: 'utf8', mode: 0o600 });
        } catch (err: any) {
          console.warn('[Configurator] Could not parse existing opencode.json:', err.message);
        }
      }

      if (!opencodeConfig.provider) {
        opencodeConfig.provider = {};
      }

      // Build models map
      const modelsMap: Record<string, { limit: { context: number; output: number }; name: string }> = {};
      models.forEach(m => {
        modelsMap[m.id] = {
          name: m.name,
          limit: {
            context: m.contextLimit || 32768,
            output: m.outputLimit || 4096,
          }
        };
      });

      opencodeConfig.provider.Eluvix = {
        name: 'Eluvix Router (local)',
        npm: '@ai-sdk/openai-compatible',
        options: {
          apiKey: auth.adminPassword,
          baseURL: baseURL
        },
        models: modelsMap
      };

      // Ensure default model and small_model are configured
      opencodeConfig.model = 'Eluvix/auto';
      opencodeConfig.small_model = 'Eluvix/auto';

      atomicWriteFile(opencodePath, JSON.stringify(opencodeConfig, null, 2));

      return NextResponse.json({
        success: true,
        client: 'opencode',
        filePath: opencodePath,
        modelCount: models.length,
        message: `Successfully updated ${opencodePath} with ${models.length} Eluvix model(s).`
      });
    } else if (client === 'continue') {
      const continueDir = path.join(homeDir, '.continue');
      const continuePath = path.join(continueDir, 'config.json');

      if (!fs.existsSync(continueDir)) {
        fs.mkdirSync(continueDir, { recursive: true });
      }

      let continueConfig: any = {
        models: [],
        customCommands: [],
        tabAutocompleteModel: undefined
      };

      if (fs.existsSync(continuePath)) {
        try {
          const raw = fs.readFileSync(continuePath, 'utf8');
          continueConfig = JSON.parse(raw);
          // Create backup
          const backupPath = `${continuePath}.bak-${timestamp}`;
          atomicWriteFile(backupPath, raw);
        } catch (err: any) {
          console.warn('[Configurator] Could not parse existing continue config.json:', err.message);
        }
      }

      if (!Array.isArray(continueConfig.models)) {
        continueConfig.models = [];
      }

      // Filter out previous Eluvix models
      continueConfig.models = continueConfig.models.filter((m: any) => {
        const isEluvixBase = m.apiBase && (
          m.apiBase.includes(':3588') || m.apiBase.includes(':3580') ||
          m.apiBase.includes(':3000') || m.apiBase.includes(':3080')
        );
        const isEluvixTitle = m.title && m.title.toLowerCase().includes('eluvix');
        return !(isEluvixBase || isEluvixTitle);
      });

      // Add selected models
      models.forEach(m => {
        continueConfig.models.push({
          title: `Eluvix - ${m.name.replace(' (via Eluvix Router)', '').replace(' (via Eluvix)', '')}`,
          provider: 'openai',
          model: m.id,
          apiBase: baseURL,
          apiKey: auth.adminPassword,
          contextLength: m.contextLimit
        });
      });

      atomicWriteFile(continuePath, JSON.stringify(continueConfig, null, 2));

      return NextResponse.json({
        success: true,
        client: 'continue',
        filePath: continuePath,
        modelCount: models.length,
        message: `Successfully updated ${continuePath} with ${models.length} Eluvix model(s).`
      });
    }

    return NextResponse.json({ success: false, error: `Unsupported client: ${client}` }, { status: 400 });
  } catch (err: any) {
    return NextResponse.json({ success: false, error: err.message }, { status: 500 });
  }
}
