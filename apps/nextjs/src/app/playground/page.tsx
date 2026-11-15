"use client";

import { useState, useEffect, useRef, useCallback } from 'react';
import Link from 'next/link';
import { v4 as uuidv4 } from 'uuid';

interface ChatMessageItem {
  role: string;
  content: any;
  images?: string[];
  metrics?: {
    upstream?: string;
    model?: string;
    ttftMs?: number;
    tokPerSec?: number;
    totalMs?: number;
    cache?: string;
  };
}

interface ArenaTurn {
  id: string;
  prompt: string;
  images: string[];
  modelA: string;
  modelB: string;
  responseA: string;
  responseB: string;
  streamingA: boolean;
  streamingB: boolean;
  traceA: any;
  traceB: any;
  winner?: 'A' | 'B';
}

interface GeneratedMediaCard {
  id: string;
  prompt: string;
  createdAt: string;
  size: string;
  quality: string;
  upstream?: string;
  items: Array<{
    url?: string;
    b64_json?: string;
    revised_prompt?: string;
    mime_type?: string;
  }>;
}

function isSafeMediaUrl(url: string): boolean {
  const trimmed = url.trim();
  return (
    trimmed.startsWith('/api/v1/images/view') ||
    trimmed.startsWith('data:image/') ||
    trimmed.startsWith('https://') ||
    trimmed.startsWith('http://')
  );
}

function extractTextAndImagesFromMessage(msg: ChatMessageItem): {
  text: string;
  images: string[];
} {
  if (typeof msg.content === 'string') {
    return { text: msg.content, images: msg.images || [] };
  }
  if (Array.isArray(msg.content)) {
    const texts: string[] = [];
    const imgs: string[] = [...(msg.images || [])];
    for (const part of msg.content) {
      if (typeof part === 'string') texts.push(part);
      else if (part?.type === 'text' && typeof part.text === 'string') texts.push(part.text);
      else if (part?.type === 'image_url' && typeof part.image_url?.url === 'string') {
        if (!imgs.includes(part.image_url.url)) imgs.push(part.image_url.url);
      }
    }
    return { text: texts.join('\n'), images: imgs };
  }
  return { text: String(msg.content ?? ''), images: msg.images || [] };
}

function CopyCodeButton({ code }: { code: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      onClick={() => {
        navigator.clipboard?.writeText(code).then(() => {
          setCopied(true);
          setTimeout(() => setCopied(false), 1600);
        });
      }}
      className="text-[10px] font-mono px-2 py-0.5 rounded bg-slate-800 hover:bg-slate-700 border border-slate-700 text-slate-300 transition"
    >
      {copied ? '✓ Copied' : 'Copy'}
    </button>
  );
}

/**
 * Safe structured React renderer for assistant/user content:
 * - Collapsible <think>...</think> reasoning blocks (including in-progress streaming <think>)
 * - Fenced ```lang ... ``` code blocks with 1-click Copy
 * - Safe inline Markdown ![alt](url) image / video previews (no dangerouslySetInnerHTML)
 */
function StructuredMessageContent({
  rawText,
  isStreaming,
}: {
  rawText: string;
  isStreaming?: boolean;
}) {
  // 1. Extract <think>...</think> (closed or still streaming at start)
  const thinkingBlocks: string[] = [];
  let mainText = rawText;
  let thinkingInProgress = false;

  const closedThinkRegex = /<think>([\s\S]*?)<\/think>/gi;
  let match: RegExpExecArray | null;
  while ((match = closedThinkRegex.exec(rawText)) !== null) {
    if (match[1].trim()) thinkingBlocks.push(match[1].trim());
  }
  mainText = rawText.replace(closedThinkRegex, '').trimStart();

  const openIdx = mainText.toLowerCase().indexOf('<think>');
  if (openIdx !== -1) {
    const before = mainText.slice(0, openIdx);
    const openThink = mainText.slice(openIdx + 7).trim();
    if (openThink) thinkingBlocks.push(openThink);
    mainText = before;
    thinkingInProgress = true;
  }

  // 2. Split mainText into fenced code blocks vs prose segments
  const codeBlockRegex = /```([a-zA-Z0-9_+-]*)\n?([\s\S]*?)```/g;
  const segments: Array<
    | { kind: 'code'; lang: string; code: string }
    | { kind: 'prose'; text: string }
  > = [];

  let lastIndex = 0;
  let codeMatch: RegExpExecArray | null;
  while ((codeMatch = codeBlockRegex.exec(mainText)) !== null) {
    if (codeMatch.index > lastIndex) {
      segments.push({ kind: 'prose', text: mainText.slice(lastIndex, codeMatch.index) });
    }
    segments.push({
      kind: 'code',
      lang: codeMatch[1] || 'text',
      code: codeMatch[2].replace(/\n$/, ''),
    });
    lastIndex = codeMatch.index + codeMatch[0].length;
  }
  if (lastIndex < mainText.length) {
    segments.push({ kind: 'prose', text: mainText.slice(lastIndex) });
  }

  // Render prose with safe inline ![alt](url) detection
  const renderProseWithMedia = (text: string, keyPrefix: string) => {
    const imgRegex = /!\[([^\]]*)\]\(([^)]+)\)/g;
    const nodes: React.ReactNode[] = [];
    let cursor = 0;
    let imgMatch: RegExpExecArray | null;
    let idx = 0;

    while ((imgMatch = imgRegex.exec(text)) !== null) {
      if (imgMatch.index > cursor) {
        nodes.push(
          <span key={`${keyPrefix}-txt-${idx}`} className="whitespace-pre-wrap break-words">
            {text.slice(cursor, imgMatch.index)}
          </span>
        );
      }
      const alt = imgMatch[1] || 'Generated Media';
      const url = imgMatch[2].trim();
      if (isSafeMediaUrl(url)) {
        const isVideo = /\.(mp4|webm)(\?|$)/i.test(url) || /filename=.*\.(mp4|webm)/i.test(url);
        nodes.push(
          <div key={`${keyPrefix}-media-${idx}`} className="my-2.5 space-y-1.5">
            {isVideo ? (
              <video
                src={url}
                controls
                loop
                playsInline
                className="max-w-full max-h-96 rounded-xl border border-slate-700 shadow-lg"
              />
            ) : (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={url}
                alt={alt}
                className="max-w-full max-h-96 rounded-xl border border-slate-700 shadow-lg object-contain bg-slate-950"
              />
            )}
            <div className="flex items-center gap-2 text-[10px] font-mono text-slate-400">
              <span className="truncate max-w-xs">{alt}</span>
              <a
                href={url}
                download
                target="_blank"
                rel="noreferrer"
                className="px-2 py-0.5 rounded bg-slate-900 hover:bg-slate-700 border border-slate-700 text-sky-300"
              >
                ⬇ Download
              </a>
            </div>
          </div>
        );
      } else {
        nodes.push(
          <span key={`${keyPrefix}-raw-${idx}`} className="whitespace-pre-wrap break-words">
            {imgMatch[0]}
          </span>
        );
      }
      cursor = imgMatch.index + imgMatch[0].length;
      idx++;
    }

    if (cursor < text.length) {
      nodes.push(
        <span key={`${keyPrefix}-tail`} className="whitespace-pre-wrap break-words">
          {text.slice(cursor)}
        </span>
      );
    }

    return nodes;
  };

  return (
    <div className="space-y-2.5">
      {thinkingBlocks.map((thought, idx) => (
        <details
          key={`think-${idx}`}
          open={thinkingInProgress}
          className="rounded-lg bg-slate-950/75 border border-indigo-500/35 text-xs overflow-hidden"
        >
          <summary className="px-3 py-1.5 cursor-pointer select-none font-mono text-[11px] text-indigo-300 flex items-center gap-2 bg-indigo-950/30">
            <span>🧠</span>
            <span>
              {thinkingInProgress
                ? 'Extended Thinking (Streaming...)'
                : `Extended Thinking (${Math.max(1, Math.ceil(thought.length / 4))} tok)`}
            </span>
          </summary>
          <div className="px-3 py-2 text-[11px] text-slate-300 font-mono whitespace-pre-wrap border-t border-slate-800/80 max-h-64 overflow-y-auto">
            {thought}
          </div>
        </details>
      ))}

      {segments.map((seg, idx) =>
        seg.kind === 'code' ? (
          <div
            key={`seg-${idx}`}
            className="rounded-xl overflow-hidden border border-slate-700 bg-slate-950 my-2"
          >
            <div className="flex items-center justify-between px-3 py-1.5 bg-slate-900 border-b border-slate-800 text-[10px] font-mono text-slate-400">
              <span>{seg.lang}</span>
              <CopyCodeButton code={seg.code} />
            </div>
            <pre className="p-3 text-xs font-mono text-emerald-200 overflow-x-auto">
              <code>{seg.code}</code>
            </pre>
          </div>
        ) : (
          <div key={`seg-${idx}`}>{renderProseWithMedia(seg.text, `seg-${idx}`)}</div>
        )
      )}

      {isStreaming && !mainText && !thinkingBlocks.length && (
        <span className="inline-block w-2 h-4 bg-sky-400 animate-pulse rounded-sm align-middle" />
      )}
    </div>
  );
}

