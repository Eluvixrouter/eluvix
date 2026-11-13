'use strict';

/**
 * Paperclip external-adapter UI stdout parser (`exports["./ui-parser"]`).
 * Converts JSONL events emitted by `eluvix_local` into Paperclip TranscriptEntry objects.
 */
function parseStdoutLine(line, ts) {
  if (!line || typeof line !== 'string') return [];
  var trimmed = line.trim();
  if (!trimmed) return [];

  try {
    var ev = JSON.parse(trimmed);
    var at = ev.ts || ts || new Date().toISOString();
    if (ev.type === 'route') {
      return [
        {
          kind: 'system',
          ts: at,
          text:
            '↳ routed to ' +
            (ev.model || 'unknown') +
            ' @ ' +
            (ev.upstream || 'eluvix') +
            (ev.tier ? ' (' + ev.tier + ')' : '') +
            (typeof ev.costUsd === 'number' ? ' $' + ev.costUsd.toFixed(6) : '') +
            (ev.reason ? ' — ' + ev.reason : ''),
        },
      ];
    }
    if (ev.type === 'assistant' || ev.type === 'text') {
      return [{ kind: 'assistant', ts: at, text: String(ev.text || ev.content || '') }];
    }
    if (ev.type === 'thinking') {
      return [{ kind: 'thinking', ts: at, text: String(ev.text || '') }];
    }
    if (ev.type === 'tool_call') {
      return [{ kind: 'tool_call', ts: at, name: String(ev.name || 'tool'), input: ev.input || {} }];
    }
    if (ev.type === 'tool_result') {
      return [
        {
          kind: 'tool_result',
          ts: at,
          toolUseId: String(ev.toolUseId || ''),
          content: String(ev.content || ''),
          isError: Boolean(ev.isError),
        },
      ];
    }
    if (ev.type === 'result') {
      return [
        {
          kind: 'result',
          ts: at,
          text: String(ev.text || ''),
          inputTokens: Number(ev.inputTokens || 0),
          outputTokens: Number(ev.outputTokens || 0),
          cachedTokens: Number(ev.cachedInputTokens || 0),
          costUsd: typeof ev.costUsd === 'number' ? ev.costUsd : 0,
          subtype: ev.isError ? 'error' : 'success',
          isError: Boolean(ev.isError),
        },
      ];
    }
  } catch (_err) {
    // Plain text fallback
  }

  return [{ kind: 'stdout', ts: ts || new Date().toISOString(), text: trimmed }];
}

module.exports = {
  parseStdoutLine: parseStdoutLine,
};
