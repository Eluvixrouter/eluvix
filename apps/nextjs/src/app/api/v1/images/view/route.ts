import { NextResponse } from 'next/server';
import dns from 'node:dns/promises';
import { resolveBearerToken } from '@eluvix/router-core';
import { getConfig } from '@/lib/router';

export const dynamic = 'force-dynamic';

const ALLOWED_MEDIA_CONTENT_TYPES = new Set([
  'image/png',
  'image/jpeg',
  'image/webp',
  'image/gif',
  'image/svg+xml',
  'video/mp4',
  'video/webm',
  'model/gltf-binary',
  'application/octet-stream',
]);

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
  return (
    host === '169.254.169.254' ||
    host.startsWith('169.254.') ||
    host === 'metadata.google.internal' ||
    host === 'metadata' ||
    host === 'instance-data'
  );
}

async function isMetadataEndpoint(hostname: string): Promise<boolean> {
  if (isMetadataHost(hostname)) return true;
  try {
    const records = await dns.lookup(hostname, { all: true });
    for (const rec of records) {
      if (isMetadataHost(rec.address)) return true;
    }
  } catch {
    // Non-fatal DNS lookup miss; fetch will fail naturally if unreachable
  }
  return false;
}

function inferSafeMediaContentType(rawHeader: string | null, filename: string): string {
  const normalized = (rawHeader || '').split(';')[0].trim().toLowerCase();
  if (ALLOWED_MEDIA_CONTENT_TYPES.has(normalized) && normalized !== 'image/svg+xml') {
    return normalized;
  }
  const lower = filename.toLowerCase();
  if (lower.endsWith('.png')) return 'image/png';
  if (lower.endsWith('.jpg') || lower.endsWith('.jpeg')) return 'image/jpeg';
  if (lower.endsWith('.webp')) return 'image/webp';
  if (lower.endsWith('.gif')) return 'image/gif';
  if (lower.endsWith('.mp4')) return 'video/mp4';
  if (lower.endsWith('.webm')) return 'video/webm';
  if (lower.endsWith('.glb')) return 'model/gltf-binary';
  // Serve SVG or unknown extensions as non-executing binary unless explicitly downloaded
  return 'application/octet-stream';
}

/**
 * Authenticated HTTPS-safe media proxy for ComfyUI artifacts (`GET /api/v1/images/view`).
 * Resolves `upstream` strictly against configured `type === 'comfyui'` upstreams (never an
 * arbitrary caller-supplied URL) to prevent SSRF and mixed-content browser blocks.
 */
export async function GET(req: Request) {
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

  let url: URL;
  try {
    url = new URL(req.url);
  } catch {
    return NextResponse.json({ error: { message: 'Invalid request URL.' } }, { status: 400 });
  }

  const upstreamId = (url.searchParams.get('upstream') || '').trim();
  const filename = (url.searchParams.get('filename') || '').trim();
  const subfolder = (url.searchParams.get('subfolder') || '').trim();
  const folderType = (url.searchParams.get('type') || 'output').trim();

  if (!upstreamId) {
    return NextResponse.json(
      { error: { message: 'Missing required "upstream" query parameter.' } },
      { status: 400 }
    );
  }

  if (
    !filename ||
    filename.includes('..') ||
    filename.includes('/') ||
    filename.includes('\\') ||
    filename.includes('\0')
  ) {
    return NextResponse.json(
      { error: { message: 'Invalid "filename" query parameter.' } },
      { status: 400 }
    );
  }

  if (subfolder.includes('..') || subfolder.includes('\0')) {
    return NextResponse.json(
      { error: { message: 'Invalid "subfolder" query parameter.' } },
      { status: 400 }
    );
  }

  if (folderType !== 'output' && folderType !== 'temp' && folderType !== 'input') {
    return NextResponse.json(
      { error: { message: 'Invalid "type" query parameter (must be output, temp, or input).' } },
      { status: 400 }
    );
  }

  const config = getConfig();
  const configuredComfyUpstreams = (config.upstreams || []).filter(
    (u) => u.type === 'comfyui'
  );

  let targetEndpoint: string | undefined;
  const matchedUpstream = configuredComfyUpstreams.find((u) => u.id === upstreamId);
  if (matchedUpstream) {
    targetEndpoint = matchedUpstream.endpoint || 'http://127.0.0.1:8188';
  } else if (upstreamId === 'default-comfyui' && configuredComfyUpstreams.length === 0) {
    targetEndpoint = 'http://127.0.0.1:8188';
  }

  if (!targetEndpoint) {
    return NextResponse.json(
      { error: { message: `ComfyUI upstream "${upstreamId}" is not configured or is disabled.` } },
      { status: 404 }
    );
  }

  let parsedEndpoint: URL;
  try {
    parsedEndpoint = new URL(targetEndpoint);
    if (parsedEndpoint.protocol !== 'http:' && parsedEndpoint.protocol !== 'https:') {
      return NextResponse.json(
        { error: { message: 'Unsupported ComfyUI endpoint protocol.' } },
        { status: 400 }
      );
    }
  } catch {
    return NextResponse.json(
      { error: { message: 'Configured ComfyUI endpoint is not a valid URL.' } },
      { status: 500 }
    );
  }

  if (await isMetadataEndpoint(parsedEndpoint.hostname)) {
    return NextResponse.json(
      { error: { message: 'Blocked cloud metadata endpoint.' } },
      { status: 403 }
    );
  }

  const base = targetEndpoint.replace(/\/+$/, '').replace(/\/v1$/i, '');
  const viewParams = new URLSearchParams({
    filename,
    subfolder,
    type: folderType,
  });

  const headers: Record<string, string> = {};
  if (matchedUpstream?.apiKey) {
    headers['Authorization'] = `Bearer ${matchedUpstream.apiKey}`;
  }

  try {
    const res = await fetch(`${base}/view?${viewParams.toString()}`, {
      method: 'GET',
      headers,
      signal: req.signal,
    });

    if (!res.ok) {
      return NextResponse.json(
        { error: { message: `ComfyUI /view returned HTTP ${res.status}.` } },
        { status: res.status === 404 ? 404 : 502 }
      );
    }

    const contentType = inferSafeMediaContentType(res.headers.get('content-type'), filename);
    const body = await res.arrayBuffer();

    return new Response(body, {
      status: 200,
      headers: {
        'Content-Type': contentType,
        'X-Content-Type-Options': 'nosniff',
        'Cache-Control': 'private, max-age=3600',
        'Content-Security-Policy': "default-src 'none'; sandbox",
      },
    });
  } catch (err: any) {
    return NextResponse.json(
      { error: { message: `Failed to reach ComfyUI media endpoint: ${err?.message || 'network error'}` } },
      { status: 502 }
    );
  }
}
