import { NextResponse } from 'next/server';
import dns from 'node:dns/promises';
import { probeComfyUISystemStatus } from '@eluvix/router-core/comfyui';
import { resolveCallerIdentity } from '@/lib/caller-identity';

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
    // Allow probeComfyUISystemStatus to report online: false cleanly
  }
  return false;
}

/**
 * GET /api/v1/comfyui/status?endpoint=http://127.0.0.1:8188
 * Probes ComfyUI `/system_stats` and `/queue` to surface live GPU VRAM
 * and queue depth inside ComfyUINode in the Eluvix Visual Node Routing Editor.
 */
export async function GET(req: Request) {
  const caller = await resolveCallerIdentity(req);
  if (!caller.ok) {
    return NextResponse.json({ online: false, error: 'Unauthorized' }, { status: 401 });
  }

  let reqUrl: URL;
  try {
    reqUrl = new URL(req.url);
  } catch {
    return NextResponse.json({ online: false, error: 'Invalid request URL' }, { status: 400 });
  }

  const endpoint = (reqUrl.searchParams.get('endpoint') || 'http://127.0.0.1:8188').trim();
  let parsed: URL;
  try {
    parsed = new URL(endpoint);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return NextResponse.json(
        { online: false, error: 'Only http and https ComfyUI endpoints are supported' },
        { status: 400 }
      );
    }
  } catch {
    return NextResponse.json(
      { online: false, error: 'Invalid ComfyUI endpoint URL' },
      { status: 400 }
    );
  }

  if (await isMetadataEndpoint(parsed.hostname)) {
    return NextResponse.json(
      { online: false, error: 'Blocked cloud metadata endpoint' },
      { status: 403 }
    );
  }

  const status = await probeComfyUISystemStatus(endpoint, 4000);
  return NextResponse.json(status);
}
