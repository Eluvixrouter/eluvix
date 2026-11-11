/**
 * Browser-safe wire-protocol translation & capability-tier model aliasing
 * for Anthropic `/v1/messages`, OpenAI `/v1/responses`, and `/v1/embeddings`.
 *
 * IMPORTANT: Keep ZERO `node:*` imports in this module so client-side compiler /
 * simulator bundles can import from `@eluvix/router-core/protocol-adapters`.
 */

export type CapabilityTierLabel = 'simple' | 'moderate' | 'heavy' | 'frontier';

export interface VendorModelAliasResult {
  originalModel: string;
  resolvedModel: string;
  aliasApplied: boolean;
  targetTier?: CapabilityTierLabel;
  complexityFloor?: 1 | 2 | 3 | 4;
  preferLocal?: boolean;
}

function makeRandomId(prefix: string): string {
  const uuid =
    typeof globalThis.crypto?.randomUUID === 'function'
      ? globalThis.crypto.randomUUID().replace(/-/g, '').slice(0, 24)
      : `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 12)}`;
  return `${prefix}_${uuid}`;
}

/**
 * Maps unconfigured foreign vendor model identifiers (hardcoded by Claude Code,
 * Anthropic SDKs, Cursor, Codex, or OpenAI Agents SDKs) onto Eluvix's sovereign
 * capability tiers when `strictModelMatch` is not enabled.
 *
 * Native `gemini-*` and `harness/*` model IDs are intentionally NOT aliased here
 * so explicit Antigravity / harness model requests preserve strict matching.
 */
export function resolveVirtualVendorModel(requestedModel?: string): VendorModelAliasResult {
  const raw = (requestedModel || '').trim();
  if (!raw || raw === 'auto' || raw === '*' || raw === 'default') {
    return {
      originalModel: raw || 'auto',
      resolvedModel: raw || 'auto',
      aliasApplied: false,
    };
  }

  const lower = raw.toLowerCase();

  // Do not alias native Antigravity or Harness namespaces
  if (lower.startsWith('gemini-') || lower.startsWith('harness/')) {
    return {
      originalModel: raw,
      resolvedModel: raw,
      aliasApplied: false,
    };
  }

  // 1. Fast / Simple Local Sovereign Tier ($0.00 preferred)
  if (
    /^claude-(?:[\w.-]*-)?haiku(?:-|$)/i.test(lower) ||
    /^gpt-4o-mini(?:-|$)/i.test(lower) ||
    /^gpt-4\.1-(?:mini|nano)(?:-|$)/i.test(lower) ||
    /^gpt-3\.5(?:-|$)/i.test(lower) ||
    /^o[134]-mini(?:-|$)/i.test(lower)
  ) {
    return {
      originalModel: raw,
      resolvedModel: 'auto',
      aliasApplied: true,
      targetTier: 'simple',
      complexityFloor: 1,
      preferLocal: true,
    };
  }

  // 2. Frontier Reasoning Tier (Score 4)
  if (
    /^claude-(?:[\w.-]*-)?opus(?:-|$)/i.test(lower) ||
    /^o1(?:-(?!mini)|$)/i.test(lower) ||
    /^o3(?:-(?!mini)|$)/i.test(lower) ||
    /^o4(?:-(?!mini)|$)/i.test(lower) ||
    /^gpt-4\.5(?:-|$)/i.test(lower) ||
    /^gpt-5(?:-|$)/i.test(lower)
  ) {
    return {
      originalModel: raw,
      resolvedModel: 'auto',
      aliasApplied: true,
      targetTier: 'frontier',
      complexityFloor: 4,
    };
  }

  // 3. Heavy Coding & Agentic Tier (Score 3)
  if (
    /^claude-(?:[\w.-]*-)?sonnet(?:-|$)/i.test(lower) ||
    /^claude-2(?:\.\d+)?(?:-|$)/i.test(lower) ||
    /^gpt-4o(?:-|$)/i.test(lower) ||
    /^chatgpt-4o(?:-|$)/i.test(lower) ||
    /^gpt-4\.1(?:-|$)/i.test(lower) ||
    /^gpt-4-(?:turbo|\d{4})(?:-|$)/i.test(lower) ||
    /^gpt-4$/i.test(lower) ||
    /^codex-mini(?:-|$)/i.test(lower)
  ) {
    return {
      originalModel: raw,
      resolvedModel: 'auto',
      aliasApplied: true,
      targetTier: 'heavy',
      complexityFloor: 3,
    };
  }

  return {
    originalModel: raw,
    resolvedModel: raw,
    aliasApplied: false,
  };
}

// ============================================================================
// Anthropic `/v1/messages` <-> OpenAI `/v1/chat/completions` Translation
// ============================================================================

