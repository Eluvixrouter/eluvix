import { NextResponse } from 'next/server';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { createNamedApiKey, listNamedApiKeys, revokeNamedApiKey } from '@eluvix/router-core';
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

/**
 * Atomic write at mode 0o600 (audit H-11 follow-on): the files written
 * here contain an API key, and the rename makes the final file inherit
 * the tmp file's restrictive mode. The pre-existing tool configs may
 * hold OTHER providers' credentials too, so tightening them is a
 * deliberate, disclosed behavior change.
 */
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

/**
 * Mints the scoped named key a configured client will authenticate with
 * (audit H-11: client configs used to receive the master admin password).
 * One live key per client: keys minted by earlier applies for the same
 * client are revoked once the new config is safely on disk; if the write
 * fails, the NEW key is revoked instead so the previously written config
 * keeps working. Each client gets its own key identity (userId
 * `client-<name>`), which also partitions that client's memory scope.
 */
function mintClientKey(client: 'opencode' | 'continue'): {
  key: string;
  commit: () => void;
  rollback: () => void;
} {
  const label = `configurator:${client}`;
  const staleIds = listNamedApiKeys()
    .filter(k => k.label === label)
    .map(k => k.id);
  const created = createNamedApiKey({ label, origin: 'client', userId: `client-${client}` });
  return {
    key: created.key,
    commit: () => {
      for (const id of staleIds) {
        try {
          revokeNamedApiKey(id);
        } catch {}
      }
    },
    rollback: () => {
      try {
        revokeNamedApiKey(created.id);
      } catch {}
    }
  };
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
          // Create backup (mode-aware write: the backup contains the
          // previous config, credentials included)
          const backupPath = `${opencodePath}.bak-${timestamp}`;
          atomicWriteFile(backupPath, raw);
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

      // Scoped per-client key, NOT the master admin password (H-11).
      const minted = mintClientKey('opencode');
      opencodeConfig.provider.Eluvix = {
        name: 'Eluvix Router (local)',
        npm: '@ai-sdk/openai-compatible',
        options: {
          apiKey: minted.key,
          baseURL: baseURL
        },
        models: modelsMap
      };

      // Ensure default model and small_model are configured
      opencodeConfig.model = 'Eluvix/auto';
      opencodeConfig.small_model = 'Eluvix/auto';

      try {
        atomicWriteFile(opencodePath, JSON.stringify(opencodeConfig, null, 2));
        minted.commit();
      } catch (err) {
        minted.rollback();
        throw err;
      }

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

      // Scoped per-client key, NOT the master admin password (H-11).
      const minted = mintClientKey('continue');

      // Add selected models
      models.forEach(m => {
        continueConfig.models.push({
          title: `Eluvix - ${m.name.replace(' (via Eluvix Router)', '').replace(' (via Eluvix)', '')}`,
          provider: 'openai',
          model: m.id,
          apiBase: baseURL,
          apiKey: minted.key,
          contextLength: m.contextLimit
        });
      });

      try {
        atomicWriteFile(continuePath, JSON.stringify(continueConfig, null, 2));
        minted.commit();
      } catch (err) {
        minted.rollback();
        throw err;
      }

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
