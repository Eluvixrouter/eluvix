import { NextResponse } from 'next/server';
import {
  forwardHarnessRequest,
  saveChatMessage,
  upsertHarnessSession,
  type HarnessKind,
  type UpstreamConfig,
} from '@eluvix/router-core';
import { getRouter } from '@/lib/router';
import { resolveCallerIdentity } from '@/lib/caller-identity';

export const dynamic = 'force-dynamic';

export async function POST(req: Request) {
  let body: any;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ success: false, error: 'Invalid JSON request body' }, { status: 400 });
  }

  if (!body || typeof body !== 'object' || !Array.isArray(body.messages) || body.messages.length === 0) {
    return NextResponse.json(
      { success: false, error: "Missing required parameter: 'messages' must be a non-empty array" },
      { status: 400 }
    );
  }

  try {
    const caller = await resolveCallerIdentity(req);
    const userId = caller.ok ? caller.userId : 'default';

    const { session_id, session_title, harnessOverride, ...forwardBody } = body;

    let res: Response;
    if (harnessOverride && typeof harnessOverride === 'object' && harnessOverride.kind) {
      const kind = String(harnessOverride.kind) as HarnessKind;
      const defaultEmbeddedEndpoint =
        kind === 'opencode'
          ? 'opencode-eluvix://embedded'
          : kind === 'trueforge'
          ? 'trueforge://embedded'
          : kind === 'aider'
          ? 'aider://embedded'
          : kind === 'swe-agent'
          ? 'swe-agent://embedded'
          : kind === 'cline'
          ? 'cline://embedded'
          : kind === 'plandex'
          ? 'plandex://embedded'
          : 'trueforge://embedded';

      const endpoint =
        typeof harnessOverride.endpoint === 'string' && harnessOverride.endpoint.trim().length > 0
          ? harnessOverride.endpoint.trim()
          : defaultEmbeddedEndpoint;

      const overrideUpstream: UpstreamConfig = {
        id: harnessOverride.nodeId || `harness-${kind}`,
        name: harnessOverride.label || `${kind} Harness`,
        type: 'harness',
        endpoint,
        priority: 100,
        models: [forwardBody.model || `harness/${kind}`, '*'],
        harness: {
          kind,
          agentId: harnessOverride.agentId || 'build',
          embedded: harnessOverride.embedded ?? endpoint.includes('://embedded'),
          forked: harnessOverride.forked ?? true,
          deepIntegration: harnessOverride.deepIntegration ?? true,
          approvalPolicy: harnessOverride.approvalPolicy || harnessOverride.approvals || 'auto-approve-readonly',
          autoApproveTools: Array.isArray(harnessOverride.autoApproveTools)
            ? harnessOverride.autoApproveTools
            : undefined,
          mcpServers: Array.isArray(harnessOverride.mcpServers) ? harnessOverride.mcpServers : undefined,
          midLoopGuard: harnessOverride.midLoopGuard || {
            enabled: true,
            redactPii: true,
            stripInjection: true,
            blockOnInjection: false,
          },
          architectModel: harnessOverride.architectModel,
          editorModel: harnessOverride.editorModel,
          repoMapTokens: harnessOverride.repoMapTokens,
          editFormat: harnessOverride.editFormat,
          aciProfile: harnessOverride.aciProfile,
        },
      };

      res = await forwardHarnessRequest(
        overrideUpstream,
        forwardBody,
        60000,
        undefined,
        {
          userId,
          sessionId: typeof session_id === 'string' ? session_id : undefined,
          origin: 'playground',
        },
        0
      );
    } else {
      // Route in-process via Eluvix core router
      const router = getRouter();
      res = await router.routeChatCompletion(forwardBody, {
        scope: {
          userId,
          sessionId: typeof session_id === 'string' ? session_id : undefined,
          origin: 'playground',
        },
      });
    }

    let data: any;
    try {
      data = await res.json();
    } catch {
      const text = await res.text().catch(() => '');
      data = { error: { message: text || 'Request failed' } };
    }

    // Extract our custom trace & deep-harness headers
    const upstream =
      res.headers.get('x-eluvix-upstream') ||
      (harnessOverride?.kind ? `harness-${harnessOverride.kind}` : 'unknown');
    const complexity = res.headers.get('x-eluvix-complexity') || '0';
    const tokens =
      res.headers.get('x-eluvix-tokens') || res.headers.get('x-eluvix-prompt-tokens') || '0';
    const memory = res.headers.get('x-eluvix-memory') || undefined;
    const memoryTokens = res.headers.get('x-eluvix-memory-tokens') || undefined;
    const harness = res.headers.get('x-eluvix-harness') || harnessOverride?.kind || undefined;
    const harnessMode = res.headers.get('x-eluvix-harness-mode') || undefined;
    const harnessFork = res.headers.get('x-eluvix-harness-fork') || undefined;
    const harnessSession = res.headers.get('x-eluvix-session') || undefined;
    const prefixHash =
      res.headers.get('x-eluvix-prefix-hash') ||
      res.headers.get('x-eluvix-kv-prefix-hash') ||
      undefined;
    const switchyardTier = res.headers.get('x-eluvix-switchyard-tier') || undefined;
    const guardRedactions = Number(res.headers.get('x-eluvix-guard-redactions') || '0');
    const guardInjections = Number(res.headers.get('x-eluvix-guard-injections') || '0');

    const trace = {
      upstream,
      complexity,
      tokens,
      memory,
      memoryTokens,
      harness,
      harnessMode,
      harnessFork,
      harnessSession,
      prefixHash,
      switchyardTier,
      guardRedactions,
      guardInjections,
      status: res.status,
    };

    if (!res.ok) {
      return NextResponse.json(
        {
          success: false,
          error: data?.error?.message || 'Request failed',
          data,
          trace,
        },
        { status: res.status }
      );
    }

    if (session_id && forwardBody.messages) {
      const userMsg = forwardBody.messages[forwardBody.messages.length - 1];
      if (userMsg) {
        saveChatMessage(session_id, userMsg.role, userMsg.content, userId);
      }

      const assistantMsg = data.choices?.[0]?.message;
      if (assistantMsg) {
        const msgMeta =
          assistantMsg.tool_calls || harness
            ? {
                tool_calls: assistantMsg.tool_calls,
                trace,
              }
            : undefined;
        saveChatMessage(session_id, assistantMsg.role, assistantMsg.content, userId, msgMeta);
      }

      const firstUserText =
        typeof userMsg?.content === 'string' ? userMsg.content.trim().slice(0, 72) : undefined;
      upsertHarnessSession({
        sessionId: session_id,
        userId,
        title: session_title || firstUserText || undefined,
        harnessKind: harness || harnessOverride?.kind || 'opencode',
        agentId: harnessOverride?.agentId || 'build',
        nodeId: harnessOverride?.nodeId || null,
        endpoint: harnessOverride?.endpoint || null,
        kvPrefixHash: prefixHash || null,
        lastTier: switchyardTier || null,
        redactionDelta: guardRedactions,
        injectionDelta: guardInjections,
      });
    }

    return NextResponse.json({
      success: true,
      data,
      trace,
    });
  } catch (err: any) {
    return NextResponse.json({ success: false, error: err.message }, { status: 500 });
  }
}
