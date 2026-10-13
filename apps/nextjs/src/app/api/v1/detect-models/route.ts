import { NextResponse } from 'next/server';
import { detectUpstreamModelDetails, UpstreamConfig } from '@eluvix/router-core';
import { getRouter, getConfig, saveConfig } from '@/lib/router';

export const dynamic = 'force-dynamic';

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

    // Single upstream detect: either by ID or by passed config object
    let targetUpstream: UpstreamConfig | undefined;
    if (body.id) {
      const currentConfig = getConfig();
      targetUpstream = currentConfig.upstreams.find(u => u.id === body.id);
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
