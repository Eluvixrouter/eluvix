/**
 * Wraps an OpenAI-compatible SSE ReadableStream, passing every byte through
 * untouched to the caller while accumulating `choices[].delta.content` chunks.
 * `onComplete` is called asynchronously (fire-and-forget) with the assembled
 * assistant text ONLY when the stream terminates cleanly with `[DONE]`
 * (security audit M-21). A stream that simply ends — or errors — without
 * `[DONE]` is a truncated reply: its partial text must not be stored as a
 * completed turn, where it would later be recalled as authoritative memory.
 * If the consumer cancels (client disconnect), `onComplete` is NOT called
 * either.
 */
export function teeSseStreamForMemory(
  source: ReadableStream<Uint8Array>,
  onComplete: (assistantText: string) => void | Promise<void>
): ReadableStream<Uint8Array> {
  const decoder = new TextDecoder();
  let lineBuffer = '';
  let accumulated = '';
  let fired = false;
  let cancelled = false;
  let sawDone = false;

  const fireOnce = () => {
    // Only a clean [DONE] finish counts as a completed turn (audit M-21):
    // stream end without [DONE], and any error path, must never fire.
    if (fired || cancelled || !sawDone) return;
    fired = true;
    const text = accumulated.trim();
    if (text.length > 0) {
      Promise.resolve()
        .then(() => onComplete(text))
        .catch(err => {
          console.warn('[Eluvix Memory] Async stream write-back failed:', err?.message || err);
        });
    }
  };

  const processLines = (chunkStr: string) => {
    lineBuffer += chunkStr;
    const lines = lineBuffer.split('\n');
    lineBuffer = lines.pop() ?? '';
    for (const rawLine of lines) {
      const line = rawLine.trim();
      if (!line.startsWith('data:')) continue;
      const payload = line.slice(5).trim();
      if (payload === '[DONE]') {
        sawDone = true;
        fireOnce();
        continue;
      }
      try {
        const parsed = JSON.parse(payload);
        const delta = parsed?.choices?.[0]?.delta;
        if (delta && typeof delta.content === 'string') {
          accumulated += delta.content;
        } else if (typeof parsed?.choices?.[0]?.message?.content === 'string') {
          accumulated += parsed.choices[0].message.content;
        }
      } catch {
        // Ignore non-JSON SSE comments or partial frames
      }
    }
  };

  const reader = source.getReader();

  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const { done, value } = await reader.read();
        if (done) {
          if (lineBuffer.trim()) {
            processLines('\n');
          }
          // Fires only if a [DONE] line was seen (possibly in the final
          // flush above); a stream that ends without [DONE] is truncated
          // and its partial text is discarded, never stored (audit M-21).
          fireOnce();
          controller.close();
          return;
        }
        if (value) {
          try {
            processLines(decoder.decode(value, { stream: true }));
          } catch {}
          controller.enqueue(value);
        }
      } catch (err) {
        // Upstream error mid-stream: never write the partial reply back
        // to memory (audit M-21) — just propagate the error.
        controller.error(err);
      }
    },
    cancel(reason) {
      // Client disconnected mid-stream: the accumulated text is a truncated
      // reply, not a completed turn. Do NOT write it back to memory —
      // otherwise the partial answer is later recalled as if complete.
      cancelled = true;
      return reader.cancel(reason).catch(() => {});
    }
  });
}

export interface StreamUsageCostOptions {
  fallbackModel: string;
  fallbackPromptTokens: number;
  computeCostUsd: (promptTokens: number, completionTokens: number) => number;
  onUsage?: (usage: {
    promptTokens: number;
    completionTokens: number;
    costUsd: number;
    hasTextContent: boolean;
  }) => void;
}

/**
 * Wraps an OpenAI-compatible SSE stream so the client receives `usage` and
 * `usage.cost` in the final SSE chunk before `[DONE]` (injecting `usage.cost`
 * into an existing upstream usage frame or synthesizing a trailing chunk when
 * the upstream omits `usage`).
 */