export interface AnthropicMessagesRequest {
  model?: string;
  messages: Array<{
    role: 'user' | 'assistant';
    content: string | Array<Record<string, any>>;
  }>;
  system?: string | Array<Record<string, any>>;
  max_tokens?: number;
  temperature?: number;
  top_p?: number;
  stop_sequences?: string[];
  stream?: boolean;
  tools?: Array<{
    name: string;
    description?: string;
    input_schema?: Record<string, any>;
  }>;
  tool_choice?:
    | { type: 'auto' | 'any' | 'none' }
    | { type: 'tool'; name: string };
  thinking?: {
    type?: 'enabled' | 'disabled';
    budget_tokens?: number;
  };
  metadata?: Record<string, any>;
}

/**
 * Converts an Anthropic `/v1/messages` payload into an Eluvix OpenAI-compatible
 * `ChatRequest` object while preserving multimodal images, thinking blocks,
 * tool schemas, and `tool_use` / `tool_result` multi-turn history.
 */
export function anthropicToOpenAiChatRequest(body: AnthropicMessagesRequest): {
  model: string;
  messages: Array<Record<string, any>>;
  max_tokens?: number;
  temperature?: number;
  top_p?: number;
  stop?: string[];
  stream?: boolean;
  tools?: Array<Record<string, any>>;
  tool_choice?: any;
  metadata?: Record<string, any>;
} {
  const messages: Array<Record<string, any>> = [];

  // 1. System prompt (string or array of text blocks)
  if (typeof body.system === 'string' && body.system.trim()) {
    messages.push({ role: 'system', content: body.system });
  } else if (Array.isArray(body.system)) {
    const sysText = body.system
      .map((b) => (b && typeof b.text === 'string' ? b.text : ''))
      .filter(Boolean)
      .join('\n\n');
    if (sysText) {
      messages.push({ role: 'system', content: sysText });
    }
  }

  // 2. Conversation turns
  for (const turn of body.messages || []) {
    if (!turn || !turn.role) continue;

    if (typeof turn.content === 'string') {
      messages.push({ role: turn.role, content: turn.content });
      continue;
    }

    if (!Array.isArray(turn.content)) continue;

    if (turn.role === 'assistant') {
      const textParts: string[] = [];
      const toolCalls: Array<Record<string, any>> = [];

      for (const block of turn.content) {
        if (!block || typeof block !== 'object') continue;
        if (block.type === 'thinking' && typeof block.thinking === 'string') {
          textParts.push(`<think>${block.thinking}</think>`);
        } else if (block.type === 'text' && typeof block.text === 'string') {
          textParts.push(block.text);
        } else if (block.type === 'tool_use' && block.name) {
          toolCalls.push({
            id: String(block.id || makeRandomId('toolu')),
            type: 'function',
            function: {
              name: String(block.name),
              arguments:
                typeof block.input === 'string'
                  ? block.input
                  : JSON.stringify(block.input ?? {}),
            },
          });
        }
      }

      const assistantMsg: Record<string, any> = {
        role: 'assistant',
        content: textParts.join('\n') || (toolCalls.length > 0 ? '' : ''),
      };
      if (toolCalls.length > 0) {
        assistantMsg.tool_calls = toolCalls;
      }
      messages.push(assistantMsg);
    } else {
      // role === 'user': may mix text, image, document, and tool_result blocks
      const contentParts: Array<Record<string, any>> = [];
      const toolResultMsgs: Array<Record<string, any>> = [];

      for (const block of turn.content) {
        if (!block || typeof block !== 'object') continue;
        if (block.type === 'text' && typeof block.text === 'string') {
          contentParts.push({ type: 'text', text: block.text });
        } else if (block.type === 'image' && block.source) {
          if (block.source.type === 'base64' && block.source.data) {
            const mediaType = block.source.media_type || 'image/png';
            contentParts.push({
              type: 'image_url',
              image_url: { url: `data:${mediaType};base64,${block.source.data}` },
            });
          } else if (block.source.type === 'url' && block.source.url) {
            contentParts.push({
              type: 'image_url',
              image_url: { url: String(block.source.url) },
            });
          }
        } else if (block.type === 'tool_result') {
          let resultText = '';
          if (typeof block.content === 'string') {
            resultText = block.content;
          } else if (Array.isArray(block.content)) {
            resultText = block.content
              .map((c: any) => (typeof c?.text === 'string' ? c.text : JSON.stringify(c)))
              .join('\n');
          } else if (block.content != null) {
            resultText = JSON.stringify(block.content);
          }
          toolResultMsgs.push({
            role: 'tool',
            tool_call_id: String(block.tool_use_id || 'toolu_unknown'),
            content: block.is_error ? `[Tool Error]: ${resultText}` : resultText,
          });
        }
      }

      // OpenAI expects `tool` role responses immediately after assistant `tool_calls`
      for (const tr of toolResultMsgs) {
        messages.push(tr);
      }

      if (contentParts.length === 1 && contentParts[0].type === 'text') {
        messages.push({ role: 'user', content: contentParts[0].text });
      } else if (contentParts.length > 0) {
        messages.push({ role: 'user', content: contentParts });
      } else if (toolResultMsgs.length === 0) {
        messages.push({ role: 'user', content: '' });
      }
    }
  }

  // 3. Tools & tool_choice
  let tools: Array<Record<string, any>> | undefined;
  if (Array.isArray(body.tools) && body.tools.length > 0) {
    tools = body.tools.map((t) => ({
      type: 'function',
      function: {
        name: t.name,
        ...(t.description ? { description: t.description } : {}),
        parameters: t.input_schema || { type: 'object', properties: {} },
      },
    }));
  }

  let toolChoice: any = undefined;
  if (body.tool_choice && typeof body.tool_choice === 'object') {
    if (body.tool_choice.type === 'auto') {
      toolChoice = 'auto';
    } else if (body.tool_choice.type === 'any') {
      toolChoice = 'required';
    } else if (body.tool_choice.type === 'none') {
      toolChoice = 'none';
    } else if (body.tool_choice.type === 'tool' && 'name' in body.tool_choice) {
      toolChoice = {
        type: 'function',
        function: { name: body.tool_choice.name },
      };
    }
  }

  // 4. Thinking / extended reasoning metadata
  const metadata: Record<string, any> = {
    ...(body.metadata && typeof body.metadata === 'object' ? body.metadata : {}),
  };
  if (body.thinking?.type === 'enabled') {
    const budget = Number(body.thinking.budget_tokens || 0);
    metadata.effort = budget >= 16000 ? 'high' : budget >= 4000 ? 'medium' : 'high';
    metadata.thinkingBudget = budget || 8192;
  }

  return {
    model: body.model || 'auto',
    messages,
    ...(typeof body.max_tokens === 'number' ? { max_tokens: body.max_tokens } : {}),
    ...(typeof body.temperature === 'number' ? { temperature: body.temperature } : {}),
    ...(typeof body.top_p === 'number' ? { top_p: body.top_p } : {}),
    ...(Array.isArray(body.stop_sequences) && body.stop_sequences.length > 0
      ? { stop: body.stop_sequences }
      : {}),
    ...(typeof body.stream === 'boolean' ? { stream: body.stream } : {}),
    ...(tools ? { tools } : {}),
    ...(toolChoice !== undefined ? { tool_choice: toolChoice } : {}),
    ...(Object.keys(metadata).length > 0 ? { metadata } : {}),
  };
}

