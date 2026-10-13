'use client';

import { useState, useRef, useEffect } from 'react';
import { SAMPLE_PROMPTS, MockSamplePrompt } from './mockup-data';

interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
  meta?: {
    model: string;
    route: string;
    ttftMs: number;
    totalMs: number;
    tokens: number;
    localCost: string;
    cloudCost: string;
    sanitized: boolean;
    sanitizationDetails?: string[];
  };
}

export function MockupPlayground() {
  const [messages, setMessages] = useState<ChatMessage[]>([
    {
      role: 'assistant',
      content: 'Welcome to the Eluvix Sovereign Playground. Test queries in real-time to observe in-flight PII redaction, automatic local GPU dispatch, and latency metrics.',
    },
  ]);
  const [input, setInput] = useState('');
  const [isStreaming, setIsStreaming] = useState(false);
  const [streamedText, setStreamedText] = useState('');
  const [activeInspector, setActiveInspector] = useState<MockSamplePrompt | null>(null);
  const [showSanitizerDiff, setShowSanitizerDiff] = useState(false);
  const chatEndRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, streamedText]);

  function handleSendPrompt(sample?: MockSamplePrompt) {
    const promptData = sample || {
      id: 'custom-' + Date.now(),
      title: 'Custom Prompt',
      category: 'General',
      rawPrompt: input.trim(),
      maskedPrompt: input.trim(),
      sanitizationDetails: ['Local query routed through Eluvix default policy.'],
      chosenRoute: 'Local Ollama Engine',
      model: 'llama3.1:latest',
      routeReason: 'Dispatched to default zero-cost local hardware.',
      response: `Eluvix Gateway successfully intercepted and routed your query: "${input.trim()}".\n\nExecution was completed entirely on local silicon (127.0.0.1:11434). Zero private tokens were transmitted outside your host machine.`,
      ttftMs: 16,
      totalMs: 168,
      promptTokens: Math.max(12, Math.round(input.length / 4)),
      completionTokens: 64,
      localCost: '$0.0000',
      cloudCost: '$0.0022',
    };

    if (!promptData.rawPrompt) return;

    setActiveInspector(promptData);
    setMessages((prev) => [
      ...prev,
      { role: 'user', content: promptData.rawPrompt },
    ]);
    setInput('');
    setIsStreaming(true);
    setStreamedText('');

    // Simulate word-by-word streaming
    const words = promptData.response.split(' ');
    let currentIndex = 0;

    const interval = setInterval(() => {
      currentIndex += 2;
      if (currentIndex >= words.length) {
        clearInterval(interval);
        setStreamedText('');
        setIsStreaming(false);
        setMessages((prev) => [
          ...prev,
          {
            role: 'assistant',
            content: promptData.response,
            meta: {
              model: promptData.model,
              route: promptData.chosenRoute,
              ttftMs: promptData.ttftMs,
              totalMs: promptData.totalMs,
              tokens: promptData.promptTokens + promptData.completionTokens,
              localCost: promptData.localCost,
              cloudCost: promptData.cloudCost,
              sanitized: promptData.sanitizationDetails.length > 1,
              sanitizationDetails: promptData.sanitizationDetails,
            },
          },
        ]);
      } else {
        setStreamedText(words.slice(0, currentIndex).join(' ') + ' ▍');
      }
    }, 28);
  }

  function handleClearChat() {
    setMessages([
      {
        role: 'assistant',
        content: 'Chat session reset. Select a sample prompt or enter any query to test the routing engine.',
      },
    ]);
    setActiveInspector(null);
  }

  return (
    <div className="space-y-6">
      {/* Sample Prompt Selector Banner */}
      <div className="rounded-2xl border border-slate-800 bg-slate-900/60 p-4">
        <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between pb-3 border-b border-slate-800/80 gap-2">
          <div>
            <span className="text-xs font-mono uppercase tracking-wider text-slate-400 font-bold">
              Test Scenarios
            </span>
            <p className="text-xs text-slate-300">
              Click a scenario to watch in-flight PII redaction and intelligent local GPU dispatch:
            </p>
          </div>

          <button
            type="button"
            onClick={handleClearChat}
            className="text-xs text-slate-400 hover:text-white"
          >
            Clear Chat
          </button>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-3 gap-2.5 pt-3">
          {SAMPLE_PROMPTS.map((sample) => (
            <button
              key={sample.id}
              type="button"
              disabled={isStreaming}
              onClick={() => handleSendPrompt(sample)}
              className="p-3 rounded-xl border border-slate-800 bg-slate-950/50 hover:bg-slate-900 hover:border-sky-500/50 text-left transition flex flex-col justify-between"
            >
              <div>
                <div className="flex items-center justify-between gap-1">
                  <span className="text-xs font-bold text-white truncate">{sample.title}</span>
                  <span className={`text-[9px] font-mono px-1.5 py-0.5 rounded font-semibold ${
                    sample.category === 'Privacy Shield'
                      ? 'bg-emerald-500/20 text-emerald-400'
                      : sample.category === 'Coding'
                      ? 'bg-sky-500/20 text-sky-400'
                      : 'bg-purple-500/20 text-purple-400'
                  }`}>
                    {sample.category}
                  </span>
                </div>
                <p className="text-[11px] text-slate-400 line-clamp-2 mt-1 font-mono">
                  {sample.rawPrompt.slice(0, 80)}...
                </p>
              </div>

              <div className="text-[10px] text-emerald-400 font-mono mt-2">
                ➔ Route: {sample.chosenRoute}
              </div>
            </button>
          ))}
        </div>
      </div>

      {/* Main Interactive Chat + Privacy Inspector Layout */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* Chat Stream (Left 2 Cols) */}
        <div className="lg:col-span-2 rounded-2xl border border-slate-800 bg-slate-950/80 flex flex-col h-[520px] overflow-hidden">
          {/* Top Chat Bar */}
          <div className="px-4 py-3 border-b border-slate-800 bg-slate-900/60 flex items-center justify-between text-xs">
            <div className="flex items-center gap-2">
              <span className="w-2 h-2 rounded-full bg-emerald-400 animate-pulse" />
              <span className="font-bold text-white">Live Execution Channel</span>
            </div>
            <div className="text-slate-400 font-mono text-[11px]">
              Engine: <strong className="text-sky-400">{activeInspector?.model || 'llama3.1:latest'}</strong>
            </div>
          </div>

          {/* Messages Scroll Area */}
          <div className="flex-1 p-4 overflow-y-auto space-y-4">
            {messages.map((msg, i) => (
              <div
                key={i}
                className={`flex flex-col ${
                  msg.role === 'user' ? 'items-end' : 'items-start'
                }`}
              >
                <div
                  className={`max-w-[85%] rounded-2xl p-3.5 text-xs leading-relaxed whitespace-pre-wrap ${
                    msg.role === 'user'
                      ? 'bg-sky-500 text-slate-950 font-medium'
                      : 'bg-slate-900 border border-slate-800 text-slate-100 shadow-md font-mono'
                  }`}
                >
                  {msg.content}
                </div>

                {/* Telemetry metadata footer on assistant responses */}
                {msg.meta && (
                  <div className="flex flex-wrap items-center gap-2 mt-1.5 px-1 text-[10px] font-mono text-slate-400">
                    <span className="text-emerald-400">⚡ TTFT: {msg.meta.ttftMs}ms</span>
                    <span>•</span>
                    <span>Total: {msg.meta.totalMs}ms</span>
                    <span>•</span>
                    <span>{msg.meta.tokens} tokens</span>
                    <span>•</span>
                    <span className="text-emerald-400 font-bold">Cost: {msg.meta.localCost}</span>
                    {msg.meta.sanitized && (
                      <span className="px-1.5 py-0.2 rounded bg-emerald-500/20 text-emerald-300 font-semibold border border-emerald-500/30">
                        🛡️ PII Masked
                      </span>
                    )}
                  </div>
                )}
              </div>
            ))}

            {/* In-flight streaming message */}
            {isStreaming && (
              <div className="flex flex-col items-start">
                <div className="max-w-[85%] rounded-2xl p-3.5 text-xs leading-relaxed whitespace-pre-wrap bg-slate-900 border border-sky-500/40 text-slate-100 shadow-lg font-mono">
                  {streamedText}
                </div>
                <div className="text-[10px] font-mono text-sky-400 mt-1 animate-pulse">
                  Streaming from local GPU...
                </div>
              </div>
            )}
            <div ref={chatEndRef} />
          </div>

          {/* Prompt Input Form */}
          <div className="p-3 border-t border-slate-800 bg-slate-900/60">
            <form
              onSubmit={(e) => {
                e.preventDefault();
                handleSendPrompt();
              }}
              className="flex items-center gap-2"
            >
              <input
                type="text"
                value={input}
                onChange={(e) => setInput(e.target.value)}
                placeholder="Type a test query or include test secrets (e.g. sk-live-..., SSN)..."
                disabled={isStreaming}
                className="flex-1 rounded-xl border border-slate-800 bg-slate-950 px-3.5 py-2 text-xs text-white placeholder-slate-500 focus:outline-none focus:border-sky-500"
              />
              <button
                type="submit"
                disabled={isStreaming || !input.trim()}
                className="px-4 py-2 rounded-xl bg-sky-500 hover:bg-sky-400 disabled:opacity-50 text-slate-950 font-bold text-xs shadow-md transition"
              >
                Send ➔
              </button>
            </form>
          </div>
        </div>

        {/* Right Col: Sovereign Privacy & Routing Inspector */}
        <div className="rounded-2xl border border-slate-800 bg-slate-900/70 p-5 space-y-4 flex flex-col justify-between">
          <div>
            <div className="flex items-center justify-between pb-3 border-b border-slate-800">
              <h3 className="text-xs font-mono uppercase tracking-wider text-slate-400 font-bold">
                Sovereign Guard Inspector
              </h3>
              <button
                type="button"
                onClick={() => setShowSanitizerDiff(!showSanitizerDiff)}
                className="text-[10px] font-mono text-sky-400 hover:underline"
              >
                {showSanitizerDiff ? 'Hide Diff' : 'Toggle Diff'}
              </button>
            </div>

            {activeInspector ? (
              <div className="space-y-3.5 mt-3 text-xs">
                <div>
                  <span className="text-[10px] font-mono uppercase text-slate-400">Selected Route</span>
                  <div className="mt-1 font-bold text-emerald-400 flex items-center gap-1.5 font-mono">
                    <span>⚡ {activeInspector.chosenRoute}</span>
                  </div>
                  <p className="text-[11px] text-slate-400 mt-0.5">{activeInspector.routeReason}</p>
                </div>

                <div className="p-3 rounded-xl bg-slate-950 border border-slate-800 space-y-2">
                  <div className="text-[10px] font-mono uppercase text-slate-400">Sanitization Telemetry</div>
                  <ul className="space-y-1 text-[11px] font-mono text-slate-300">
                    {activeInspector.sanitizationDetails.map((detail, idx) => (
                      <li key={idx} className="flex items-start gap-1.5 text-emerald-400">
                        <span>•</span>
                        <span>{detail}</span>
                      </li>
                    ))}
                  </ul>
                </div>

                {showSanitizerDiff && (
                  <div className="space-y-2">
                    <div className="text-[10px] font-mono uppercase text-slate-400">Sanitized Payload Diff</div>
                    <div className="p-2.5 rounded-lg bg-slate-950 border border-slate-800 text-[10px] font-mono text-slate-300 whitespace-pre-wrap max-h-36 overflow-y-auto">
                      {activeInspector.maskedPrompt}
                    </div>
                  </div>
                )}
              </div>
            ) : (
              <div className="py-12 text-center text-xs text-slate-500">
                Send a prompt or select a test scenario above to inspect in-flight sanitization telemetry.
              </div>
            )}
          </div>

          {/* Spend Saved Comparison Box */}
          <div className="p-3.5 rounded-xl border border-emerald-500/30 bg-emerald-950/20 text-xs">
            <div className="font-bold text-emerald-400 flex items-center justify-between">
              <span>Financial Autonomy</span>
              <span className="text-[10px] font-mono px-1.5 py-0.2 rounded bg-emerald-500/20">88.4% SAVED</span>
            </div>
            <p className="text-[11px] text-slate-300 mt-1">
              Local GPU queries cost $0.00. Proprietary code and private records remain 100% on your machine.
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}
