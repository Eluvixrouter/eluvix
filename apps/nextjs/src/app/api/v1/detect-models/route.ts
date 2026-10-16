import { NextResponse } from 'next/server';
import { detectUpstreamModelDetails, UpstreamConfig } from '@eluvix/router-core';
import { getRouter, getConfig, saveConfig } from '@/lib/router';

export const dynamic = 'force-dynamic';

function isMetadataHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, '').replace(/^::ffff:/, '').trim();
  return host === '169.254.169.254' || host.startsWith('169.254.') || host === 'metadata.google.internal';
}

export async function POST(req: Request) {
  try {
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

      return NextResponse.json({
        success: true,
        detected: detectedMap,
        config: getConfig()
      });
    }

    // Validate endpoint if provided directly (allow local/LAN LLM servers, block cloud metadata)
    if (body.endpoint && !String(body.endpoint).startsWith('cli://')) {
      try {
        const u = new URL(body.endpoint);
        if (u.protocol !== 'http:' && u.protocol !== 'https:') {
          return NextResponse.json(
            { success: false, error: 'Only http and https endpoint protocols are supported' },
            { status: 400 }
          );
        }
        if (isMetadataHost(u.hostname)) {
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
        const endpointChanged = Boolean(body.endpoint && body.endpoint.trim() !== saved.endpoint.trim());
        targetUpstream = {
          ...saved,
          endpoint: body.endpoint || saved.endpoint,
          type: body.type || saved.type,
          // Never send a stored API key to a newly changed endpoint host
          apiKey: endpointChanged ? body.apiKey : (body.apiKey || saved.apiKey)
        };
      }
    }

    if (!targetUpstream && body.endpoint) {
      targetUpstream = {
        id: body.id || 'custom-detect',
        name: body.name || 'Custom Node',
        type: body.type || 'openai-compatible',
        endpoint: body.endpoint,
        apiKey: body.apiKey,
        priority: 1,
        models: []
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