/**
 * Streams a chat completion from `/api/v1/chat` (`stream: true` SSE or JSON fallback).
 */
async function streamPlaygroundChat(params: {
  model: string;
  messages: any[];
  sessionId?: string;
  streamEnabled: boolean;
  signal: AbortSignal;
  onTrace: (trace: any) => void;
  onDelta: (accumulatedText: string) => void;
  onDone: (finalTrace: any, fullText: string) => void;
}) {
  const { model, messages, sessionId, streamEnabled, signal, onTrace, onDelta, onDone } = params;
  const startedAt = performance.now();

  const res = await fetch('/api/v1/chat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    signal,
    body: JSON.stringify({
      model: model || 'auto',
      messages,
      session_id: sessionId,
      stream: streamEnabled,
    }),
  });

  const ct = (res.headers.get('content-type') || '').toLowerCase();
  if (!res.ok || !ct.includes('text/event-stream') || !res.body) {
    const json = await res.json().catch(() => ({ success: false, error: `HTTP ${res.status}` }));
    if (!res.ok || json.success === false) {
      if (json.trace) onTrace(json.trace);
      throw new Error(json.error || `Request failed (${res.status})`);
    }
    const content = extractTextAndImagesFromMessage(
      json.data?.choices?.[0]?.message || { role: 'assistant', content: '' }
    ).text;
    const totalMs = Math.round(performance.now() - startedAt);
    const finalTrace = { ...(json.trace || {}), totalMs };
    onTrace(finalTrace);
    onDelta(content);
    onDone(finalTrace, content);
    return;
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let currentEvent = 'message';
  let accContent = '';
  let accReasoning = '';
  let latestTrace: any = null;
  let firstTokenMs: number | undefined;
  let tokenChunks = 0;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';

      for (const rawLine of lines) {
        const line = rawLine.replace(/\r$/, '');
        if (!line) {
          currentEvent = 'message';
          continue;
        }
        if (line.startsWith('event:')) {
          currentEvent = line.slice(6).trim();
          continue;
        }
        if (!line.startsWith('data:')) continue;
        const payload = line.slice(5).trim();
        if (!payload || payload === '[DONE]') continue;

        try {
          const parsed = JSON.parse(payload);
          if (currentEvent === 'eluvix_trace') {
            latestTrace = parsed;
            onTrace(parsed);
          } else if (currentEvent === 'eluvix_done') {
            latestTrace = { ...(latestTrace || {}), ...parsed };
            onTrace(latestTrace);
          } else {
            const delta = parsed?.choices?.[0]?.delta;
            if (delta) {
              const cPiece = typeof delta.content === 'string' ? delta.content : '';
              const rPiece =
                typeof delta.reasoning_content === 'string'
                  ? delta.reasoning_content
                  : typeof delta.reasoning === 'string'
                  ? delta.reasoning
                  : '';
              if (cPiece || rPiece) {
                if (firstTokenMs === undefined) {
                  firstTokenMs = Math.round(performance.now() - startedAt);
                }
                tokenChunks++;
                accContent += cPiece;
                accReasoning += rPiece;
                const combined = accReasoning
                  ? `<think>${accReasoning}${accContent ? '</think>\n\n' + accContent : ''}`
                  : accContent;
                onDelta(combined);
              }
            }
          }
        } catch {
          // Ignore malformed chunk
        }
      }
    }
  } finally {
    reader.releaseLock();
  }

  const finalFullText = accReasoning
    ? `<think>\n${accReasoning}\n</think>\n\n${accContent}`
    : accContent;
  const totalMs = latestTrace?.totalMs ?? Math.round(performance.now() - startedAt);
  const ttftMs = latestTrace?.ttftMs ?? firstTokenMs ?? totalMs;
  const approxTok = Math.max(tokenChunks, Math.ceil(finalFullText.length / 4));
  const tokPerSec =
    latestTrace?.tokPerSec ??
    (totalMs > 0 ? Number(((approxTok / Math.max(1, totalMs)) * 1000).toFixed(1)) : 0);

  const completedTrace = {
    ...(latestTrace || {}),
    ttftMs,
    totalMs,
    tokPerSec,
    status: latestTrace?.status ?? 200,
  };
  onDone(completedTrace, finalFullText);
}

