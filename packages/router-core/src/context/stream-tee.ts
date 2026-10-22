/**
 * Wraps an OpenAI-compatible SSE ReadableStream, passing every byte through
 * untouched to the caller while accumulating `choices[].delta.content` chunks.
 * When the stream ends (or `[DONE]` is observed), `onComplete` is called
 * asynchronously (fire-and-forget) with the assembled assistant text.
 * If the consumer cancels (client disconnect), `onComplete` is NOT called:
 * the partial text is a truncated reply and must not be stored as a
 * completed turn.
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

  const fireOnce = () => {
    if (fired || cancelled) return;
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
        fireOnce();
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
