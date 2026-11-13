import {
  Eluvix,
  type RouterConfig,
  type ChatMessage,
  classifyPaperclipTask,
  recommendPaperclipAssignees,
  getPaperclipOutcomePriors,
  PAPERCLIP_VIRTUAL_MODELS,
  getEffectiveCostPer1kTokens,
  isLocalUpstream,
  type PaperclipCandidateAgent,
} from './index.js';
import { globalCircuitBreaker } from './circuit-breaker.js';
import type { RequestScope } from './context/types.js';
import { addMemoryItem, searchMemoryItems, getRollingSpendUsd, listBanditArms } from './db.js';
import { getVramArbiterStats } from './vram-arbiter.js';
import { applyPrivacyGuard } from './guard.js';

export const ELUVIX_MCP_PROTOCOL_VERSION = '2025-06-18';

export interface JsonRpcRequest {
  jsonrpc: '2.0';
  id?: string | number | null;
  method: string;
  params?: Record<string, any>;
}

export interface JsonRpcResponse {
  jsonrpc: '2.0';
  id: string | number | null;
  result?: any;
  error?: {
    code: number;
    message: string;
    data?: any;
  };
}

export interface EluvixMcpContext {
  router: Eluvix;
  config: RouterConfig;
  scope?: Partial<RequestScope>;
  hops?: number;
  proxyBaseUrl?: string;
  signal?: AbortSignal;
}

export interface McpToolDefinition {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, any>;
    required?: string[];
  };
}

