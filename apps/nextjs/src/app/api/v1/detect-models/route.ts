import { NextResponse } from 'next/server';
import { detectUpstreamModelDetails, UpstreamConfig } from '@eluvix/router-core';
import { getRouter, getConfig, saveConfig } from '@/lib/router';
import { resolveCallerIdentity } from '@/lib/caller-identity';

import dns from 'node:dns/promises';

export const dynamic = 'force-dynamic';

function isMetadataHost(hostname: string): boolean {
  let host = hostname.toLowerCase().replace(/^\[|\]$/g, '').trim();
  if (host.startsWith('::ffff:')) {
    const mapped = host.slice(7);
    const hexMatch = mapped.match(/^([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i);
    if (hexMatch) {
      const high = parseInt(hexMatch[1], 16);
      const low = parseInt(hexMatch[2], 16);
      host = `${(high >>> 8) & 255}.${high & 255}.${(low >>> 8) & 255}.${low & 255}`;
    } else {
      host = mapped;
    }
  }
  return host === '169.254.169.254' || host.startsWith('169.254.') || host === 'metadata.google.internal' || host === 'metadata' || host === 'instance-data';
}

async function isMetadataEndpoint(hostname: string): Promise<boolean> {
  if (isMetadataHost(hostname)) return true;
  try {
    const records = await dns.lookup(hostname, { all: true });
    for (const rec of records) {
      if (isMetadataHost(rec.address)) return true;
    }
  } catch {}
  return false;
}

export async function POST(req: Request) {
  try {
    const caller = await resolveCallerIdentity(req);
    if (!caller.ok) {
      return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 });
    }

    const body = await req.json();

    // If batch detect across all configured upstreams requested
    if (body.all) {
      const router = getRouter();
      const currentConfig = getConfig();
      const detectedMap = await router.detectAllModels(5000);

      // Persist any newly detected models into the active config
      let updatedAny = false;
      const updatedUpstreams = currentConfig.upstreams.map(u => {
        const found = detectedMap[u.id];
        if (found && found.length > 0) {
          updatedAny = true;
          return { ...u, models: found };
        }
        return u;
      });

      if (updatedAny) {
        saveConfig({ ...currentConfig, upstreams: updatedUpstreams });
      }

      const returnedConfig = getConfig();
      if (caller.role !== 'admin') {
        returnedConfig.upstreams = returnedConfig.upstreams.map(u => ({
          ...u,
          apiKey: u.apiKey ? '[REDACTED]' : undefined,
        }));
      }

      return NextResponse.json({
        success: true,
        detected: detectedMap,
        config: returnedConfig
      });
    }

    // Validate endpoint if provided directly (allow local/LAN LLM servers, cli://, and acp://, block cloud metadata)
    const rawEndpoint = String(body.endpoint || '');
    if (body.endpoint && !rawEndpoint.startsWith('cli://') && !rawEndpoint.startsWith('acp://')) {
      try {
        const u = new URL(body.endpoint);
        if (u.protocol !== 'http:' && u.protocol !== 'https:') {
          return NextResponse.json(
            { success: false, error: 'Only http and https endpoint protocols are supported' },
            { status: 400 }
          );
        }
        if (await isMetadataEndpoint(u.hostname)) {
          return NextResponse.json(
            { success: false, error: 'Access to cloud metadata addresses is blocked' },
            { status: 403 }
          );
        }
      } catch {
        return NextResponse.json(
          { success: false, error: 'Invalid endpoint URL provided' },
          { status: 400 }
        );
      }
    }

    // Single upstream detect: either by ID or by passed config object
    let targetUpstream: UpstreamConfig | undefined;
    if (body.id) {
      const currentConfig = getConfig();
      const saved = currentConfig.upstreams.find(u => u.id === body.id);
      if (saved) {
        if (body.type && body.type !== saved.type && caller.role !== 'admin') {
          return NextResponse.json(
            { success: false, error: 'Forbidden: only admin can change upstream type during detection' },
            { status: 403 }
          );
        }
        const endpointChanged = Boolean(body.endpoint && body.endpoint.trim() !== saved.endpoint.trim());
        if (endpointChanged && caller.role !== 'admin') {
          return NextResponse.json(
            { success: false, error: 'Forbidden: only admin can probe alternate endpoints for saved upstreams' },
            { status: 403 }
          );
        }
        targetUpstream = {
          ...saved,
          endpoint: body.endpoint || saved.endpoint,
          type: saved.type,
          harness: body.harness || saved.harness,
          // Never send a stored API key to a newly changed endpoint host
          apiKey: endpointChanged ? body.apiKey : (body.apiKey || saved.apiKey)
        };
      }
    }

    if (!targetUpstream && body.endpoint) {
      targetUpstream = {
        id: body.id || 'custom-detect',
        name: body.name || 'Custom Node',
        type: body.type || (rawEndpoint.startsWith('acp://') ? 'harness' : 'openai-compatible'),
        endpoint: body.endpoint,
        apiKey: body.apiKey,
        priority: 1,
        models: [],
        ...(body.harness ? { harness: body.harness } : {})
      };
    }

    if (!targetUpstream) {
      return NextResponse.json(
        { success: false, error: 'Please specify an upstream ID or endpoint URL to detect models from.' },
        { status: 400 }
      );
    }

    const discovery = await detectUpstreamModelDetails(targetUpstream, 5000);

    return NextResponse.json({
      success: true,
      id: targetUpstream.id,
      endpoint: targetUpstream.endpoint,
      models: discovery.models,
      details: discovery.details,
      count: discovery.models.length,
      message: discovery.models.length > 0
        ? `Successfully detected ${discovery.models.length} model(s).`
        : `No models detected at ${targetUpstream.endpoint}. Make sure the server is running.`
    });
  } catch (error) {
    const err = error as Error;
    return NextResponse.json({ success: false, error: err.message }, { status: 500 });
  }
}
