import type {
  AdapterExecutionContext,
  AdapterExecutionResult,
} from '../paperclip-types.js';
import {
  derivePaperclipContextHeaders,
  redactSecrets,
  resolveEluvixApiKey,
  validateLoopbackEluvixUrl,
} from './headers.js';
import { mapEluvixErrorToPaperclipFamily } from './errors.js';
import {
  buildOpenCodeConfigContent,
  spawnOpenCodeServer,
  type SpawnedOpenCodeServer,
} from './opencode-process.js';
import { fetchEluvixUsageForRun } from './usage.js';

export interface ExecuteDeps {
  fetch?: typeof globalThis.fetch;
  spawnServer?: typeof spawnOpenCodeServer;
}

function buildPromptFromContext(ctx: AdapterExecutionContext): string {
  const c = ctx.context || {};
  if (typeof c.prompt === 'string' && c.prompt.trim()) return c.prompt;
  if (typeof c.message === 'string' && c.message.trim()) return c.message;
  const parts: string[] = [];
  if (c.taskId) parts.push(`Issue ID: ${String(c.taskId)}`);
  if (c.wakeReason) parts.push(`Wake Reason: ${String(c.wakeReason)}`);
  if (c.commentBody) parts.push(`Comment:\n${String(c.commentBody)}`);
  if (parts.length === 0) {
    parts.push(`Execute Paperclip heartbeat run ${ctx.runId} for agent ${ctx.agent.name}.`);
  }
  return parts.join('\n\n');
}