export function transformSseStreamWithUsageCost(
  source: ReadableStream<Uint8Array>,
  options: StreamUsageCostOptions
): ReadableStream<Uint8Array> {
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  let lineBuffer = '';
  let sawUsage = false;
  let notifiedUsage = false;
  let cancelled = false;
  let lastId: string | undefined;
  let lastModel: string | undefined;
  let lastCreated: number | undefined;
  let assistantChars = 0;
  let hasTextContent = false;
  let reportedUsage:
    | { promptTokens: number; completionTokens: number; costUsd: number; hasTextContent: boolean }
    | undefined;

  const emitOnUsageOnce = (u: {
    promptTokens: number;
    completionTokens: number;
    costUsd: number;
    hasTextContent: boolean;
  }) => {
    if (notifiedUsage || cancelled) return;
    notifiedUsage = true;
    try {
      options.onUsage?.(u);
    } catch {}
  };

  const processLine = (rawLine: string, outChunks: Uint8Array[]) => {
    const cr = rawLine.endsWith('\r');
    const lineContent = cr ? rawLine.slice(0, -1) : rawLine;
    const eol = cr ? '\r\n' : '\n';
    const trimmed = lineContent.trim();

    if (!trimmed.startsWith('data:')) {
      outChunks.push(encoder.encode(rawLine + '\n'));
      return;
    }

    const payload = trimmed.slice(5).trim();
    if (payload === '[DONE]') {
      if (!sawUsage) {
        const pt = Math.max(0, Math.round(options.fallbackPromptTokens || 0));
        const ct = Math.max(1, Math.ceil(assistantChars / 4));
        const cost = Number(options.computeCostUsd(pt, ct).toFixed(6));
        const syntheticFrame = {
          id: lastId || `chatcmpl-eluvix-${Date.now()}`,
          object: 'chat.completion.chunk',
          created: lastCreated || Math.floor(Date.now() / 1000),
          model: lastModel || options.fallbackModel,
          choices: [],
          usage: {
            prompt_tokens: pt,
            completion_tokens: ct,
            total_tokens: pt + ct,
            cost,
          },
        };
        outChunks.push(encoder.encode(`data: ${JSON.stringify(syntheticFrame)}\n\n`));
        reportedUsage = { promptTokens: pt, completionTokens: ct, costUsd: cost, hasTextContent };
      }
      if (reportedUsage) {
        emitOnUsageOnce({ ...reportedUsage, hasTextContent });
      }
      outChunks.push(encoder.encode(rawLine + '\n'));
      return;
    }

    try {
      const parsed = JSON.parse(payload);
      if (parsed && typeof parsed === 'object') {
        if (typeof parsed.id === 'string' && parsed.id) lastId = parsed.id;
        if (typeof parsed.model === 'string' && parsed.model) lastModel = parsed.model;
        if (typeof parsed.created === 'number') lastCreated = parsed.created;

        const choice = Array.isArray(parsed.choices) ? parsed.choices[0] : undefined;
        const delta = choice?.delta;
        if (delta && typeof delta === 'object') {
          if (typeof delta.content === 'string') {
            assistantChars += delta.content.length;
            if (delta.content.trim().length > 0) hasTextContent = true;
          }
          if (typeof delta.reasoning_content === 'string') assistantChars += delta.reasoning_content.length;
          if (Array.isArray(delta.tool_calls)) {
            assistantChars += JSON.stringify(delta.tool_calls).length;
          }
        } else if (typeof choice?.message?.content === 'string') {
          assistantChars += choice.message.content.length;
          if (choice.message.content.trim().length > 0) hasTextContent = true;
        }

        if (parsed.usage && typeof parsed.usage === 'object') {
          const rawPt = Number(parsed.usage.prompt_tokens);
          const rawCt = Number(parsed.usage.completion_tokens);
          const pt = Number.isFinite(rawPt) && rawPt >= 0 ? rawPt : Math.max(0, Math.round(options.fallbackPromptTokens || 0));
          const ct =
            Number.isFinite(rawCt) && rawCt >= 0
              ? rawCt
              : Math.max(1, Math.ceil(assistantChars / 4));
          parsed.usage.prompt_tokens = pt;
          parsed.usage.completion_tokens = ct;
          if (!Number.isFinite(Number(parsed.usage.total_tokens))) {
            parsed.usage.total_tokens = pt + ct;
          }
          const existingCost = Number(parsed.usage.cost);
          const cost =
            parsed.usage.cost !== undefined && parsed.usage.cost !== null && Number.isFinite(existingCost)
              ? existingCost
              : Number(options.computeCostUsd(pt, ct).toFixed(6));
          parsed.usage.cost = cost;
          sawUsage = true;
          reportedUsage = { promptTokens: pt, completionTokens: ct, costUsd: cost, hasTextContent };
          outChunks.push(encoder.encode(`data: ${JSON.stringify(parsed)}${eol}`));
          return;
        }
      }
    } catch {
      // Non-JSON SSE frame: forward verbatim
    }

    outChunks.push(encoder.encode(rawLine + '\n'));
  };

  const reader = source.getReader();

  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) {
            if (lineBuffer.length > 0) {
              const tailChunks: Uint8Array[] = [];
              processLine(lineBuffer, tailChunks);
              lineBuffer = '';
              for (const chunk of tailChunks) controller.enqueue(chunk);
            }
            if (reportedUsage) {
              emitOnUsageOnce({ ...reportedUsage, hasTextContent });
            }
            controller.close();
            return;
          }
          if (value) {
            lineBuffer += decoder.decode(value, { stream: true });
            const lines = lineBuffer.split('\n');
            lineBuffer = lines.pop() ?? '';
            if (lines.length > 0) {
              const outChunks: Uint8Array[] = [];
              for (const line of lines) {
                processLine(line, outChunks);
              }
              for (const chunk of outChunks) controller.enqueue(chunk);
              return;
            }
            // No newline yet in this chunk — keep reading until a full SSE line arrives
          }
        }
      } catch (err) {
        controller.error(err);
      }
    },
    cancel(reason) {
      cancelled = true;
      return reader.cancel(reason).catch(() => {});
    },
  });
}