function splitLeadingThinkBlock(rawText: string): { thinking?: string; text: string } {
  if (!rawText) return { text: '' };
  const match = rawText.match(/^\s*<think>([\s\S]*?)<\/think>\s*([\s\S]*)$/i);
  if (!match) return { text: rawText };
  return {
    thinking: match[1].trim(),
    text: match[2],
  };
}

function mapFinishReasonToAnthropicStopReason(
  finishReason: string | null | undefined,
  hasToolCalls: boolean
): 'end_turn' | 'max_tokens' | 'stop_sequence' | 'tool_use' {
  if (hasToolCalls || finishReason === 'tool_calls' || finishReason === 'function_call') {
    return 'tool_use';
  }
  if (finishReason === 'length') return 'max_tokens';
  if (finishReason === 'stop_sequence') return 'stop_sequence';
  return 'end_turn';
}

/**
 * Converts a non-streaming OpenAI `chat.completion` JSON payload into an
 * Anthropic `message` response object.
 */
export function openAiToAnthropicMessageResponse(
  openAiJson: Record<string, any>,
  requestedModel?: string
): Record<string, any> {
  const choice = openAiJson?.choices?.[0] || {};
  const msg = choice.message || {};
  const rawContent =
    typeof msg.content === 'string'
      ? msg.content
      : typeof choice.text === 'string'
      ? choice.text
      : '';

  const reasoningField =
    typeof msg.reasoning_content === 'string'
      ? msg.reasoning_content
      : typeof msg.reasoning === 'string'
      ? msg.reasoning
      : undefined;

  const { thinking: tagThinking, text: cleanedText } = splitLeadingThinkBlock(rawContent);
  const thinkingText = reasoningField || tagThinking;

  const contentBlocks: Array<Record<string, any>> = [];
  if (thinkingText) {
    contentBlocks.push({
      type: 'thinking',
      thinking: thinkingText,
    });
  }

  const toolCalls = Array.isArray(msg.tool_calls) ? msg.tool_calls : [];
  if (cleanedText || (contentBlocks.length === 0 && toolCalls.length === 0)) {
    contentBlocks.push({
      type: 'text',
      text: cleanedText,
    });
  }

  for (const tc of toolCalls) {
    let parsedInput: Record<string, any> = {};
    const rawArgs = tc?.function?.arguments;
    if (typeof rawArgs === 'string' && rawArgs.trim()) {
      try {
        parsedInput = JSON.parse(rawArgs);
      } catch {
        parsedInput = { raw: rawArgs };
      }
    } else if (rawArgs && typeof rawArgs === 'object') {
      parsedInput = rawArgs;
    }
    contentBlocks.push({
      type: 'tool_use',
      id: String(tc?.id || makeRandomId('toolu')),
      name: String(tc?.function?.name || 'tool'),
      input: parsedInput,
    });
  }

  const inputTokens = Number(openAiJson?.usage?.prompt_tokens ?? 0);
  const outputTokens = Number(openAiJson?.usage?.completion_tokens ?? 0);

  return {
    id:
      typeof openAiJson?.id === 'string' && openAiJson.id.startsWith('msg_')
        ? openAiJson.id
        : makeRandomId('msg'),
    type: 'message',
    role: 'assistant',
    model: requestedModel || openAiJson?.model || 'auto',
    content: contentBlocks,
    stop_reason: mapFinishReasonToAnthropicStopReason(
      choice.finish_reason,
      toolCalls.length > 0
    ),
    stop_sequence: null,
    usage: {
      input_tokens: inputTokens,
      output_tokens: outputTokens,
    },
  };
}

