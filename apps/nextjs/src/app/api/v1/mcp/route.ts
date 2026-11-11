import { NextResponse } from 'next/server';
import {
  ELUVIX_MCP_PROTOCOL_VERSION,
  ELUVIX_MCP_RESOURCES,
  ELUVIX_MCP_TOOLS,
  handleEluvixMcpPayload,
} from '@eluvix/router-core';
import { getConfig, getRouter } from '@/lib/router';
import { resolveCallerIdentity } from '@/lib/caller-identity';

export const dynamic = 'force-dynamic';

/**
 * Streamable-HTTP Model Context Protocol (MCP `2025-06-18`) Discovery / SSE Endpoint (`GET /api/v1/mcp`).
 * Authenticated via `Authorization: Bearer`, `x-api-key`, or NextAuth session.
 */
export async function GET(req: Request) {
  const caller = await resolveCallerIdentity(req);
  if (!caller.ok) {
    return NextResponse.json(
      {
        error: {
          message: 'Incorrect or missing API key provided.',
          type: 'authentication_error',
          code: 'invalid_api_key',
        },
      },
      { status: 401 }
    );
  }

  const accept = req.headers.get('accept') || '';
  if (accept.includes('text/event-stream')) {
    const encoder = new TextEncoder();
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(
          encoder.encode(
            `event: endpoint\ndata: ${JSON.stringify({
              protocolVersion: ELUVIX_MCP_PROTOCOL_VERSION,
              endpoint: '/api/v1/mcp',
            })}\n\n`
          )
        );
        controller.close();
      },
    });
    return new Response(stream, {
      status: 200,
      headers: {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache, no-transform',
        'mcp-protocol-version': ELUVIX_MCP_PROTOCOL_VERSION,
      },
    });
  }

  return NextResponse.json(
    {
      name: 'eluvix-sovereign-ai-os',
      protocolVersion: ELUVIX_MCP_PROTOCOL_VERSION,
      transport: 'streamable-http',
      tools: ELUVIX_MCP_TOOLS.map((t) => ({ name: t.name, description: t.description })),
      resources: ELUVIX_MCP_RESOURCES,
    },
    {
      status: 200,
      headers: {
        'mcp-protocol-version': ELUVIX_MCP_PROTOCOL_VERSION,
      },
    }
  );
}

/**
 * Streamable-HTTP Model Context Protocol (MCP `2025-06-18`) JSON-RPC 2.0 Endpoint (`POST /api/v1/mcp`).
 * Exposes Sovereign Eluvix tools (`eluvix_route_chat`, `eluvix_generate_media`, `eluvix_transcribe_or_speak`,
 * `eluvix_explain_route`, `eluvix_memory_query`, `eluvix_memory_store`, `eluvix_cluster_telemetry`)
 * with strict two-layer `elx_` authentication and `x-eluvix-hops` loop prevention.
 */
export async function POST(req: Request) {
  const caller = await resolveCallerIdentity(req);
  if (!caller.ok) {
    return NextResponse.json(
      {
        error: {
          message: 'Incorrect or missing API key provided.',
          type: 'authentication_error',
          code: 'invalid_api_key',
        },
      },
      { status: 401 }
    );
  }

  const incomingHops = Math.max(0, parseInt(req.headers.get('x-eluvix-hops') || '0', 10) || 0);
  if (incomingHops >= 2) {
    return NextResponse.json(
      {
        jsonrpc: '2.0',
        id: null,
        error: {
          code: -32000,
          message: `MCP recursion loop blocked (x-eluvix-hops=${incomingHops} >= 2).`,
        },
      },
      { status: 429, headers: { 'mcp-protocol-version': ELUVIX_MCP_PROTOCOL_VERSION } }
    );
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json(
      {
        jsonrpc: '2.0',
        id: null,
        error: { code: -32700, message: 'Parse error: invalid JSON body' },
      },
      { status: 400, headers: { 'mcp-protocol-version': ELUVIX_MCP_PROTOCOL_VERSION } }
    );
  }

  const config = getConfig();
  const router = getRouter();
  let proxyBaseUrl: string | undefined;
  try {
    proxyBaseUrl = new URL(req.url).origin;
  } catch {}

  const rpcResponse = await handleEluvixMcpPayload(body, {
    router,
    config,
    scope: { userId: caller.userId, origin: 'client' },
    hops: incomingHops,
    proxyBaseUrl,
    signal: req.signal,
  });

  if (rpcResponse === null) {
    return new Response(null, {
      status: 202,
      headers: { 'mcp-protocol-version': ELUVIX_MCP_PROTOCOL_VERSION },
    });
  }

  return NextResponse.json(rpcResponse, {
    status: 200,
    headers: {
      'mcp-protocol-version': ELUVIX_MCP_PROTOCOL_VERSION,
      'x-eluvix-hops': String(incomingHops + 1),
    },
  });
}