export const ELUVIX_MCP_TOOLS: McpToolDefinition[] = [
  {
    name: 'eluvix_route_chat',
    description:
      'Route a chat or reasoning prompt through the Eluvix Switchyard L7 balancer, Speculative Cascade, Thompson Bandit, PromptGuard, and PrivacyGuard.',
    inputSchema: {
      type: 'object',
      properties: {
        prompt: { type: 'string', description: 'User message prompt to route.' },
        system: { type: 'string', description: 'Optional system instruction.' },
        model: {
          type: 'string',
          description: 'Target model or virtual alias (default: "auto").',
        },
        temperature: { type: 'number', description: 'Optional sampling temperature (0.0 - 2.0).' },
        max_tokens: { type: 'number', description: 'Optional maximum completion tokens.' },
      },
      required: ['prompt'],
    },
  },
  {
    name: 'eluvix_generate_media',
    description:
      'Synthesize sovereign images, videos, or 3D meshes via configured local ComfyUI workflows (Flux, SDXL, Wan 2.1, Hunyuan3D) with Cooperative GPU VRAM Arbitration.',
    inputSchema: {
      type: 'object',
      properties: {
        prompt: { type: 'string', description: 'Positive synthesis prompt.' },
        negative_prompt: { type: 'string', description: 'Optional negative prompt.' },
        size: { type: 'string', description: 'Dimensions WxH, e.g. "1024x1024".' },
        steps: { type: 'number', description: 'Optional sampler step count.' },
        cfg: { type: 'number', description: 'Optional CFG guidance scale.' },
        model: { type: 'string', description: 'Optional checkpoint override.' },
      },
      required: ['prompt'],
    },
  },
  {
    name: 'eluvix_transcribe_or_speak',
    description:
      'Execute sovereign Speech-to-Text (`mode: "transcribe"`, base64 audio -> text) or Text-to-Speech (`mode: "speak"`, text -> base64 audio) via local Whisper / Kokoro / Piper upstreams.',
    inputSchema: {
      type: 'object',
      properties: {
        mode: {
          type: 'string',
          enum: ['speak', 'transcribe'],
          description: 'Audio operation: "speak" (TTS) or "transcribe" (STT).',
        },
        text: { type: 'string', description: 'Text input when mode="speak".' },
        audio_base64: {
          type: 'string',
          description: 'Base64-encoded audio payload when mode="transcribe".',
        },
        filename: { type: 'string', description: 'Optional audio filename (default: "audio.wav").' },
        voice: { type: 'string', description: 'Optional voice ID for TTS (default: "af_heart").' },
        language: { type: 'string', description: 'Optional ISO-639-1 language hint for STT.' },
        model: { type: 'string', description: 'Optional audio model override.' },
      },
      required: ['mode'],
    },
  },
  {
    name: 'eluvix_explain_route',
    description:
      'Perform a deterministic $0.00 dry-run simulation of how Eluvix will classify, guard, filter, and rank upstreams for a given prompt without invoking any model.',
    inputSchema: {
      type: 'object',
      properties: {
        prompt: { type: 'string', description: 'Candidate prompt to simulate.' },
        model: { type: 'string', description: 'Requested model name (default: "auto").' },
      },
      required: ['prompt'],
    },
  },
  {
    name: 'eluvix_memory_query',
    description:
      'Recall user-scoped semantic and BM25 memories stored in the Eluvix sovereign memory fabric.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Search query string.' },
        top_k: { type: 'number', description: 'Maximum memories to return (default: 5).' },
      },
      required: ['query'],
    },
  },
  {
    name: 'eluvix_memory_store',
    description:
      'Store a durable user-scoped fact, preference, or architectural note into the Eluvix sovereign memory fabric (scrubbed through PrivacyGuard when enabled).',
    inputSchema: {
      type: 'object',
      properties: {
        content: { type: 'string', description: 'Memory text to persist.' },
        level: {
          type: 'string',
          enum: ['L0', 'L1', 'L2'],
          description: 'Memory tier level (default: "L1").',
        },
      },
      required: ['content'],
    },
  },
  {
    name: 'eluvix_cluster_telemetry',
    description:
      'Inspect live Eluvix cluster telemetry: Cooperative GPU VRAM Arbiter state, rolling 24h cloud spend USD, Thompson Bandit posteriors, and configured upstream health.',
    inputSchema: {
      type: 'object',
      properties: {
        window_hours: {
          type: 'number',
          description: 'Rolling spend window in hours (default: 24).',
        },
      },
    },
  },
  {
    name: 'switchyard_capabilities',
    description:
      'Inspect Switchyard fleet capabilities: upstreams, virtual tier models, local/cloud egress class, health, and cost per 1k tokens.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'switchyard_classify_task',
    description:
      'Classify a task or Paperclip issue into modality, complexity, sensitivity, and suggested Switchyard tier.',
    inputSchema: {
      type: 'object',
      properties: {
        title: { type: 'string' },
        description: { type: 'string' },
        priority: { type: 'string', enum: ['critical', 'high', 'medium', 'low'] },
        labels: { type: 'array', items: { type: 'string' } },
      },
      required: ['title'],
    },
  },
  {
    name: 'switchyard_explain_route',
    description:
      'Dry-run Switchyard routing with optional Paperclip priority and sensitivity signals.',
    inputSchema: {
      type: 'object',
      properties: {
        prompt: { type: 'string' },
        model: { type: 'string' },
        priority: { type: 'string', enum: ['critical', 'high', 'medium', 'low'] },
        sensitivity: { type: 'string', enum: ['public', 'internal', 'confidential'] },
      },
      required: ['prompt'],
    },
  },
  {
    name: 'switchyard_recommend_assignee',
    description:
      'Rank candidate employee agents for a task using Switchyard capability fit, cost, latency, load, and sensitivity.',
    inputSchema: {
      type: 'object',
      properties: {
        task: { type: 'object' },
        candidates: { type: 'array', items: { type: 'object' } },
        topN: { type: 'number' },
      },
      required: ['task', 'candidates'],
    },
  },
];

export const ELUVIX_MCP_RESOURCES = [
  {
    uri: 'eluvix://topology/upstreams',
    name: 'Eluvix Sanitized Upstream Topology',
    description: 'Configured local and cloud inference upstreams (API keys redacted).',
    mimeType: 'application/json',
  },
  {
    uri: 'eluvix://telemetry/vram-arbiter',
    name: 'Cooperative GPU VRAM Arbiter State',
    description: 'Active in-flight GPU workloads and cooperative Ollama/ComfyUI eviction counters.',
    mimeType: 'application/json',
  },
  {
    uri: 'eluvix://telemetry/bandit-arms',
    name: 'Contextual Thompson Bandit Posteriors',
    description: 'Online alpha/beta success posteriors and EWMA TTFT telemetry per complexity tier.',
    mimeType: 'application/json',
  },
];