/**
 * Streaming SSE state machine that transforms an OpenAI `chat.completion.chunk`
 * `ReadableStream<Uint8Array>` into exact Anthropic `/v1/messages` SSE events:
 * `message_start` -> `content_block_start` -> `content_block_delta` ->
 * `content_block_stop` -> `message_delta` -> `message_stop`.
 */
export function transformOpenAiSseToAnthropicSse(
  openAiStream: ReadableStream<Uint8Array>,
  requestedModel?: string
): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();
  const messageId = makeRandomId('msg');

  const formatSse = (event: string, data: Record<string, any>): Uint8Array =>
    encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);

  let started = false;
  let currentBlockType: 'none' | 'thinking' | 'text' | 'tool_use' = 'none';
  let nextBlockIndex = 0;
  let activeBlockIndex = -1;
  let outputTokens = 0;
  let inputTokens = 0;
  let finishReason: string | null = null;
  let sawToolCalls = false;
  const openToolIndices = new Map<number, number>(); // OpenAI tool index -> Anthropic block index
  let buffer = '';

  const closeActiveBlock = (controller: ReadableStreamDefaultController<Uint8Array>) => {
    if (currentBlockType !== 'none' && activeBlockIndex >= 0) {
      controller.enqueue(
        formatSse('content_block_stop', {
          type: 'content_block_stop',
          index: activeBlockIndex,
        })
      );
      currentBlockType = 'none';
      activeBlockIndex = -1;
    }
  };

  const ensureMessageStarted = (
    controller: ReadableStreamDefaultController<Uint8Array>,
    chunkModel?: string
  ) => {
    if (started) return;
    started = true;
    controller.enqueue(
      formatSse('message_start', {
        type: 'message_start',
        message: {
          id: messageId,
          type: 'message',
          role: 'assistant',
          model: requestedModel || chunkModel || 'auto',
          content: [],
          stop_reason: null,
          stop_sequence: null,
          usage: { input_tokens: inputTokens, output_tokens: 0 },
        },
      })
    );
  };

  return new ReadableStream<Uint8Array>({
    async start(controller) {
      const reader = openAiStream.getReader();
      try {
        const processLine = (line: string) => {
          const trimmed = line.trim();
          if (!trimmed.startsWith('data:')) return;
          const payload = trimmed.slice(5).trim();
          if (!payload || payload === '[DONE]') return;

          let parsed: any;
          try {
            parsed = JSON.parse(payload);
          } catch {
            return;
          }

          if (parsed?.usage) {
            if (typeof parsed.usage.prompt_tokens === 'number') {
              inputTokens = parsed.usage.prompt_tokens;
            }
            if (typeof parsed.usage.completion_tokens === 'number') {
              outputTokens = parsed.usage.completion_tokens;
            }
          }

          ensureMessageStarted(controller, parsed?.model);

          const choice = parsed?.choices?.[0];
          if (!choice) return;
          const delta = choice.delta || {};

          // 1. Reasoning / thinking delta
          const reasoningDelta =
            typeof delta.reasoning_content === 'string'
              ? delta.reasoning_content
              : typeof delta.reasoning === 'string'
              ? delta.reasoning
              : '';
          if (reasoningDelta) {
            if (currentBlockType !== 'thinking') {
              closeActiveBlock(controller);
              activeBlockIndex = nextBlockIndex++;
              currentBlockType = 'thinking';
              controller.enqueue(
                formatSse('content_block_start', {
                  type: 'content_block_start',
                  index: activeBlockIndex,
                  content_block: { type: 'thinking', thinking: '' },
                })
              );
            }
            outputTokens += Math.max(1, Math.ceil(reasoningDelta.length / 4));
            controller.enqueue(
              formatSse('content_block_delta', {
                type: 'content_block_delta',
                index: activeBlockIndex,
                delta: { type: 'thinking_delta', thinking: reasoningDelta },
              })
            );
          }

          // 2. Text content delta
          if (typeof delta.content === 'string' && delta.content.length > 0) {
            if (currentBlockType !== 'text') {
              closeActiveBlock(controller);
              activeBlockIndex = nextBlockIndex++;
              currentBlockType = 'text';
              controller.enqueue(
                formatSse('content_block_start', {
                  type: 'content_block_start',
                  index: activeBlockIndex,
                  content_block: { type: 'text', text: '' },
                })
              );
            }
            outputTokens += Math.max(1, Math.ceil(delta.content.length / 4));
            controller.enqueue(
              formatSse('content_block_delta', {
                type: 'content_block_delta',
                index: activeBlockIndex,
                delta: { type: 'text_delta', text: delta.content },
              })
            );
          }

          // 3. Tool call deltas
          if (Array.isArray(delta.tool_calls)) {
            sawToolCalls = true;
            for (const tc of delta.tool_calls) {
              const tcIdx = typeof tc.index === 'number' ? tc.index : 0;
              let blockIdx = openToolIndices.get(tcIdx);
              if (blockIdx === undefined) {
                closeActiveBlock(controller);
                blockIdx = nextBlockIndex++;
                openToolIndices.set(tcIdx, blockIdx);
                activeBlockIndex = blockIdx;
                currentBlockType = 'tool_use';
                controller.enqueue(
                  formatSse('content_block_start', {
                    type: 'content_block_start',
                    index: blockIdx,
                    content_block: {
                      type: 'tool_use',
                      id: String(tc.id || makeRandomId('toolu')),
                      name: String(tc.function?.name || 'tool'),
                      input: {},
                    },
                  })
                );
              }
              const partialJson = tc.function?.arguments;
              if (typeof partialJson === 'string' && partialJson.length > 0) {
                outputTokens += Math.max(1, Math.ceil(partialJson.length / 4));
                controller.enqueue(
                  formatSse('content_block_delta', {
                    type: 'content_block_delta',
                    index: blockIdx,
                    delta: { type: 'input_json_delta', partial_json: partialJson },
                  })
                );
              }
            }
          }

          if (choice.finish_reason) {
            finishReason = choice.finish_reason;
          }
        };

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split('\n');
          buffer = lines.pop() || '';
          for (const l of lines) processLine(l);
        }
        if (buffer.trim()) processLine(buffer);

        ensureMessageStarted(controller);
        closeActiveBlock(controller);

        // If no content blocks were emitted at all, emit a clean empty text block
        if (nextBlockIndex === 0) {
          controller.enqueue(
            formatSse('content_block_start', {
              type: 'content_block_start',
              index: 0,
              content_block: { type: 'text', text: '' },
            })
          );
          controller.enqueue(
            formatSse('content_block_stop', {
              type: 'content_block_stop',
              index: 0,
            })
          );
        }

        controller.enqueue(
          formatSse('message_delta', {
            type: 'message_delta',
            delta: {
              stop_reason: mapFinishReasonToAnthropicStopReason(finishReason, sawToolCalls),
              stop_sequence: null,
            },
            usage: { output_tokens: outputTokens },
          })
        );
        controller.enqueue(formatSse('message_stop', { type: 'message_stop' }));
        controller.close();
      } catch (err) {
        try {
          controller.error(err);
        } catch {}
      } finally {
        try {
          reader.releaseLock();
        } catch {}
      }
    },
  });
}

