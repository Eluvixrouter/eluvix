"use client";

import { useState, useEffect } from 'react';
import Link from 'next/link';
import { v4 as uuidv4 } from 'uuid';

export default function PlaygroundPage() {
  const [messages, setMessages] = useState<{role: string, content: string}[]>([]);
  const [input, setInput] = useState('');
  const [loading, setLoading] = useState(false);
  const [trace, setTrace] = useState<any>(null);
  
  const [sessions, setSessions] = useState<any[]>([]);
  const [currentSessionId, setCurrentSessionId] = useState<string>('');
  const [selectedModel, setSelectedModel] = useState<string>('auto');
  const [availableModels, setAvailableModels] = useState<string[]>(['auto']);

  useEffect(() => {
    // Generate an initial session id if none exists
    setCurrentSessionId(uuidv4());
    fetchSessions();
    fetch('/api/v1/models')
      .then((res) => res.json())
      .then((data) => {
        if (data && Array.isArray(data.data)) {
          const list = data.data.map((m: any) => m.id);
          setAvailableModels(list.length > 0 ? list : ['auto']);
        }
      })
      .catch(() => {});
  }, []);

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

  const loadSession = async (sessionId: string) => {
    try {
      const res = await fetch(`/api/v1/chat/history?session_id=${sessionId}`);
      const json = await res.json();
      if (json.success) {
        setMessages(json.data);
        setCurrentSessionId(sessionId);
        setTrace(null);
      }
    } catch (err) {
      console.error(err);
    }
  };

  const startNewSession = () => {
    setCurrentSessionId(uuidv4());
    setMessages([]);
    setTrace(null);
  };

  const sendMessage = async () => {
    if (!input.trim()) return;
    
    const newMessages = [...messages, { role: 'user', content: input }];
    setMessages(newMessages);
    setInput('');
    setLoading(true);
    setTrace(null);

    try {
      const res = await fetch('/api/v1/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: selectedModel || 'auto',
          messages: newMessages,
          session_id: currentSessionId
        })
      });

      const json = await res.json();
      
      if (json.success) {
        const assistantMsg = json.data.choices?.[0]?.message;
        if (assistantMsg) {
          setMessages(prev => [...prev, assistantMsg]);
        }
        setTrace(json.trace);
        fetchSessions(); // refresh sidebar
      } else {
        setMessages(prev => [...prev, { role: 'assistant', content: `Error: ${json.error}` }]);
      }
    } catch (err: any) {
      setMessages(prev => [...prev, { role: 'assistant', content: `Error: ${err.message}` }]);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="flex flex-col h-screen bg-slate-950 text-slate-100 font-sans">
      <header className="flex justify-between items-center p-4 border-b border-slate-800 shrink-0">
        <div className="flex items-center gap-3">
          <span className="text-2xl">🧪</span>
          <h1 className="text-xl font-bold text-sky-400">Playground &amp; Trace Viewer</h1>
        </div>

        <div className="flex items-center gap-2">
          <label className="text-xs text-slate-400 font-semibold hidden md:inline">Target Model:</label>
          <select
            value={selectedModel}
            onChange={(e) => setSelectedModel(e.target.value)}
            className="bg-slate-900 border border-slate-700 text-sky-300 text-xs rounded-lg px-2.5 py-1.5 focus:outline-none focus:border-sky-500 font-mono font-medium max-w-[220px] truncate"
            title="Select model to target or test auto-routing"
          >
            {availableModels.map((m) => (
              <option key={m} value={m}>
                {m === 'auto' ? '⚡ auto (Intelligent Router)' : m}
              </option>
            ))}
          </select>
        </div>

        <div className="flex gap-2.5 items-center">
          <Link href="/observability" className="text-xs bg-purple-600 hover:bg-purple-500 text-white font-semibold px-3 py-1.5 rounded transition flex items-center gap-1">
            <span>📊</span> Observability
          </Link>
          <Link href="/configurator" className="text-xs bg-sky-600 hover:bg-sky-500 text-white font-semibold px-3 py-1.5 rounded transition flex items-center gap-1">
            <span>⚙️</span> Configurator
          </Link>
          <Link href="/" className="text-xs bg-slate-800 hover:bg-slate-700 px-3 py-1.5 rounded transition">
            Dashboard
          </Link>
          <Link href="/editor" className="text-xs bg-indigo-600 hover:bg-indigo-500 text-white px-3 py-1.5 rounded transition">
            Routing Editor
          </Link>
        </div>
      </header>

      <div className="flex flex-1 overflow-hidden">
        {/* Sidebar */}
        <div className="w-64 bg-slate-900 border-r border-slate-800 flex flex-col p-4 overflow-y-auto">
          <button 
            onClick={startNewSession}
            className="w-full bg-emerald-600 hover:bg-emerald-500 text-white text-xs font-bold py-2 rounded mb-4 transition"
          >
            + New Session
          </button>
          <div className="text-xs font-bold text-slate-500 uppercase tracking-wider mb-3">Past Sessions</div>
          <div className="space-y-2">
            {sessions.map(s => (
              <button 
                key={s.session_id} 
                onClick={() => loadSession(s.session_id)}
                className={`w-full text-left text-xs p-2 rounded transition truncate ${currentSessionId === s.session_id ? 'bg-slate-800 text-sky-400 font-bold' : 'text-slate-400 hover:bg-slate-800'}`}
              >
                {s.session_id.substring(0, 8)}... ({s.message_count} msgs)
              </button>
            ))}
          </div>
        </div>

        {/* Chat Interface */}
        <div className="flex-1 border-r border-slate-800 flex flex-col relative">
          <div className="flex-1 overflow-y-auto p-4 space-y-4">
            {messages.length === 0 && (
              <div className="text-slate-500 text-center mt-10">Send a message to test the router. Try prompting it to leak its system prompt to trigger Semantic Guards!</div>
            )}
            {messages.map((m, i) => (
              <div key={i} className={`flex ${m.role === 'user' ? 'justify-end' : 'justify-start'}`}>
                <div className={`max-w-[80%] rounded-xl p-3 text-sm ${m.role === 'user' ? 'bg-sky-600 text-white' : 'bg-slate-800 text-slate-200'}`}>
                  {m.content}
                </div>
              </div>
            ))}
            {loading && (
              <div className="flex justify-start">
                <div className="bg-slate-800 text-slate-400 rounded-xl p-3 text-sm animate-pulse">Routing request...</div>
              </div>
            )}
          </div>
          <div className="p-4 border-t border-slate-800 shrink-0 bg-slate-900">
            <div className="flex gap-2">
              <input 
                type="text"
                value={input}
                onChange={e => setInput(e.target.value)}
                onKeyDown={e => e.key === 'Enter' && sendMessage()}
                className="flex-1 bg-slate-950 border border-slate-700 focus:border-sky-500 rounded p-3 text-sm outline-none"
                placeholder="Type a message..."
              />
              <button 
                onClick={sendMessage}
                disabled={loading}
                className="bg-sky-600 hover:bg-sky-500 text-white px-6 rounded font-bold transition disabled:opacity-50"
              >
                Send
              </button>
            </div>
          </div>
        </div>

        {/* Trace Viewer */}
        <div className="w-80 bg-slate-900 p-6 overflow-y-auto">
          <h2 className="text-sm font-bold text-slate-400 uppercase tracking-wider mb-6">Execution Trace</h2>
          
          {!trace && !loading && (
            <div className="text-slate-600 text-sm text-center mt-10">No trace available. Send a request.</div>
          )}

          {loading && (
            <div className="space-y-4 relative">
              <div className="absolute left-3 top-2 bottom-0 w-0.5 bg-slate-800"></div>
              
              <div className="flex gap-4 relative z-10 opacity-50">
                <div className="w-6 h-6 rounded-full bg-indigo-500 flex items-center justify-center text-xs shrink-0 mt-0.5">1</div>
                <div>
                  <div className="text-sm font-bold text-slate-300">Evaluating Complexity</div>
                  <div className="text-xs text-slate-500 mt-1">Estimating tokens and structure...</div>
                </div>
              </div>
            </div>
          )}

          {trace && (
            <div className="space-y-6 relative">
              <div className="absolute left-3 top-2 bottom-0 w-0.5 bg-slate-700"></div>
              
              {/* Step 1: Complexity */}
              <div className="flex gap-4 relative z-10">
                <div className="w-6 h-6 rounded-full bg-indigo-500 flex items-center justify-center text-xs font-bold shrink-0 mt-0.5">✓</div>
                <div>
                  <div className="text-sm font-bold text-white">Complexity Assessment</div>
                  <div className="text-xs text-indigo-300 mt-1">Score: {trace.complexity} | Tokens: ~{trace.tokens}</div>
                </div>
              </div>

              {/* Step 2: Guards */}
              <div className="flex gap-4 relative z-10">
                <div className="w-6 h-6 rounded-full bg-emerald-500 flex items-center justify-center text-xs font-bold shrink-0 mt-0.5">✓</div>
                <div>
                  <div className="text-sm font-bold text-white">Guardrails Evaluated</div>
                  <div className="text-xs text-emerald-300 mt-1">Privacy &amp; Semantic checks passed.</div>
                </div>
              </div>

              {/* Step 3: Routing */}
              <div className="flex gap-4 relative z-10">
                <div className="w-6 h-6 rounded-full bg-sky-500 flex items-center justify-center text-xs font-bold shrink-0 mt-0.5">✓</div>
                <div>
                  <div className="text-sm font-bold text-white">Upstream Selected</div>
                  <div className="text-xs text-sky-300 mt-1 font-mono">{trace.upstream}</div>
                </div>
              </div>

              {/* Step 4: Result */}
              <div className="flex gap-4 relative z-10">
                <div className={`w-6 h-6 rounded-full flex items-center justify-center text-xs font-bold shrink-0 mt-0.5 ${trace.status === 200 ? 'bg-green-500' : 'bg-red-500'}`}>
                  {trace.status === 200 ? '✓' : '!'}
                </div>
                <div>
                  <div className="text-sm font-bold text-white">Response Complete</div>
                  <div className="text-xs text-slate-400 mt-1">Status Code: {trace.status}</div>
                </div>
              </div>

            </div>
          )}
        </div>
      </div>
    </div>
  );
}