function jsonRpcError(
  id: string | number | null,
  code: number,
  message: string,
  data?: any
): JsonRpcResponse {
  return {
    jsonrpc: '2.0',
    id,
    error: { code, message, ...(data !== undefined ? { data } : {}) },
  };
}

function mcpTextResult(payload: unknown, isError = false) {
  const text = typeof payload === 'string' ? payload : JSON.stringify(payload, null, 2);
  return {
    content: [{ type: 'text', text }],
    ...(isError ? { isError: true } : {}),
  };
}

async function executeMcpToolCall(
  toolName: string,
  args: Record<string, any>,
  ctx: EluvixMcpContext
) {
  const incomingHops = ctx.hops ?? 0;
  if (incomingHops >= 2) {
    return mcpTextResult(
      {
        error: `MCP recursion loop blocked (x-eluvix-hops=${incomingHops} >= 2).`,
        code: 'max_hops_exceeded',
      },
      true
    );
  }
  const nextHops = incomingHops + 1;
  const userId = ctx.scope?.userId || 'default';
  const effectiveScope: RequestScope = {
    userId,
    sessionId: ctx.scope?.sessionId,
    origin: ctx.scope?.origin || 'client',
  };

  switch (toolName) {
    case 'eluvix_route_chat': {
      const prompt = typeof args.prompt === 'string' ? args.prompt.trim() : '';
      if (!prompt) {
        return mcpTextResult({ error: 'Argument "prompt" must be a non-empty string.' }, true);
      }
      const messages: ChatMessage[] = [];
      if (typeof args.system === 'string' && args.system.trim()) {
        messages.push({ role: 'system', content: args.system.trim() });
      }
      messages.push({ role: 'user', content: prompt });

      const res = await ctx.router.routeChatCompletion(
        {
          model: typeof args.model === 'string' && args.model.trim() ? args.model.trim() : 'auto',
          messages,
          stream: false,
          ...(typeof args.temperature === 'number' ? { temperature: args.temperature } : {}),
          ...(typeof args.max_tokens === 'number' ? { max_tokens: args.max_tokens } : {}),
        },
        {
          hops: nextHops,
          scope: effectiveScope,
          signal: ctx.signal,
        }
      );

      const bodyText = await res.text();
      let parsed: any = null;
      try {
        parsed = JSON.parse(bodyText);
      } catch {}

      if (!res.ok) {
        return mcpTextResult(
          {
            status: res.status,
            error: parsed?.error || bodyText,
          },
          true
        );
      }

      const content = parsed?.choices?.[0]?.message?.content ?? bodyText;
      return mcpTextResult({
        content,
        model: res.headers.get('x-eluvix-model') || parsed?.model || 'auto',
        upstream: res.headers.get('x-eluvix-upstream') || undefined,
        cascade: res.headers.get('x-eluvix-cascade') || undefined,
        cost_usd: res.headers.get('x-eluvix-cost-usd') || '0.000000',
        usage: parsed?.usage,
      });
    }

    case 'eluvix_generate_media': {
      const prompt = typeof args.prompt === 'string' ? args.prompt.trim() : '';
      if (!prompt) {
        return mcpTextResult({ error: 'Argument "prompt" must be a non-empty string.' }, true);
      }
      const res = await ctx.router.routeImageGeneration(
        {
          prompt,
          negative_prompt: typeof args.negative_prompt === 'string' ? args.negative_prompt : undefined,
          size: typeof args.size === 'string' ? args.size : undefined,
          steps: typeof args.steps === 'number' ? args.steps : undefined,
          cfg: typeof args.cfg === 'number' ? args.cfg : undefined,
          model: typeof args.model === 'string' ? args.model : undefined,
        },
        {
          hops: nextHops,
          proxyBaseUrl: ctx.proxyBaseUrl,
          signal: ctx.signal,
        }
      );
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        return mcpTextResult({ status: res.status, error: body?.error || 'Media synthesis failed' }, true);
      }
      return mcpTextResult(body);
    }

    case 'eluvix_transcribe_or_speak': {
      const mode = args.mode;
      if (mode === 'speak') {
        const text = typeof args.text === 'string' ? args.text.trim() : '';
        if (!text) {
          return mcpTextResult({ error: 'Argument "text" is required when mode="speak".' }, true);
        }
        const res = await ctx.router.routeAudioSpeech(
          {
            input: text,
            voice: typeof args.voice === 'string' ? args.voice : 'af_heart',
            model: typeof args.model === 'string' ? args.model : 'tts-1',
            response_format: 'wav',
          },
          {
            hops: nextHops,
            scope: effectiveScope,
            signal: ctx.signal,
          }
        );
        if (!res.ok) {
          const errBody = await res.text();
          return mcpTextResult({ status: res.status, error: errBody }, true);
        }
        const buf = Buffer.from(await res.arrayBuffer());
        return mcpTextResult({
          mode: 'speak',
          content_type: res.headers.get('content-type') || 'audio/wav',
          upstream: res.headers.get('x-eluvix-upstream') || undefined,
          audio_base64: buf.toString('base64'),
          byte_length: buf.byteLength,
        });
      }

      if (mode === 'transcribe') {
        const b64 = typeof args.audio_base64 === 'string' ? args.audio_base64.trim() : '';
        if (!b64) {
          return mcpTextResult(
            { error: 'Argument "audio_base64" is required when mode="transcribe".' },
            true
          );
        }
        const audioBytes = new Uint8Array(Buffer.from(b64, 'base64'));
        const res = await ctx.router.routeAudioTranscription(
          {
            file: audioBytes,
            filename: typeof args.filename === 'string' ? args.filename : 'audio.wav',
            mimeType: 'audio/wav',
            model: typeof args.model === 'string' ? args.model : 'whisper-1',
            language: typeof args.language === 'string' ? args.language : undefined,
          },
          {
            hops: nextHops,
            scope: effectiveScope,
            signal: ctx.signal,
          }
        );
        const bodyText = await res.text();
        if (!res.ok) {
          return mcpTextResult({ status: res.status, error: bodyText }, true);
        }
        let parsed: any = null;
        try {
          parsed = JSON.parse(bodyText);
        } catch {}
        return mcpTextResult(parsed || { text: bodyText });
      }

      return mcpTextResult(
        { error: 'Argument "mode" must be either "speak" or "transcribe".' },
        true
      );
    }

    case 'eluvix_explain_route': {
      const prompt = typeof args.prompt === 'string' ? args.prompt : '';
      const model = typeof args.model === 'string' && args.model.trim() ? args.model.trim() : 'auto';
      const explanation = ctx.router.explainRoute({
        model,
        messages: [{ role: 'user', content: prompt }],
      });
      return mcpTextResult(explanation);
    }

    case 'eluvix_memory_query': {
      const query = typeof args.query === 'string' ? args.query.trim() : '';
      if (!query) {
        return mcpTextResult({ error: 'Argument "query" must be a non-empty string.' }, true);
      }
      const topK = Math.min(25, Math.max(1, Number(args.top_k) || 5));
      const items = searchMemoryItems(query, userId, topK);
      return mcpTextResult({
        user_id: userId,
        count: items.length,
        memories: items.map((i) => ({
          id: i.id,
          uri: i.uri,
          level: i.level,
          content: i.content,
          score: i.score,
          created_at: i.created_at,
        })),
      });
    }

    case 'eluvix_memory_store': {
      const rawContent = typeof args.content === 'string' ? args.content.trim() : '';
      if (!rawContent) {
        return mcpTextResult({ error: 'Argument "content" must be a non-empty string.' }, true);
      }
      let safeContent = rawContent;
      if (ctx.config.privacyGuard?.enabled) {
        const scrubbed = applyPrivacyGuard(
          [{ role: 'user', content: rawContent }],
          { ...ctx.config.privacyGuard, action: 'anonymize' }
        );
        const msgContent = scrubbed.modifiedMessages[0]?.content;
        if (typeof msgContent === 'string') {
          safeContent = msgContent;
        }
      }
      const level = args.level === 'L0' || args.level === 'L1' || args.level === 'L2' ? args.level : 'L1';
      const stored = addMemoryItem({
        userId,
        level,
        content: safeContent,
        metadata: { source: 'mcp_tool' },
      });
      return mcpTextResult({
        stored: Boolean(stored),
        item: stored
          ? { id: stored.id, uri: stored.uri, level: stored.level, created_at: stored.created_at }
          : null,
      });
    }

    case 'eluvix_cluster_telemetry': {
      const windowHours = Math.min(720, Math.max(1, Number(args.window_hours) || 24));
      const spendUsd = getRollingSpendUsd(windowHours * 3600 * 1000);
      const vram = getVramArbiterStats();
      const banditArms = listBanditArms();
      return mcpTextResult({
        egress_policy: ctx.config.egressPolicy || 'allow-egress',
        strategy: ctx.config.switchyard?.strategy || ctx.config.strategy || 'cost-complexity',
        rolling_spend_usd: Number(spendUsd.toFixed(6)),
        window_hours: windowHours,
        vram_arbiter: vram,
        bandit_arms_count: banditArms.length,
        upstreams: (ctx.config.upstreams || []).map((u) => ({
          id: u.id,
          name: u.name,
          type: u.type,
          priority: u.priority,
          models: u.models,
        })),
      });
    }

    case 'switchyard_capabilities': {
      const upstreams = (ctx.config.upstreams || []).map((u) => ({
        id: u.id,
        name: u.name,
        type: u.type,
        isLocal: isLocalUpstream(u),
        healthy: globalCircuitBreaker.getState(u.id) !== 'open',
        models: u.models || [],
        costPer1kTokens: getEffectiveCostPer1kTokens(u),
      }));
      return mcpTextResult({
        egressPolicy: ctx.config.egressPolicy || 'allow-egress',
        strategy: ctx.config.switchyard?.strategy || ctx.config.strategy || 'cost-complexity',
        virtualModels: PAPERCLIP_VIRTUAL_MODELS,
        upstreams,
      });
    }

    case 'switchyard_classify_task': {
      return mcpTextResult(
        classifyPaperclipTask({
          title: String(args.title || ''),
          description: typeof args.description === 'string' ? args.description : undefined,
          priority: args.priority,
          labels: Array.isArray(args.labels) ? args.labels.map(String) : undefined,
        })
      );
    }

    case 'switchyard_explain_route': {
      const explanation = ctx.router.explainRoute(
        {
          model: String(args.model || 'eluvix/auto'),
          messages: [{ role: 'user', content: String(args.prompt || '') }],
        },
        {
          scope: ctx.scope,
          paperclip: {
            trusted: true,
            priority: args.priority,
            sensitivity: args.sensitivity,
            droppedHeaders: [],
          },
        }
      );
      return mcpTextResult(explanation);
    }

    case 'switchyard_recommend_assignee': {
      const task = {
        title: String(args.task?.title || ''),
        description:
          typeof args.task?.description === 'string' ? args.task.description : undefined,
        priority: args.task?.priority,
        labels: Array.isArray(args.task?.labels) ? args.task.labels.map(String) : undefined,
        sensitivity: args.task?.sensitivity,
      };
      const classification = classifyPaperclipTask(task);
      const priors = getPaperclipOutcomePriors(classification.taskClass, ctx.scope?.userId);
      const fleet = (ctx.config.upstreams || []).map((u) => ({
        id: u.id,
        name: u.name,
        type: u.type,
        isLocal: isLocalUpstream(u),
        healthy: globalCircuitBreaker.getState(u.id) !== 'open',
        models: u.models || [],
        costPer1kTokens: getEffectiveCostPer1kTokens(u),
      }));
      const res = recommendPaperclipAssignees(
        task,
        (args.candidates || []) as PaperclipCandidateAgent[],
        fleet,
        undefined,
        priors
      );
      const topN = typeof args.topN === 'number' && args.topN > 0 ? args.topN : undefined;
      return mcpTextResult({
        ...res,
        recommendations: topN ? res.recommendations.slice(0, topN) : res.recommendations,
      });
    }

    default:
      return null;
  }
}