// ============================================================================
// OpenAI `/v1/responses` <-> OpenAI `/v1/chat/completions` Translation
// ============================================================================

export interface OpenAiResponsesRequest {
  model?: string;
  input: string | Array<Record<string, any>>;
  instructions?: string;
  previous_response_id?: string | null;
  store?: boolean;
  stream?: boolean;
  temperature?: number;
  top_p?: number;
  max_output_tokens?: number;
  tools?: Array<Record<string, any>>;
  tool_choice?: any;
  reasoning?: {
    effort?: 'low' | 'medium' | 'high';
  };
  text?: {
    format?: Record<string, any>;
  };
  metadata?: Record<string, any>;
}

/**
 * Converts OpenAI `/v1/responses` `input`, `instructions`, and optional
 * `priorMessages` (resolved from `previous_response_id`) into a normalized
 * `ChatRequest` + the new user/tool turn messages to append to conversation state.
 */
export function responsesInputToChatRequest(
  body: OpenAiResponsesRequest,
  priorMessages: Array<Record<string, any>> = []
): {
  chatRequest: Record<string, any>;
  turnMessages: Array<Record<string, any>>;
} {
  const turnMessages: Array<Record<string, any>> = [];

  if (typeof body.input === 'string') {
    turnMessages.push({ role: 'user', content: body.input });
  } else if (Array.isArray(body.input)) {
    for (const item of body.input) {
      if (!item || typeof item !== 'object') continue;

      if (item.type === 'function_call_output') {
        turnMessages.push({
          role: 'tool',
          tool_call_id: String(item.call_id || item.id || 'call_unknown'),
          content: typeof item.output === 'string' ? item.output : JSON.stringify(item.output ?? ''),
        });
        continue;
      }

      if (item.type === 'function_call') {
        turnMessages.push({
          role: 'assistant',
          content: '',
          tool_calls: [
            {
              id: String(item.call_id || item.id || makeRandomId('call')),
              type: 'function',
              function: {
                name: String(item.name || 'tool'),
                arguments:
                  typeof item.arguments === 'string'
                    ? item.arguments
                    : JSON.stringify(item.arguments ?? {}),
              },
            },
          ],
        });
        continue;
      }

      const role = item.role || 'user';
      if (typeof item.content === 'string') {
        turnMessages.push({ role, content: item.content });
      } else if (Array.isArray(item.content)) {
        const parts: Array<Record<string, any>> = [];
        for (const c of item.content) {
          if (!c || typeof c !== 'object') continue;
          if ((c.type === 'input_text' || c.type === 'output_text' || c.type === 'text') && typeof c.text === 'string') {
            parts.push({ type: 'text', text: c.text });
          } else if (c.type === 'input_image' && (c.image_url || c.url)) {
            const imgUrl = typeof c.image_url === 'string' ? c.image_url : c.image_url?.url || c.url;
            if (imgUrl) {
              parts.push({ type: 'image_url', image_url: { url: String(imgUrl) } });
            }
          }
        }
        if (parts.length === 1 && parts[0].type === 'text') {
          turnMessages.push({ role, content: parts[0].text });
        } else if (parts.length > 0) {
          turnMessages.push({ role, content: parts });
        }
      } else if (item.type === 'input_text' && typeof item.text === 'string') {
        turnMessages.push({ role: 'user', content: item.text });
      }
    }
  }

  const baseMessages: Array<Record<string, any>> = [];
  const priorWithoutDupSys =
    typeof body.instructions === 'string' && body.instructions.trim()
      ? priorMessages.filter((m) => m.role !== 'system')
      : priorMessages;

  if (typeof body.instructions === 'string' && body.instructions.trim()) {
    baseMessages.push({ role: 'system', content: body.instructions });
  }
  baseMessages.push(...priorWithoutDupSys, ...turnMessages);

  // Normalize Responses-style tools (`{ type: 'function', name, parameters }`) into Chat `tools`
  let normalizedTools: Array<Record<string, any>> | undefined;
  if (Array.isArray(body.tools) && body.tools.length > 0) {
    normalizedTools = body.tools
      .filter((t) => t && (t.type === 'function' || t.function))
      .map((t) => {
        if (t.function) return t;
        return {
          type: 'function',
          function: {
            name: t.name,
            ...(t.description ? { description: t.description } : {}),
            parameters: t.parameters || { type: 'object', properties: {} },
          },
        };
      });
    if (normalizedTools.length === 0) normalizedTools = undefined;
  }

  let responseFormat: any = undefined;
  if (body.text?.format && typeof body.text.format === 'object') {
    if (body.text.format.type === 'json_object') {
      responseFormat = { type: 'json_object' };
    } else if (body.text.format.type === 'json_schema') {
      responseFormat = {
        type: 'json_schema',
        json_schema: {
          name: body.text.format.name || 'response_schema',
          schema: body.text.format.schema || {},
          ...(body.text.format.strict !== undefined ? { strict: body.text.format.strict } : {}),
        },
      };
    }
  }

  const metadata: Record<string, any> = {
    ...(body.metadata && typeof body.metadata === 'object' ? body.metadata : {}),
  };
  if (body.reasoning?.effort) {
    metadata.effort = body.reasoning.effort;
  }

  return {
    turnMessages,
    chatRequest: {
      model: body.model || 'auto',
      messages: baseMessages,
      ...(typeof body.stream === 'boolean' ? { stream: body.stream } : {}),
      ...(typeof body.temperature === 'number' ? { temperature: body.temperature } : {}),
      ...(typeof body.top_p === 'number' ? { top_p: body.top_p } : {}),
      ...(typeof body.max_output_tokens === 'number'
        ? { max_tokens: body.max_output_tokens }
        : {}),
      ...(normalizedTools ? { tools: normalizedTools } : {}),
      ...(body.tool_choice !== undefined ? { tool_choice: body.tool_choice } : {}),
      ...(responseFormat ? { response_format: responseFormat } : {}),
      ...(Object.keys(metadata).length > 0 ? { metadata } : {}),
    },
  };
}