export default function PlaygroundPage() {
  const [playgroundMode, setPlaygroundMode] = useState<'chat' | 'media'>('chat');
  const [splitArena, setSplitArena] = useState<boolean>(false);
  const [streamEnabled, setStreamEnabled] = useState<boolean>(true);

  const [messages, setMessages] = useState<ChatMessageItem[]>([]);
  const [arenaTurns, setArenaTurns] = useState<ArenaTurn[]>([]);
  const [input, setInput] = useState('');
  const [attachedImages, setAttachedImages] = useState<string[]>([]);
  const [isDraggingOver, setIsDraggingOver] = useState(false);

  const [loading, setLoading] = useState(false);
  const [trace, setTrace] = useState<any>(null);

  const [sessions, setSessions] = useState<any[]>([]);
  const [currentSessionId, setCurrentSessionId] = useState<string>('');
  const [selectedModel, setSelectedModel] = useState<string>('auto');
  const [arenaModelB, setArenaModelB] = useState<string>('gemini-4-carbon');
  const [availableModels, setAvailableModels] = useState<string[]>([
    'auto',
    'gemini-4-carbon',
    'gemini-4-argon',
    'gemini-3.8-flash',
  ]);

  // Image / Media DAG mode state
  const [mediaPrompt, setMediaPrompt] = useState('');
  const [negativePrompt, setNegativePrompt] = useState('');
  const [mediaSize, setMediaSize] = useState('1024x1024');
  const [mediaQuality, setMediaQuality] = useState<'standard' | 'hd'>('standard');
  const [mediaBatchCount, setMediaBatchCount] = useState<number>(1);
  const [mediaSteps, setMediaSteps] = useState<number>(20);
  const [mediaGallery, setMediaGallery] = useState<GeneratedMediaCard[]>([]);
  const [mediaError, setMediaError] = useState<string | null>(null);

  const abortRef = useRef<AbortController | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const scrollEndRef = useRef<HTMLDivElement>(null);

  const fetchSessions = async () => {
    try {
      const res = await fetch('/api/v1/chat/history');
      const json = await res.json();
      if (json.success) {
        setSessions(json.data);
      }
    } catch (err) {
      console.error(err);
    }
  };

  // Mount setup: new session id + session list + model list. The two
  // synchronous state updates run in a timer callback rather than
  // synchronously in the effect body (react-hooks/set-state-in-effect);
  // the model fetch below already updates state only in .then callbacks.
  useEffect(() => {
    const timer = setTimeout(() => {
      setCurrentSessionId(uuidv4());
      fetchSessions();
    }, 0);
    fetch('/api/v1/models')
      .then((res) => res.json())
      .then((data) => {
        if (data && Array.isArray(data.data)) {
          const defaults = ['auto', 'gemini-4-carbon', 'gemini-4-argon', 'gemini-3.8-flash'];
          const merged = Array.from(new Set([...defaults, ...data.data.map((m: any) => m.id)]));
          setAvailableModels(merged);
        }
      })
      .catch(() => {});
    return () => clearTimeout(timer);
  }, []);

  useEffect(() => {
    scrollEndRef.current?.scrollIntoView?.({ behavior: 'smooth' });
  }, [messages, arenaTurns, loading]);

  const loadSession = async (sessionId: string) => {
    try {
      const res = await fetch(`/api/v1/chat/history?session_id=${sessionId}`);
      const json = await res.json();
      if (json.success) {
        setPlaygroundMode('chat');
        setSplitArena(false);
        setMessages(json.data);
        setCurrentSessionId(sessionId);
        setTrace(null);
      }
    } catch (err) {
      console.error(err);
    }
  };

  const startNewSession = () => {
    abortRef.current?.abort();
    setCurrentSessionId(uuidv4());
    setMessages([]);
    setArenaTurns([]);
    setAttachedImages([]);
    setTrace(null);
  };

  const ingestImageFiles = useCallback((files: FileList | File[]) => {
    const list = Array.from(files).filter((f) => f.type.startsWith('image/'));
    list.slice(0, 4).forEach((file) => {
      const reader = new FileReader();
      reader.onload = () => {
        if (typeof reader.result === 'string') {
          setAttachedImages((prev) =>
            prev.length < 4 ? [...prev, reader.result as string] : prev
          );
        }
      };
      reader.readAsDataURL(file);
    });
  }, []);

  const handlePaste = useCallback(
    (e: React.ClipboardEvent) => {
      const items = e.clipboardData?.items;
      if (!items) return;
      const files: File[] = [];
      for (let i = 0; i < items.length; i++) {
        if (items[i].type.startsWith('image/')) {
          const f = items[i].getAsFile();
          if (f) files.push(f);
        }
      }
      if (files.length > 0) {
        e.preventDefault();
        ingestImageFiles(files);
      }
    },
    [ingestImageFiles]
  );

  const stopGeneration = () => {
    abortRef.current?.abort();
    setLoading(false);
  };

  const buildApiMessages = (history: ChatMessageItem[]) => {
    return history.map((m) => {
      const { text, images } = extractTextAndImagesFromMessage(m);
      if (images.length > 0) {
        return {
          role: m.role,
          content: [
            { type: 'text', text: text || 'Analyze the attached image.' },
            ...images.map((url) => ({ type: 'image_url', image_url: { url } })),
          ],
        };
      }
      return { role: m.role, content: text };
    });
  };

  const sendMessage = async () => {
    if ((!input.trim() && attachedImages.length === 0) || loading) return;

    const promptText = input.trim();
    const currentAttachments = [...attachedImages];
    setInput('');
    setAttachedImages([]);

    const controller = new AbortController();
    abortRef.current = controller;
    setLoading(true);

    // Split Arena Mode: Run Model A vs Model B side-by-side in parallel!
    if (splitArena) {
      const turnId = uuidv4();
      const newTurn: ArenaTurn = {
        id: turnId,
        prompt: promptText,
        images: currentAttachments,
        modelA: selectedModel || 'auto',
        modelB: arenaModelB || 'gemini-4-carbon',
        responseA: '',
        responseB: '',
        streamingA: true,
        streamingB: true,
        traceA: null,
        traceB: null,
      };
      setArenaTurns((prev) => [...prev, newTurn]);

      const payloadMessages = buildApiMessages([
        { role: 'user', content: promptText, images: currentAttachments },
      ]);

      const runSide = async (side: 'A' | 'B', targetModel: string) => {
        try {
          await streamPlaygroundChat({
            model: targetModel,
            messages: payloadMessages,
            streamEnabled,
            signal: controller.signal,
            onTrace: (t) => {
              if (side === 'A') setTrace(t);
              setArenaTurns((prev) =>
                prev.map((turn) =>
                  turn.id === turnId
                    ? side === 'A'
                      ? { ...turn, traceA: t }
                      : { ...turn, traceB: t }
                    : turn
                )
              );
            },
            onDelta: (txt) => {
              setArenaTurns((prev) =>
                prev.map((turn) =>
                  turn.id === turnId
                    ? side === 'A'
                      ? { ...turn, responseA: txt }
                      : { ...turn, responseB: txt }
                    : turn
                )
              );
            },
            onDone: (finalTrace, fullText) => {
              if (side === 'A') setTrace(finalTrace);
              setArenaTurns((prev) =>
                prev.map((turn) =>
                  turn.id === turnId
                    ? side === 'A'
                      ? { ...turn, responseA: fullText, traceA: finalTrace, streamingA: false }
                      : { ...turn, responseB: fullText, traceB: finalTrace, streamingB: false }
                    : turn
                )
              );
            },
          });
        } catch (err: any) {
          const msg = err.name === 'AbortError' ? '[Stopped]' : `Error: ${err.message}`;
          setArenaTurns((prev) =>
            prev.map((turn) =>
              turn.id === turnId
                ? side === 'A'
                  ? { ...turn, responseA: turn.responseA || msg, streamingA: false }
                  : { ...turn, responseB: turn.responseB || msg, streamingB: false }
                : turn
            )
          );
        }
      };

      await Promise.all([
        runSide('A', newTurn.modelA),
        runSide('B', newTurn.modelB),
      ]);
      setLoading(false);
      return;
    }

    // Standard Single-Stream Multimodal Chat
    const userItem: ChatMessageItem = {
      role: 'user',
      content: promptText,
      images: currentAttachments,
    };
    const nextHistory = [...messages, userItem];
    const assistantIndex = nextHistory.length;
    setMessages([...nextHistory, { role: 'assistant', content: '' }]);
    setTrace(null);

    try {
      await streamPlaygroundChat({
        model: selectedModel || 'auto',
        messages: buildApiMessages(nextHistory),
        sessionId: currentSessionId,
        streamEnabled,
        signal: controller.signal,
        onTrace: (t) => setTrace(t),
        onDelta: (accText) => {
          setMessages((prev) =>
            prev.map((m, idx) => (idx === assistantIndex ? { ...m, content: accText } : m))
          );
        },
        onDone: (finalTrace, fullText) => {
          setTrace(finalTrace);
          setMessages((prev) =>
            prev.map((m, idx) =>
              idx === assistantIndex
                ? {
                    ...m,
                    content: fullText,
                    metrics: {
                      upstream: finalTrace.upstream,
                      model: finalTrace.model,
                      ttftMs: finalTrace.ttftMs,
                      tokPerSec: finalTrace.tokPerSec,
                      totalMs: finalTrace.totalMs,
                      cache: finalTrace.cache,
                    },
                  }
                : m
            )
          );
          fetchSessions();
        },
      });
    } catch (err: any) {
      const errText =
        err.name === 'AbortError' ? '[Generation stopped by user]' : `Error: ${err.message}`;
      setMessages((prev) =>
        prev.map((m, idx) =>
          idx === assistantIndex
            ? { ...m, content: m.content ? `${m.content}\n\n${errText}` : errText }
            : m
        )
      );
    } finally {
      setLoading(false);
    }
  };

  const runMediaSynthesis = async () => {
    if (!mediaPrompt.trim() || loading) return;
    setLoading(true);
    setMediaError(null);
    const startedAt = performance.now();

    try {
      const res = await fetch('/api/v1/images/generations', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: selectedModel === 'auto' ? undefined : selectedModel,
          prompt: mediaPrompt.trim(),
          negative_prompt: negativePrompt.trim() || undefined,
          size: mediaSize,
          quality: mediaQuality,
          n: mediaBatchCount,
          steps: mediaSteps,
          response_format: 'url',
        }),
      });
      const upstreamHeader = res.headers.get('x-eluvix-upstream') || 'comfyui';
      const json = await res.json();
      const totalMs = Math.round(performance.now() - startedAt);

      if (!res.ok) {
        setMediaError(json?.error?.message || json?.error || `Generation failed (${res.status})`);
        setTrace({
          upstream: upstreamHeader,
          complexity: 'media-dag',
          tokens: String(Math.ceil(mediaPrompt.length / 4)),
          totalMs,
          status: res.status,
        });
        return;
      }

      setTrace({
        upstream: upstreamHeader,
        model: selectedModel,
        complexity: 'media-dag',
        tokens: String(Math.ceil(mediaPrompt.length / 4)),
        totalMs,
        status: res.status,
      });

      const card: GeneratedMediaCard = {
        id: uuidv4(),
        prompt: mediaPrompt.trim(),
        createdAt: new Date().toLocaleTimeString(),
        size: mediaSize,
        quality: mediaQuality,
        upstream: upstreamHeader,
        items: Array.isArray(json.data) ? json.data : [],
      };
      setMediaGallery((prev) => [card, ...prev]);
    } catch (err: any) {
      setMediaError(err.message || 'Media synthesis request failed');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="flex flex-col h-screen bg-slate-950 text-slate-100 font-sans">
      {/* Header */}
      <header className="flex flex-wrap justify-between items-center gap-3 px-4 py-3 border-b border-slate-800 shrink-0 bg-slate-900/70">
        <div className="flex items-center gap-3">
          <span className="text-2xl">🧪</span>
          <div>
            <h1 className="text-base font-bold text-sky-400 leading-tight">
              Playground 2.0 &amp; Trace Studio
            </h1>
            <div className="text-[10px] font-mono text-slate-400">
              SSE Streaming · Multimodal Vision · Split Arena · ComfyUI Media DAG
            </div>
          </div>

          {/* Mode Switcher */}
          <div className="flex items-center rounded-lg bg-slate-950 border border-slate-800 p-0.5 ml-2">
            <button
              type="button"
              onClick={() => setPlaygroundMode('chat')}
              className={`px-2.5 py-1 rounded-md text-xs font-semibold transition ${
                playgroundMode === 'chat'
                  ? 'bg-sky-600 text-white shadow'
                  : 'text-slate-400 hover:text-white'
              }`}
            >
              💬 Chat &amp; Vision
            </button>
            <button
              type="button"
              onClick={() => setPlaygroundMode('media')}
              className={`px-2.5 py-1 rounded-md text-xs font-semibold transition ${
                playgroundMode === 'media'
                  ? 'bg-fuchsia-600 text-white shadow'
                  : 'text-slate-400 hover:text-white'
              }`}
            >
              🎬 Image / Media DAG
            </button>
          </div>
        </div>

        {/* Model & Arena Controls */}
        <div className="flex flex-wrap items-center gap-2">
          <select
            value={selectedModel}
            onChange={(e) => setSelectedModel(e.target.value)}
            className="bg-slate-900 border border-slate-700 text-sky-300 text-xs rounded-lg px-2.5 py-1.5 focus:outline-none focus:border-sky-500 font-mono font-medium max-w-[200px] truncate"
            title="Primary Model (or Model A in Split Arena)"
          >
            {availableModels.map((m) => (
              <option key={m} value={m}>
                {m === 'auto' ? '⚡ auto (Router)' : m}
              </option>
            ))}
          </select>

          {playgroundMode === 'chat' && (
            <>
              {splitArena && (
                <>
                  <span className="text-[11px] font-mono text-amber-400 font-bold">vs</span>
                  <select
                    value={arenaModelB}
                    onChange={(e) => setArenaModelB(e.target.value)}
                    className="bg-slate-900 border border-amber-500/50 text-amber-300 text-xs rounded-lg px-2.5 py-1.5 focus:outline-none font-mono font-medium max-w-[200px] truncate"
                    title="Model B in Split Arena"
                  >
                    {availableModels.map((m) => (
                      <option key={m} value={m}>
                        {m === 'auto' ? '⚡ auto (Router)' : m}
                      </option>
                    ))}
                  </select>
                </>
              )}

              <button
                type="button"
                onClick={() => setSplitArena((v) => !v)}
                className={`px-2.5 py-1.5 rounded-lg text-xs font-semibold border transition ${
                  splitArena
                    ? 'bg-amber-600/25 border-amber-500 text-amber-200'
                    : 'bg-slate-900 border-slate-700 text-slate-300 hover:text-white'
                }`}
                title="Compare two models side-by-side in parallel streams"
              >
                ⚔️ Split Arena
              </button>

              <label
                className={`flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg border text-xs font-mono cursor-pointer ${
                  streamEnabled
                    ? 'bg-emerald-950/60 border-emerald-500/50 text-emerald-300'
                    : 'bg-slate-900 border-slate-700 text-slate-400'
                }`}
                title="Stream SSE delta tokens in real time"
              >
                <input
                  type="checkbox"
                  checked={streamEnabled}
                  onChange={(e) => setStreamEnabled(e.target.checked)}
                  className="accent-emerald-500 w-3 h-3"
                />
                <span>⚡ SSE</span>
              </label>
            </>
          )}
        </div>

        {/* Navigation Links */}
        <div className="flex gap-2 items-center">
          <Link
            href="/editor"
            className="text-xs bg-indigo-600 hover:bg-indigo-500 text-white font-semibold px-3 py-1.5 rounded-lg transition"
          >
            Routing Editor
          </Link>
          <Link
            href="/observability"
            className="text-xs bg-purple-600 hover:bg-purple-500 text-white font-semibold px-3 py-1.5 rounded-lg transition hidden xl:inline-flex"
          >
            📊 Observability
          </Link>
          <Link
            href="/docs"
            className="text-xs bg-slate-800 hover:bg-slate-700 text-sky-300 font-semibold px-3 py-1.5 rounded-lg transition border border-slate-700 hidden lg:inline-flex"
          >
            📖 Docs
          </Link>
          <Link
            href="/"
            className="text-xs bg-slate-800 hover:bg-slate-700 px-3 py-1.5 rounded-lg transition"
          >
            Dashboard
          </Link>
        </div>
      </header>

      <div className="flex flex-1 overflow-hidden">
        {/* Past Sessions Sidebar */}
        <div className="w-60 bg-slate-900 border-r border-slate-800 hidden md:flex flex-col p-3.5 overflow-y-auto shrink-0">
          <button
            type="button"
            onClick={startNewSession}
            className="w-full bg-emerald-600 hover:bg-emerald-500 text-white text-xs font-bold py-2 rounded-lg mb-4 transition shadow"
          >
            + New Session
          </button>
          <div className="text-[11px] font-bold text-slate-500 uppercase tracking-wider mb-2.5">
            Past Sessions
          </div>
          <div className="space-y-1.5">
            {sessions.map((s) => (
              <button
                type="button"
                key={s.session_id}
                onClick={() => loadSession(s.session_id)}
                className={`w-full text-left text-xs p-2 rounded-lg transition truncate ${
                  currentSessionId === s.session_id
                    ? 'bg-slate-800 text-sky-400 font-bold border border-sky-500/30'
                    : 'text-slate-400 hover:bg-slate-800/70'
                }`}
              >
                {s.title || `${s.session_id.substring(0, 8)}...`} ({s.message_count} msgs)
              </button>
            ))}
          </div>
        </div>

        {/* Center Main Workspace */}
        {playgroundMode === 'chat' ? (
          <div
            className={`flex-1 border-r border-slate-800 flex flex-col relative min-w-0 ${
              isDraggingOver ? 'ring-2 ring-inset ring-fuchsia-500 bg-fuchsia-950/10' : ''
            }`}
            onDragOver={(e) => {
              e.preventDefault();
              setIsDraggingOver(true);
            }}
            onDragLeave={() => setIsDraggingOver(false)}
            onDrop={(e) => {
              e.preventDefault();
              setIsDraggingOver(false);
              if (e.dataTransfer?.files?.length) {
                ingestImageFiles(e.dataTransfer.files);
              }
            }}
          >
            {/* Message Stream or Split Arena */}
            <div className="flex-1 overflow-y-auto p-4 space-y-4">
              {!splitArena ? (
                <>
                  {messages.length === 0 && (
                    <div className="max-w-xl mx-auto text-center mt-12 space-y-3">
                      <div className="text-3xl">🚀</div>
                      <div className="text-sm font-semibold text-slate-200">
                        Stream tokens, attach screenshots, or synthesize media through your live DAG
                      </div>
                      <div className="text-xs text-slate-400">
                        Paste or drag-and-drop an image to trigger multimodal VLM routing, type{' '}
                        <code className="text-fuchsia-300 font-mono">/imagine ...</code> for ComfyUI
                        synthesis, or enable <strong>⚔️ Split Arena</strong> to benchmark two models
                        head-to-head.
                      </div>
                    </div>
                  )}

                  {messages.map((m, i) => {
                    const { text, images } = extractTextAndImagesFromMessage(m);
                    const isUser = m.role === 'user';
                    const isLastAssistant = !isUser && i === messages.length - 1 && loading;

                    return (
                      <div
                        key={i}
                        className={`flex ${isUser ? 'justify-end' : 'justify-start'}`}
                      >
                        <div
                          className={`max-w-[85%] rounded-2xl p-3.5 text-sm shadow ${
                            isUser
                              ? 'bg-sky-600 text-white'
                              : 'bg-slate-900 border border-slate-800 text-slate-100'
                          }`}
                        >
                          {images.length > 0 && (
                            <div className="flex flex-wrap gap-2 mb-2">
                              {images.map((src, idx) => (
                                // eslint-disable-next-line @next/next/no-img-element
                                <img
                                  key={idx}
                                  src={src}
                                  alt={`Attachment ${idx + 1}`}
                                  className="h-28 w-auto rounded-lg border border-white/20 object-cover"
                                />
                              ))}
                            </div>
                          )}

                          {isUser ? (
                            <div className="whitespace-pre-wrap break-words">{text}</div>
                          ) : (
                            <StructuredMessageContent
                              rawText={text}
                              isStreaming={isLastAssistant}
                            />
                          )}

                          {!isUser && m.metrics && (
                            <div className="mt-2.5 pt-2 border-t border-slate-800/80 flex flex-wrap items-center gap-2 text-[10px] font-mono text-slate-400">
                              {m.metrics.upstream && (
                                <span className="px-1.5 py-0.5 rounded bg-slate-950 text-sky-300 border border-slate-800">
                                  {m.metrics.upstream}
                                </span>
                              )}
                              {m.metrics.ttftMs !== undefined && (
                                <span>TTFT {m.metrics.ttftMs}ms</span>
                              )}
                              {m.metrics.tokPerSec !== undefined && m.metrics.tokPerSec > 0 && (
                                <span className="text-emerald-400">{m.metrics.tokPerSec} tok/s</span>
                              )}
                              {m.metrics.totalMs !== undefined && (
                                <span>{(m.metrics.totalMs / 1000).toFixed(2)}s</span>
                              )}
                              {m.metrics.cache && (
                                <span className="text-amber-300">cache:{m.metrics.cache}</span>
                              )}
                            </div>
                          )}
                        </div>
                      </div>
                    );
                  })}
                </>
              ) : (
                /* A/B Split Arena View */
                <div className="space-y-6">
                  {arenaTurns.length === 0 && (
                    <div className="max-w-xl mx-auto text-center mt-12 space-y-2">
                      <div className="text-3xl">⚔️</div>
                      <div className="text-sm font-bold text-amber-300">
                        A/B Split Arena ({selectedModel} vs {arenaModelB})
                      </div>
                      <div className="text-xs text-slate-400">
                        Send any prompt (with optional vision screenshots) to race both models in
                        parallel SSE streams and compare TTFT, tok/s, reasoning quality, and
                        selected upstream.
                      </div>
                    </div>
                  )}

                  {arenaTurns.map((turn) => (
                    <div
                      key={turn.id}
                      className="rounded-2xl border border-slate-800 bg-slate-900/50 overflow-hidden"
                    >
                      <div className="px-4 py-2.5 bg-slate-900 border-b border-slate-800 flex items-center justify-between gap-2">
                        <div className="text-xs text-sky-200 font-medium truncate">
                          <span className="text-slate-400 font-mono mr-2">Prompt:</span>
                          {turn.prompt}
                        </div>
                        {turn.images.length > 0 && (
                          <span className="text-[10px] font-mono px-2 py-0.5 rounded bg-fuchsia-950 text-fuchsia-300 border border-fuchsia-500/40 shrink-0">
                            👁️ {turn.images.length} image{turn.images.length > 1 ? 's' : ''}
                          </span>
                        )}
                        {!turn.streamingA &&
                          !turn.streamingB &&
                          turn.responseA.trim() &&
                          turn.responseB.trim() && (
                            <div className="flex items-center gap-1.5 shrink-0">
                              <button
                                type="button"
                                disabled={Boolean(turn.winner)}
                                onClick={async () => {
                                  setArenaTurns((prev) =>
                                    prev.map((t) => (t.id === turn.id ? { ...t, winner: 'A' } : t))
                                  );
                                  await fetch('/api/v1/distillation/vote', {
                                    method: 'POST',
                                    headers: { 'Content-Type': 'application/json' },
                                    body: JSON.stringify({
                                      prompt: turn.prompt,
                                      winnerUpstreamId: turn.traceA?.upstream || turn.modelA,
                                      loserUpstreamId: turn.traceB?.upstream || turn.modelB,
                                      winnerModel: turn.modelA,
                                      loserModel: turn.modelB,
                                      chosenText: turn.responseA,
                                      rejectedText: turn.responseB,
                                    }),
                                  }).catch(() => {});
                                }}
                                className={`text-[10px] font-mono px-2 py-0.5 rounded border transition ${
                                  turn.winner === 'A'
                                    ? 'bg-emerald-600/30 border-emerald-400 text-emerald-200 font-bold'
                                    : 'bg-slate-800 hover:bg-sky-900/50 border-slate-700 text-sky-300'
                                }`}
                                title="Record Model A win into Thompson Bandit & DPO preference store"
                              >
                                {turn.winner === 'A' ? '🏆 Winner A' : '👍 Prefer A'}
                              </button>
                              <button
                                type="button"
                                disabled={Boolean(turn.winner)}
                                onClick={async () => {
                                  setArenaTurns((prev) =>
                                    prev.map((t) => (t.id === turn.id ? { ...t, winner: 'B' } : t))
                                  );
                                  await fetch('/api/v1/distillation/vote', {
                                    method: 'POST',
                                    headers: { 'Content-Type': 'application/json' },
                                    body: JSON.stringify({
                                      prompt: turn.prompt,
                                      winnerUpstreamId: turn.traceB?.upstream || turn.modelB,
                                      loserUpstreamId: turn.traceA?.upstream || turn.modelA,
                                      winnerModel: turn.modelB,
                                      loserModel: turn.modelA,
                                      chosenText: turn.responseB,
                                      rejectedText: turn.responseA,
                                    }),
                                  }).catch(() => {});
                                }}
                                className={`text-[10px] font-mono px-2 py-0.5 rounded border transition ${
                                  turn.winner === 'B'
                                    ? 'bg-emerald-600/30 border-emerald-400 text-emerald-200 font-bold'
                                    : 'bg-slate-800 hover:bg-amber-900/50 border-slate-700 text-amber-300'
                                }`}
                                title="Record Model B win into Thompson Bandit & DPO preference store"
                              >
                                {turn.winner === 'B' ? '🏆 Winner B' : '👍 Prefer B'}
                              </button>
                            </div>
                          )}
                      </div>

                      <div className="grid grid-cols-1 lg:grid-cols-2 divide-y lg:divide-y-0 lg:divide-x divide-slate-800">
                        {/* Side A */}
                        <div className="p-3.5 space-y-2">
                          <div className="flex flex-wrap items-center justify-between gap-1 text-[11px] font-mono pb-1.5 border-b border-slate-800/80">
                            <span className="font-bold text-sky-400">🅰 {turn.modelA}</span>
                            <div className="flex items-center gap-2 text-[10px] text-slate-400">
                              {turn.traceA?.upstream && (
                                <span className="text-sky-300">{turn.traceA.upstream}</span>
                              )}
                              {turn.traceA?.ttftMs !== undefined && (
                                <span>TTFT {turn.traceA.ttftMs}ms</span>
                              )}
                              {turn.traceA?.tokPerSec ? (
                                <span className="text-emerald-400">
                                  {turn.traceA.tokPerSec} tok/s
                                </span>
                              ) : null}
                            </div>
                          </div>
                          <div className="text-sm text-slate-100">
                            <StructuredMessageContent
                              rawText={turn.responseA}
                              isStreaming={turn.streamingA}
                            />
                          </div>
                        </div>

                        {/* Side B */}
                        <div className="p-3.5 space-y-2">
                          <div className="flex flex-wrap items-center justify-between gap-1 text-[11px] font-mono pb-1.5 border-b border-slate-800/80">
                            <span className="font-bold text-amber-400">🅱 {turn.modelB}</span>
                            <div className="flex items-center gap-2 text-[10px] text-slate-400">
                              {turn.traceB?.upstream && (
                                <span className="text-amber-300">{turn.traceB.upstream}</span>
                              )}
                              {turn.traceB?.ttftMs !== undefined && (
                                <span>TTFT {turn.traceB.ttftMs}ms</span>
                              )}
                              {turn.traceB?.tokPerSec ? (
                                <span className="text-emerald-400">
                                  {turn.traceB.tokPerSec} tok/s
                                </span>
                              ) : null}
                            </div>
                          </div>
                          <div className="text-sm text-slate-100">
                            <StructuredMessageContent
                              rawText={turn.responseB}
                              isStreaming={turn.streamingB}
                            />
                          </div>
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              )}
              <div ref={scrollEndRef} />
            </div>

            {/* Composer Bar */}
            <div className="p-3.5 border-t border-slate-800 shrink-0 bg-slate-900 space-y-2">
              {attachedImages.length > 0 && (
                <div className="flex items-center gap-2 overflow-x-auto pb-1">
                  {attachedImages.map((imgUrl, idx) => (
                    <div key={idx} className="relative group shrink-0">
                      {/* eslint-disable-next-line @next/next/no-img-element */}
                      <img
                        src={imgUrl}
                        alt={`Preview ${idx + 1}`}
                        className="h-16 w-16 rounded-lg object-cover border border-fuchsia-500/60"
                      />
                      <button
                        type="button"
                        onClick={() =>
                          setAttachedImages((prev) => prev.filter((_, i) => i !== idx))
                        }
                        className="absolute -top-1.5 -right-1.5 w-5 h-5 rounded-full bg-red-600 text-white text-[10px] flex items-center justify-center shadow"
                        title="Remove image"
                      >
                        ✕
                      </button>
                    </div>
                  ))}
                  <span className="text-[11px] font-mono text-fuchsia-300">
                    👁️ Multimodal VLM payload active ({attachedImages.length}/4)
                  </span>
                </div>
              )}

              <div className="flex items-center gap-2">
                <input
                  ref={fileInputRef}
                  type="file"
                  accept="image/*"
                  multiple
                  className="hidden"
                  onChange={(e) => {
                    if (e.target.files?.length) ingestImageFiles(e.target.files);
                    e.target.value = '';
                  }}
                />
                <button
                  type="button"
                  onClick={() => fileInputRef.current?.click()}
                  className="px-3 py-3 rounded-xl bg-slate-800 hover:bg-slate-700 border border-slate-700 text-slate-200 text-sm transition shrink-0"
                  title="Attach image for Vision VLM routing (or paste Ctrl+V / drag-and-drop)"
                >
                  📎
                </button>

                <input
                  type="text"
                  value={input}
                  onChange={(e) => setInput(e.target.value)}
                  onPaste={handlePaste}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && !e.shiftKey) {
                      e.preventDefault();
                      sendMessage();
                    }
                  }}
                  className="flex-1 bg-slate-950 border border-slate-700 focus:border-sky-500 rounded-xl p-3 text-sm outline-none"
                  placeholder="Type a message, paste an image (Ctrl+V), or '/imagine ...' for ComfyUI..."
                />

                {loading ? (
                  <button
                    type="button"
                    onClick={stopGeneration}
                    className="bg-red-600 hover:bg-red-500 text-white px-5 py-3 rounded-xl font-bold text-sm transition shrink-0"
                  >
                    ⏹ Stop
                  </button>
                ) : (
                  <button
                    type="button"
                    onClick={sendMessage}
                    className="bg-sky-600 hover:bg-sky-500 text-white px-6 py-3 rounded-xl font-bold text-sm transition shrink-0 shadow"
                  >
                    Send
                  </button>
                )}
              </div>
            </div>
          </div>
        ) : (
          /* Image / Media DAG Mode (/api/v1/images/generations) */
          <div className="flex-1 border-r border-slate-800 flex flex-col overflow-hidden min-w-0">
            <div className="p-4 bg-slate-900/80 border-b border-slate-800 space-y-3">
              <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
                <div>
                  <label className="block text-[11px] font-semibold text-fuchsia-300 mb-1">
                    Positive Prompt (Flux.1 / SDXL / Wan 2.1 / Hunyuan3D)
                  </label>
                  <input
                    type="text"
                    value={mediaPrompt}
                    onChange={(e) => setMediaPrompt(e.target.value)}
                    onKeyDown={(e) => e.key === 'Enter' && runMediaSynthesis()}
                    placeholder="An obsidian brutalist library illuminated by warm volumetric sunbeams, 8k architectural photography..."
                    className="w-full bg-slate-950 border border-slate-700 focus:border-fuchsia-500 rounded-xl px-3 py-2 text-xs text-white outline-none"
                  />
                </div>
                <div>
                  <label className="block text-[11px] font-semibold text-slate-400 mb-1">
                    Negative Prompt (Optional)
                  </label>
                  <input
                    type="text"
                    value={negativePrompt}
                    onChange={(e) => setNegativePrompt(e.target.value)}
                    placeholder="blurry, low quality, watermark, deformed, artifacts..."
                    className="w-full bg-slate-950 border border-slate-700 focus:border-slate-500 rounded-xl px-3 py-2 text-xs text-white outline-none"
                  />
                </div>
              </div>

              <div className="flex flex-wrap items-center justify-between gap-3">
                <div className="flex flex-wrap items-center gap-2 text-xs font-mono">
                  <select
                    value={mediaSize}
                    onChange={(e) => setMediaSize(e.target.value)}
                    className="bg-slate-950 border border-slate-700 rounded-lg px-2.5 py-1.5 text-slate-200"
                  >
                    <option value="1024x1024">1024×1024 (1:1 Square)</option>
                    <option value="1344x768">1344×768 (16:9 Widescreen)</option>
                    <option value="768x1344">768×1344 (9:16 Portrait)</option>
                    <option value="832x480">832×480 (Wan 2.1 Video)</option>
                  </select>

                  <select
                    value={mediaQuality}
                    onChange={(e) => setMediaQuality(e.target.value as 'standard' | 'hd')}
                    className="bg-slate-950 border border-slate-700 rounded-lg px-2.5 py-1.5 text-slate-200"
                  >
                    <option value="standard">Quality: Standard</option>
                    <option value="hd">Quality: HD (High Steps)</option>
                  </select>

                  <label className="flex items-center gap-1.5 bg-slate-950 border border-slate-700 rounded-lg px-2.5 py-1 text-slate-300">
                    <span>Steps:</span>
                    <input
                      type="number"
                      min={1}
                      max={60}
                      value={mediaSteps}
                      onChange={(e) => setMediaSteps(Math.max(1, Math.min(60, Number(e.target.value) || 20)))}
                      className="w-12 bg-transparent text-fuchsia-300 outline-none text-right"
                    />
                  </label>

                  <label className="flex items-center gap-1.5 bg-slate-950 border border-slate-700 rounded-lg px-2.5 py-1 text-slate-300">
                    <span>Batch (n):</span>
                    <select
                      value={mediaBatchCount}
                      onChange={(e) => setMediaBatchCount(Number(e.target.value) || 1)}
                      className="bg-transparent text-fuchsia-300 outline-none"
                    >
                      <option value={1}>1</option>
                      <option value={2}>2</option>
                      <option value={4}>4</option>
                    </select>
                  </label>
                </div>

                <button
                  type="button"
                  onClick={runMediaSynthesis}
                  disabled={loading || !mediaPrompt.trim()}
                  className="px-5 py-2 rounded-xl bg-fuchsia-600 hover:bg-fuchsia-500 disabled:opacity-50 text-white font-bold text-xs transition shadow-lg"
                >
                  {loading ? '🎬 Executing ComfyUI DAG...' : '🎬 Synthesize Media'}
                </button>
              </div>

              {mediaError && (
                <div className="p-2.5 rounded-lg bg-red-950/60 border border-red-500/50 text-xs text-red-200 font-mono">
                  ❌ {mediaError}
                </div>
              )}
            </div>

            <div className="flex-1 overflow-y-auto p-4 space-y-4">
              {mediaGallery.length === 0 ? (
                <div className="text-center text-slate-500 mt-16 space-y-2">
                  <div className="text-3xl">🎨</div>
                  <div className="text-sm text-slate-300 font-semibold">
                    Direct OpenAI-Compatible <code className="text-fuchsia-300">/api/v1/images/generations</code> Studio
                  </div>
                  <div className="text-xs max-w-lg mx-auto">
                    Dispatches parameterised ComfyUI node-graph workflows (Flux.1 Dev/Schnell, SDXL,
                    Wan 2.1 Video, Hunyuan3D) with automatic LLM prompt enhancement and ArtCraft
                    post-processing when wired in the Eluvix Visual Node Routing Editor.
                  </div>
                </div>
              ) : (
                mediaGallery.map((card) => (
                  <div
                    key={card.id}
                    className="rounded-2xl border border-slate-800 bg-slate-900/70 p-4 space-y-3"
                  >
                    <div className="flex flex-wrap items-center justify-between gap-2 text-xs">
                      <div className="font-semibold text-slate-100">{card.prompt}</div>
                      <div className="flex items-center gap-2 font-mono text-[10px] text-slate-400">
                        <span className="px-2 py-0.5 rounded bg-fuchsia-950/70 border border-fuchsia-500/40 text-fuchsia-300">
                          {card.upstream}
                        </span>
                        <span>{card.size}</span>
                        <span>{card.createdAt}</span>
                      </div>
                    </div>

                    <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                      {card.items.map((item, idx) => {
                        const src = item.url
                          ? item.url
                          : item.b64_json
                          ? `data:${item.mime_type || 'image/png'};base64,${item.b64_json}`
                          : '';
                        const isVideo =
                          item.mime_type?.startsWith('video/') ||
                          /\.(mp4|webm)(\?|$)/i.test(src);

                        return (
                          <div
                            key={idx}
                            className="rounded-xl border border-slate-800 bg-slate-950 p-2.5 space-y-2"
                          >
                            {src &&
                              (isVideo ? (
                                <video
                                  src={src}
                                  controls
                                  loop
                                  className="w-full max-h-96 rounded-lg object-contain"
                                />
                              ) : (
                                // eslint-disable-next-line @next/next/no-img-element
                                <img
                                  src={src}
                                  alt={card.prompt}
                                  className="w-full max-h-96 rounded-lg object-contain"
                                />
                              ))}
                            {item.revised_prompt && (
                              <div className="text-[11px] text-slate-400 font-mono line-clamp-2">
                                ✨ Enhanced: {item.revised_prompt}
                              </div>
                            )}
                            {src && (
                              <div className="flex justify-end">
                                <a
                                  href={src}
                                  download
                                  target="_blank"
                                  rel="noreferrer"
                                  className="text-[11px] font-mono px-2.5 py-1 rounded bg-slate-900 hover:bg-slate-800 border border-slate-700 text-sky-300"
                                >
                                  ⬇ Download Artifact
                                </a>
                              </div>
                            )}
                          </div>
                        );
                      })}
                    </div>
                  </div>
                ))
              )}
            </div>
          </div>
        )}

        {/* Live Execution Trace Drawer */}
        <div className="w-80 bg-slate-900 p-5 overflow-y-auto shrink-0 hidden lg:block">
          <h2 className="text-xs font-bold text-slate-400 uppercase tracking-wider mb-4">
            Live Execution Trace
          </h2>

          {!trace && !loading && (
            <div className="text-slate-600 text-xs text-center mt-10">
              Send a message or media synthesis job to inspect live router telemetry.
            </div>
          )}

          {loading && !trace && (
            <div className="p-3 rounded-xl bg-slate-950 border border-slate-800 text-xs text-sky-300 font-mono animate-pulse">
              ⚡ Evaluating guards, modality &amp; upstream health...
            </div>
          )}

          {trace && (
            <div className="space-y-4">
              {/* Live Performance Metric Cards */}
              <div className="grid grid-cols-2 gap-2">
                <div className="p-2.5 rounded-xl bg-slate-950 border border-slate-800">
                  <div className="text-[10px] text-slate-500 font-mono">TTFT</div>
                  <div className="text-sm font-bold font-mono text-sky-300">
                    {trace.ttftMs !== undefined ? `${trace.ttftMs} ms` : '—'}
                  </div>
                </div>
                <div className="p-2.5 rounded-xl bg-slate-950 border border-slate-800">
                  <div className="text-[10px] text-slate-500 font-mono">Throughput</div>
                  <div className="text-sm font-bold font-mono text-emerald-400">
                    {trace.tokPerSec ? `${trace.tokPerSec} tok/s` : '—'}
                  </div>
                </div>
                <div className="p-2.5 rounded-xl bg-slate-950 border border-slate-800">
                  <div className="text-[10px] text-slate-500 font-mono">Total Latency</div>
                  <div className="text-sm font-bold font-mono text-slate-200">
                    {trace.totalMs !== undefined ? `${trace.totalMs} ms` : 'Streaming...'}
                  </div>
                </div>
                <div className="p-2.5 rounded-xl bg-slate-950 border border-slate-800">
                  <div className="text-[10px] text-slate-500 font-mono">HTTP Status</div>
                  <div
                    className={`text-sm font-bold font-mono ${
                      trace.status === 200 ? 'text-emerald-400' : 'text-red-400'
                    }`}
                  >
                    {trace.status || 200}
                  </div>
                </div>
              </div>

              {/* Pipeline Stages */}
              <div className="space-y-4 relative pt-2">
                <div className="absolute left-3 top-4 bottom-2 w-0.5 bg-slate-800" />

                <div className="flex gap-3 relative z-10">
                  <div className="w-6 h-6 rounded-full bg-indigo-500 flex items-center justify-center text-xs font-bold shrink-0">
                    1
                  </div>
                  <div className="min-w-0">
                    <div className="text-xs font-bold text-white">Complexity &amp; Tokens</div>
                    <div className="text-[11px] text-indigo-300 font-mono mt-0.5">
                      Score: {trace.complexity} · ~{trace.tokens} prompt tok
                    </div>
                  </div>
                </div>

                <div className="flex gap-3 relative z-10">
                  <div className="w-6 h-6 rounded-full bg-emerald-500 flex items-center justify-center text-xs font-bold shrink-0">
                    2
                  </div>
                  <div className="min-w-0">
                    <div className="text-xs font-bold text-white">Security &amp; Guardrails</div>
                    <div className="text-[11px] text-emerald-300 font-mono mt-0.5">
                      Redactions: {trace.guardRedactions ?? 0} · Injections:{' '}
                      {trace.guardInjections ?? 0}
                    </div>
                    {trace.teePosture && (
                      <div className="text-[10px] text-teal-300 font-mono mt-0.5">
                        🔐 TEE: {trace.teePosture}
                      </div>
                    )}
                  </div>
                </div>

                <div className="flex gap-3 relative z-10">
                  <div className="w-6 h-6 rounded-full bg-sky-500 flex items-center justify-center text-xs font-bold shrink-0">
                    3
                  </div>
                  <div className="min-w-0">
                    <div className="text-xs font-bold text-white">Selected Upstream</div>
                    <div className="text-[11px] text-sky-300 font-mono mt-0.5 truncate">
                      {trace.upstream}
                    </div>
                    {trace.model && (
                      <div className="text-[10px] text-slate-400 font-mono truncate">
                        Model: {trace.model}
                      </div>
                    )}
                    {trace.switchyardTier && (
                      <div className="text-[10px] text-indigo-300 font-mono">
                        Tier: {trace.switchyardTier}
                      </div>
                    )}
                  </div>
                </div>

                {(trace.cache ||
                  trace.memory ||
                  trace.quantizationFormat ||
                  trace.attentionKernel) && (
                  <div className="flex gap-3 relative z-10">
                    <div className="w-6 h-6 rounded-full bg-amber-500 flex items-center justify-center text-xs font-bold shrink-0">
                      4
                    </div>
                    <div className="min-w-0 space-y-0.5 font-mono text-[10px] text-amber-200">
                      <div className="text-xs font-sans font-bold text-white">
                        Silicon &amp; Context Telemetry
                      </div>
                      {trace.cache && <div>⚡ Cache: {trace.cache}</div>}
                      {trace.memory && (
                        <div>
                          🧠 Memory: {trace.memory} ({trace.memoryTokens || 0} tok)
                        </div>
                      )}
                      {trace.quantizationFormat && <div>🧮 Quant: {trace.quantizationFormat}</div>}
                      {trace.attentionKernel && <div>🔥 Kernel: {trace.attentionKernel}</div>}
                    </div>
                  </div>
                )}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