export async function handleEluvixMcpMessage(
  message: JsonRpcRequest,
  ctx: EluvixMcpContext
): Promise<JsonRpcResponse | null> {
  if (!message || typeof message !== 'object' || message.jsonrpc !== '2.0' || typeof message.method !== 'string') {
    return jsonRpcError(message?.id ?? null, -32600, 'Invalid JSON-RPC 2.0 Request');
  }

  const isNotification = message.id === undefined;
  const reqId = message.id ?? null;

  if (isNotification) {
    // MCP notifications (e.g., notifications/initialized, notifications/cancelled) produce no response
    return null;
  }

  try {
    switch (message.method) {
      case 'initialize': {
        return {
          jsonrpc: '2.0',
          id: reqId,
          result: {
            protocolVersion: ELUVIX_MCP_PROTOCOL_VERSION,
            capabilities: {
              tools: { listChanged: false },
              resources: { subscribe: false, listChanged: false },
            },
            serverInfo: {
              name: 'eluvix-sovereign-ai-os',
              version: '1.0.21',
            },
          },
        };
      }

      case 'ping': {
        return { jsonrpc: '2.0', id: reqId, result: {} };
      }

      case 'tools/list': {
        return {
          jsonrpc: '2.0',
          id: reqId,
          result: {
            tools: ELUVIX_MCP_TOOLS,
          },
        };
      }

      case 'tools/call': {
        const toolName = message.params?.name;
        const toolArgs =
          message.params?.arguments && typeof message.params.arguments === 'object'
            ? message.params.arguments
            : {};
        if (typeof toolName !== 'string' || !toolName) {
          return jsonRpcError(reqId, -32602, 'Missing required string parameter "name" for tools/call');
        }
        const toolResult = await executeMcpToolCall(toolName, toolArgs, ctx);
        if (!toolResult) {
          return jsonRpcError(reqId, -32601, `Unknown Eluvix MCP tool: "${toolName}"`);
        }
        return {
          jsonrpc: '2.0',
          id: reqId,
          result: toolResult,
        };
      }

      case 'resources/list': {
        return {
          jsonrpc: '2.0',
          id: reqId,
          result: {
            resources: ELUVIX_MCP_RESOURCES,
          },
        };
      }

      case 'resources/read': {
        const uri = message.params?.uri;
        if (typeof uri !== 'string' || !uri) {
          return jsonRpcError(reqId, -32602, 'Missing required string parameter "uri" for resources/read');
        }

        if (uri === 'eluvix://topology/upstreams') {
          // Never expose apiKey secrets over MCP resources
          const sanitized = (ctx.config.upstreams || []).map(({ apiKey: _redacted, ...rest }) => ({
            ...rest,
            hasApiKey: Boolean(_redacted),
          }));
          return {
            jsonrpc: '2.0',
            id: reqId,
            result: {
              contents: [
                {
                  uri,
                  mimeType: 'application/json',
                  text: JSON.stringify({ upstreams: sanitized }, null, 2),
                },
              ],
            },
          };
        }

        if (uri === 'eluvix://telemetry/vram-arbiter') {
          return {
            jsonrpc: '2.0',
            id: reqId,
            result: {
              contents: [
                {
                  uri,
                  mimeType: 'application/json',
                  text: JSON.stringify(getVramArbiterStats(), null, 2),
                },
              ],
            },
          };
        }

        if (uri === 'eluvix://telemetry/bandit-arms') {
          return {
            jsonrpc: '2.0',
            id: reqId,
            result: {
              contents: [
                {
                  uri,
                  mimeType: 'application/json',
                  text: JSON.stringify({ arms: listBanditArms() }, null, 2),
                },
              ],
            },
          };
        }

        return jsonRpcError(reqId, -32002, `Resource not found: "${uri}"`);
      }

      default:
        return jsonRpcError(reqId, -32601, `Method not found: "${message.method}"`);
    }
  } catch (err: any) {
    return jsonRpcError(reqId, -32603, err?.message || 'Internal MCP execution error');
  }
}

export async function handleEluvixMcpPayload(
  payload: unknown,
  ctx: EluvixMcpContext
): Promise<JsonRpcResponse | JsonRpcResponse[] | null> {
  if (Array.isArray(payload)) {
    if (payload.length === 0) {
      return jsonRpcError(null, -32600, 'Invalid empty JSON-RPC batch');
    }
    const responses: JsonRpcResponse[] = [];
    for (const item of payload) {
      const res = await handleEluvixMcpMessage(item as JsonRpcRequest, ctx);
      if (res) responses.push(res);
    }
    return responses.length > 0 ? responses : null;
  }

  return handleEluvixMcpMessage(payload as JsonRpcRequest, ctx);
}