/**
 * Converts a non-streaming OpenAI `chat.completion` JSON payload into a
 * canonical OpenAI `/v1/responses` `response` object.
 */
export function openAiChatToResponsesObject(params: {
  responseId?: string;
  chatJson: Record<string, any>;
  requestedModel?: string;
  previousResponseId?: string | null;
  store?: boolean;
}): {
  responseObject: Record<string, any>;
  assistantMessage: Record<string, any>;
} {
  const responseId = params.responseId || makeRandomId('resp');
  const createdAt = Math.floor(Date.now() / 1000);
  const choice = params.chatJson?.choices?.[0] || {};
  const msg = choice.message || {};
  const textContent =
    typeof msg.content === 'string'
      ? msg.content
      : typeof choice.text === 'string'
      ? choice.text
      : '';
  const toolCalls = Array.isArray(msg.tool_calls) ? msg.tool_calls : [];

  const outputItems: Array<Record<string, any>> = [];
  if (textContent || toolCalls.length === 0) {
    outputItems.push({
      id: makeRandomId('msg'),
      type: 'message',
      status: 'completed',
      role: 'assistant',
      content: [
        {
          type: 'output_text',
          text: textContent,
          annotations: [],
        },
      ],
    });
  }

  for (const tc of toolCalls) {
    const callId = String(tc?.id || makeRandomId('call'));
    outputItems.push({
      id: makeRandomId('fc'),
      type: 'function_call',
      status: 'completed',
      call_id: callId,
      name: String(tc?.function?.name || 'tool'),
      arguments:
        typeof tc?.function?.arguments === 'string'
          ? tc.function.arguments
          : JSON.stringify(tc?.function?.arguments ?? {}),
    });
  }

  const inputTokens = Number(params.chatJson?.usage?.prompt_tokens ?? 0);
  const outputTokens = Number(params.chatJson?.usage?.completion_tokens ?? 0);

  const assistantMessage: Record<string, any> = {
    role: 'assistant',
    content: textContent,
    ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
  };

  const responseObject = {
    id: responseId,
    object: 'response',
    created_at: createdAt,
    status: 'completed',
    model: params.requestedModel || params.chatJson?.model || 'auto',
    previous_response_id: params.previousResponseId ?? null,
    store: params.store !== false,
    output: outputItems,
    output_text: textContent,
    usage: {
      input_tokens: inputTokens,
      output_tokens: outputTokens,
      total_tokens: inputTokens + outputTokens,
    },
  };

  return { responseObject, assistantMessage };
}

