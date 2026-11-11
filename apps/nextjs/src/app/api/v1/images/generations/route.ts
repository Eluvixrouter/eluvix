import { NextResponse } from 'next/server';
import { resolveBearerToken } from '@eluvix/router-core';
import { getRouter, getProviderAgent } from '@/lib/router';

export const dynamic = 'force-dynamic';

/**
 * Pillar 2: OpenAI-compatible `POST /v1/images/generations` endpoint backed by ComfyUI (:8188).
 * Accepts `{ prompt, model?, n?, size?, response_format?, quality?, style?, negative_prompt?, seed?, steps?, cfg? }`,
 * expands prompts via a wired local LLM if configured, submits the workflow DAG to
 * ComfyUI `POST /prompt`, polls `GET /history/{prompt_id}`, and returns standard
 * OpenAI `{ created, data: [{ url | b64_json, revised_prompt }] }`.
 */
export async function POST(req: Request) {
  const authHeader = req.headers.get('authorization');
  if (authHeader && authHeader.startsWith('Bearer ')) {
    const token = authHeader.slice(7).trim();
    if (token.startsWith('elx_')) {
      const resolved = resolveBearerToken(token);
      if (!resolved.valid) {
        return NextResponse.json(
          {
            error: {
              message: 'Incorrect API key provided.',
              type: 'invalid_request_error',
              code: 'invalid_api_key',
            },
          },
          { status: 401 }
        );
      }
    }
  }

  let body: any;
  try {
    body = await req.json();
  } catch (err: any) {
    return NextResponse.json(
      {
        error: {
          message: `Invalid JSON in request body: ${err?.message || 'parse error'}`,
          type: 'invalid_request_error',
          code: 'invalid_json',
        },
      },
      { status: 400 }
    );
  }

  if (!body || typeof body !== 'object') {
    return NextResponse.json(
      {
        error: {
          message: 'Request body must be a valid JSON object.',
          type: 'invalid_request_error',
          code: 'invalid_request',
        },
      },
      { status: 400 }
    );
  }

  // Prioritize interactive consumer activity: pause background GPU provider jobs while diffusion runs
  try {
    getProviderAgent().notifyConsumerActive(30000);
  } catch {
    // Ignore if provider agent isn't running
  }

  const hops = Math.max(0, parseInt(req.headers.get('x-eluvix-hops') || '0', 10) || 0);
  let proxyBaseUrl: string | undefined;
  if (body.proxy_urls !== false) {
    try {
      proxyBaseUrl = new URL(req.url).origin;
    } catch {
      proxyBaseUrl = undefined;
    }
  }

  const responseFormat =
    body.response_format === 'b64_json' || body.response_format === 'url'
      ? body.response_format
      : undefined;
  const quality =
    body.quality === 'hd' || body.quality === 'standard' ? body.quality : undefined;
  const style =
    body.style === 'vivid' || body.style === 'natural' ? body.style : undefined;

  const router = getRouter();
  return router.routeImageGeneration(
    {
      prompt: body.prompt,
      model: body.model,
      n: typeof body.n === 'number' ? body.n : undefined,
      size: typeof body.size === 'string' ? body.size : undefined,
      response_format: responseFormat,
      quality,
      style,
      negative_prompt: typeof body.negative_prompt === 'string' ? body.negative_prompt : undefined,
      seed: typeof body.seed === 'number' ? body.seed : undefined,
      steps: typeof body.steps === 'number' ? body.steps : undefined,
      cfg: typeof body.cfg === 'number' ? body.cfg : undefined,
    },
    { signal: req.signal, hops, proxyBaseUrl }
  );
}