export async function executeEluvixLocal(
  ctx: AdapterExecutionContext,
  deps?: ExecuteDeps
): Promise<AdapterExecutionResult> {
  const fetchFn = deps?.fetch || globalThis.fetch;
  const spawnFn = deps?.spawnServer || spawnOpenCodeServer;

  const rawBaseUrl = String(ctx.config.eluvixBaseUrl || 'http://127.0.0.1:3588');
  const urlCheck = validateLoopbackEluvixUrl(rawBaseUrl);
  if (!urlCheck.ok) {
    return {
      exitCode: 1,
      signal: null,
      timedOut: false,
      errorMessage: urlCheck.reason,
      errorFamily: 'invalid_request',
    };
  }
  const eluvixBaseUrl = urlCheck.url;

  const envMap = (ctx.config.env as Record<string, string | undefined>) || {};
  const eluvixApiKey = resolveEluvixApiKey(ctx.config, envMap);
  if (!eluvixApiKey) {
    return {
      exitCode: 1,
      signal: null,
      timedOut: false,
      errorMessage: 'Missing Eluvix API key (configure eluvixApiKey or ELUVIX_API_KEY env binding).',
      errorFamily: 'auth_required',
    };
  }

  // Pre-flight health check
  try {
    const healthRes = await fetchFn(`${eluvixBaseUrl}/api/health`, {
      signal: ctx.signal,
    });
    if (!healthRes.ok) {
      const mapped = mapEluvixErrorToPaperclipFamily(healthRes.status, undefined, 'Eluvix health check failed');
      return {
        exitCode: 1,
        signal: null,
        timedOut: false,
        errorMessage: `Eluvix health check failed (${healthRes.status})`,
        errorFamily: mapped.errorFamily,
        retryNotBefore: mapped.retryNotBefore,
      };
    }
  } catch (err: any) {
    return {
      exitCode: 1,
      signal: null,
      timedOut: false,
      errorMessage: `Eluvix unreachable at ${eluvixBaseUrl}: ${err?.message || 'network error'}`,
      errorFamily: 'transient_upstream',
      retryNotBefore: new Date(Date.now() + 15_000).toISOString(),
    };
  }

  const taskId = typeof ctx.context?.taskId === 'string' ? ctx.context.taskId : undefined;
  const paperclipApiUrl =
    envMap.PAPERCLIP_API_URL || process.env.PAPERCLIP_API_URL || 'http://127.0.0.1:3100';

  const pcHeaders = await derivePaperclipContextHeaders({
    runId: ctx.runId,
    agentId: ctx.agent.id,
    companyId: ctx.agent.companyId,
    taskId,
    paperclipApiUrl,
    paperclipAuthToken: ctx.authToken,
    fetchImpl: fetchFn,
  });

  const model = String(ctx.config.model || 'eluvix/auto');
  const egressPolicy = String(ctx.config.egressPolicy || 'inherit');
  const opencodeConfigContent = buildOpenCodeConfigContent({
    eluvixBaseUrl,
    eluvixApiKey,
    model,
    paperclipHeaders: pcHeaders,
    egressPolicy,
    runtimeMcp: ctx.runtimeMcp,
  });

  const cwd = String(ctx.config.cwd || process.cwd());
  const binary = String(ctx.config.opencodeBinary || 'opencode');
  const timeoutSec = Math.max(30, Number(ctx.config.timeoutSec || 1800));

  const childEnv: Record<string, string | undefined> = {
    PATH: process.env.PATH,
    HOME: process.env.HOME,
    TMPDIR: process.env.TMPDIR,
    ...envMap,
    OPENCODE_DISABLE_PROJECT_CONFIG: '1',
    OPENCODE_CONFIG_CONTENT: opencodeConfigContent,
    PAPERCLIP_AGENT_ID: ctx.agent.id,
    PAPERCLIP_COMPANY_ID: ctx.agent.companyId,
    PAPERCLIP_RUN_ID: ctx.runId,
    PAPERCLIP_API_URL: paperclipApiUrl,
    ...(ctx.authToken ? { PAPERCLIP_API_KEY: ctx.authToken } : {}),
    ...(taskId ? { PAPERCLIP_TASK_ID: taskId } : {}),
  };

  let server: SpawnedOpenCodeServer | null = null;
  let timedOut = false;
  const timeoutController = new AbortController();
  const timeoutHandle = setTimeout(() => {
    timedOut = true;
    timeoutController.abort();
  }, timeoutSec * 1000);

  if (ctx.signal) {
    ctx.signal.addEventListener('abort', () => timeoutController.abort());
  }

  let sessionId =
    typeof ctx.runtime?.sessionParams?.sessionId === 'string'
      ? ctx.runtime.sessionParams.sessionId
      : undefined;
  let assistantText = '';
  let exitCode = 0;
  let errorMessage: string | null = null;

  try {
    server = await spawnFn({
      binary,
      cwd,
      env: childEnv,
      signal: timeoutController.signal,
      onLog: async (stream, chunk) => {
        await ctx.onLog(stream, redactSecrets(chunk));
      },
    });

    if (!sessionId) {
      const sessRes = await fetchFn(`${server.baseUrl}/session`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: `paperclip-${ctx.runId}` }),
        signal: timeoutController.signal,
      });
      if (!sessRes.ok) {
        throw new Error(`Failed to create OpenCode session (${sessRes.status})`);
      }
      const sessJson: any = await sessRes.json();
      sessionId = String(sessJson.id || sessJson.sessionId || ctx.runId);
    }

    const promptText = buildPromptFromContext(ctx);
    const msgRes = await fetchFn(
      `${server.baseUrl}/session/${encodeURIComponent(sessionId)}/message`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          parts: [{ type: 'text', text: promptText }],
        }),
        signal: timeoutController.signal,
      }
    );

    if (!msgRes.ok) {
      const errText = await msgRes.text().catch(() => '');
      const mapped = mapEluvixErrorToPaperclipFamily(msgRes.status, undefined, errText);
      exitCode = 1;
      errorMessage = redactSecrets(errText || `OpenCode message failed (${msgRes.status})`);
      return {
        exitCode,
        signal: null,
        timedOut,
        errorMessage,
        errorFamily: mapped.errorFamily,
        retryNotBefore: mapped.retryNotBefore,
        sessionParams: sessionId ? { sessionId } : null,
        sessionDisplayId: sessionId || null,
      };
    }

    const msgJson: any = await msgRes.json().catch(() => ({}));
    const parts: any[] = Array.isArray(msgJson?.parts) ? msgJson.parts : [];
    for (const part of parts) {
      if (part?.type === 'text' && typeof part.text === 'string') {
        assistantText += part.text;
        await ctx.onLog(
          'stdout',
          JSON.stringify({ type: 'assistant', text: redactSecrets(part.text) }) + '\n'
        );
      } else if (part?.type === 'tool-invocation' || part?.type === 'tool') {
        await ctx.onLog(
          'stdout',
          JSON.stringify({
            type: 'tool_call',
            name: part.toolName || part.name || 'tool',
            input: part.input || part.args || {},
          }) + '\n'
        );
      }
    }
    if (!assistantText && typeof msgJson?.text === 'string') {
      assistantText = msgJson.text;
      await ctx.onLog(
        'stdout',
        JSON.stringify({ type: 'assistant', text: redactSecrets(assistantText) }) + '\n'
      );
    }
  } catch (err: any) {
    exitCode = 1;
    errorMessage = redactSecrets(err?.message || 'Execution failed');
  } finally {
    clearTimeout(timeoutHandle);
    if (server) {
      await server.stop().catch(() => {});
    }
  }

  // Fetch authoritative per-run usage & cost from Eluvix
  const usageSummary = await fetchEluvixUsageForRun({
    baseUrl: eluvixBaseUrl,
    apiKey: eluvixApiKey,
    runId: ctx.runId,
    fetchImpl: fetchFn,
  });

  if (usageSummary) {
    for (const m of usageSummary.byModel) {
      await ctx.onLog(
        'stdout',
        JSON.stringify({
          type: 'route',
          model: m.model,
          upstream: m.upstreamId,
          costUsd: m.costUsd,
          reason: `priority=${pcHeaders['x-paperclip-issue-priority'] || 'default'}`,
        }) + '\n'
      );
    }
    if (ctx.onUsage) {
      await ctx.onUsage({
        inputTokens: usageSummary.inputTokens,
        outputTokens: usageSummary.outputTokens,
        cachedInputTokens: usageSummary.cachedInputTokens,
        cacheWriteTokens: usageSummary.cacheWriteTokens,
        costUsd: usageSummary.costUsd,
        model: usageSummary.dominantModel || model,
      });
    }
    await ctx.onLog(
      'stdout',
      JSON.stringify({
        type: 'result',
        text: assistantText.slice(0, 500),
        inputTokens: usageSummary.inputTokens,
        outputTokens: usageSummary.outputTokens,
        cachedInputTokens: usageSummary.cachedInputTokens,
        costUsd: usageSummary.costUsd,
        isError: exitCode !== 0,
      }) + '\n'
    );
  }

  return {
    exitCode,
    signal: timedOut ? 'SIGTERM' : null,
    timedOut,
    errorMessage,
    sessionParams: sessionId ? { sessionId } : null,
    sessionDisplayId: sessionId || null,
    usage: usageSummary
      ? {
          inputTokens: usageSummary.inputTokens,
          outputTokens: usageSummary.outputTokens,
          cachedInputTokens: usageSummary.cachedInputTokens,
          cacheWriteTokens: usageSummary.cacheWriteTokens,
        }
      : { inputTokens: 0, outputTokens: 0 },
    usageByModel: usageSummary?.byModel.map((m) => ({
      model: m.model,
      provider: m.upstreamId,
      inputTokens: m.inputTokens,
      outputTokens: m.outputTokens,
      cachedInputTokens: m.cachedInputTokens,
      cacheWriteTokens: m.cacheWriteTokens,
      costUsd: m.costUsd,
    })),
    usageBasis: 'per_run',
    provider: 'eluvix',
    biller: 'eluvix',
    model: usageSummary?.dominantModel || model,
    billingType: 'api',
    costUsd: usageSummary ? usageSummary.costUsd : 0,
    costStatus: 'reported',
    pricingProvenance: { source: 'provider_reported' },
    summary: assistantText.slice(0, 400) || undefined,
  };
}