/**
 * Transforms an OpenAI `chat.completion.chunk` stream into OpenAI `/v1/responses`
 * SSE events (`response.created`, `response.output_text.delta`, `response.completed`)
 * and invokes `onCompleted` with the assembled response object for SQLite persistence.
 */
export function transformOpenAiSseToResponsesSse(params: {
  responseId?: string;
  openAiStream: ReadableStream<Uint8Array>;
  requestedModel?: string;
  previousResponseId?: string | null;
  store?: boolean;
  onCompleted?: (result: {
    responseObject: Record<string, any>;
    assistantMessage: Record<string, any>;
  }) => void;
}): ReadableStream<Uint8Array> {
  const responseId = params.responseId || makeRandomId('resp');
  const messageItemId = makeRandomId('msg');
  const createdAt = Math.floor(Date.now() / 1000);
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();

  const formatSse = (event: string, data: Record<string, any>): Uint8Array =>
    encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);

  let fullText = '';
  let inputTokens = 0;
  let outputTokens = 0;
  let resolvedModel = params.requestedModel || 'auto';
  let buffer = '';

  return new ReadableStream<Uint8Array>({
    async start(controller) {
      const reader = params.openAiStream.getReader();
      try {
        const initialShell = {
          id: responseId,
          object: 'response',
          created_at: createdAt,
          status: 'in_progress',
          model: resolvedModel,
          previous_response_id: params.previousResponseId ?? null,
          output: [],
        };
        controller.enqueue(
          formatSse('response.created', {
            type: 'response.created',
            response: initialShell,
          })
        );
        controller.enqueue(
          formatSse('response.output_item.added', {
            type: 'response.output_item.added',
            output_index: 0,
            item: {
              id: messageItemId,
              type: 'message',
              status: 'in_progress',
              role: 'assistant',
              content: [],
            },
          })
        );

        const processLine = (line: string) => {
          const trimmed = line.trim();
          if (!trimmed.startsWith('data:')) return;
          const payload = trimmed.slice(5).trim();
          if (!payload || payload === '[DONE]') return;
          let parsed: any;
          try {
            parsed = JSON.parse(payload);
          } catch {
            return;
          }
          if (parsed?.model && !params.requestedModel) {
            resolvedModel = parsed.model;
          }
          if (parsed?.usage) {
            if (typeof parsed.usage.prompt_tokens === 'number') {
              inputTokens = parsed.usage.prompt_tokens;
            }
            if (typeof parsed.usage.completion_tokens === 'number') {
              outputTokens = parsed.usage.completion_tokens;
            }
          }
          const deltaText = parsed?.choices?.[0]?.delta?.content;
          if (typeof deltaText === 'string' && deltaText.length > 0) {
            fullText += deltaText;
            outputTokens = Math.max(outputTokens, Math.ceil(fullText.length / 4));
            controller.enqueue(
              formatSse('response.output_text.delta', {
                type: 'response.output_text.delta',
                item_id: messageItemId,
                output_index: 0,
                content_index: 0,
                delta: deltaText,
              })
            );
          }
        };

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split('\n');
          buffer = lines.pop() || '';
          for (const l of lines) processLine(l);
        }
        if (buffer.trim()) processLine(buffer);

        controller.enqueue(
          formatSse('response.output_text.done', {
            type: 'response.output_text.done',
            item_id: messageItemId,
            output_index: 0,
            content_index: 0,
            text: fullText,
          })
        );

        const finalOutputItem = {
          id: messageItemId,
          type: 'message',
          status: 'completed',
          role: 'assistant',
          content: [{ type: 'output_text', text: fullText, annotations: [] }],
        };

        controller.enqueue(
          formatSse('response.output_item.done', {
            type: 'response.output_item.done',
            output_index: 0,
            item: finalOutputItem,
          })
        );

        const finalResponse = {
          id: responseId,
          object: 'response',
          created_at: createdAt,
          status: 'completed',
          model: resolvedModel,
          previous_response_id: params.previousResponseId ?? null,
          store: params.store !== false,
          output: [finalOutputItem],
          output_text: fullText,
          usage: {
            input_tokens: inputTokens,
            output_tokens: outputTokens,
            total_tokens: inputTokens + outputTokens,
          },
        };

        if (params.onCompleted) {
          try {
            params.onCompleted({
              responseObject: finalResponse,
              assistantMessage: { role: 'assistant', content: fullText },
            });
          } catch {}
        }

        controller.enqueue(
          formatSse('response.completed', {
            type: 'response.completed',
            response: finalResponse,
          })
        );
        controller.close();
      } catch (err) {
        try {
          controller.error(err);
        } catch {}
      } finally {
        try {
          reader.releaseLock();
        } catch {}
      }
    },
  });
}

// ============================================================================
// Embeddings Vector Dimension Pinning & Matryoshka L2 Re-Normalization
// ============================================================================

/**
 * Enforces vector dimension pinning and Matryoshka prefix slicing + L2 unit
 * re-normalization so local/cloud embedding failover never corrupts Qdrant,
 * LightRAG, or pgvector collections with mismatched vector widths.
 */
export function normalizeEmbeddingVector(
  vector: number[],
  targetDimensions?: number
): {
  vector: number[];
  dimensions: number;
  sliced: boolean;
} {
  if (!Array.isArray(vector) || vector.length === 0) {
    throw new Error('Upstream returned an empty embedding vector.');
  }

  if (
    targetDimensions === undefined ||
    !Number.isFinite(targetDimensions) ||
    targetDimensions <= 0 ||
    vector.length === targetDimensions
  ) {
    return {
      vector,
      dimensions: vector.length,
      sliced: false,
    };
  }

  if (vector.length < targetDimensions) {
    const err: any = new Error(
      `Embedding dimension mismatch: upstream produced ${vector.length} dimensions, which is smaller than pinned target ${targetDimensions}.`
    );
    err.dimensionMismatch = true;
    throw err;
  }

  // Matryoshka prefix slice + L2 unit normalization
  const slicedVec = vector.slice(0, targetDimensions);
  let sumSq = 0;
  for (let i = 0; i < slicedVec.length; i++) {
    sumSq += slicedVec[i] * slicedVec[i];
  }
  const norm = Math.sqrt(sumSq);
  const normalized =
    norm > 1e-12
      ? slicedVec.map((v) => Number((v / norm).toFixed(8)))
      : slicedVec;

  return {
    vector: normalized,
    dimensions: normalized.length,
    sliced: true,
  };
}

/**
 * Encodes a float embedding vector into OpenAI's little-endian IEEE-754 Float32 base64 string.
 */
export function encodeFloat32VectorBase64(vector: number[]): string {
  const f32 = new Float32Array(vector.length);
  for (let i = 0; i < vector.length; i++) {
    f32[i] = vector[i];
  }
  const bytes = new Uint8Array(f32.buffer);
  let binary = '';
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  if (typeof globalThis.btoa === 'function') {
    return globalThis.btoa(binary);
  }
  // Fallback for runtimes without btoa
  const B = (globalThis as any).Buffer;
  return B ? B.from(bytes).toString('base64') : binary;
}
