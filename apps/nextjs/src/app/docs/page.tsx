'use client';

import { useState, useEffect, useMemo } from 'react';
import Link from 'next/link';
import { DOC_SECTIONS, DOC_CATEGORIES } from './docs-data';

export default function DocsPage() {
  const [activeSectionId, setActiveSectionId] = useState<string>('getting-started');
  const [searchQuery, setSearchQuery] = useState('');
  const [copiedCodeIndex, setCopiedCodeIndex] = useState<string | null>(null);
  const [baseUrl, setBaseUrl] = useState('https://localhost:3588');

  useEffect(() => {
    if (typeof window !== 'undefined') {
      setBaseUrl(window.location.origin);
      // Read hash on load
      const hash = window.location.hash.replace('#', '');
      if (hash && DOC_SECTIONS.some((s) => s.id === hash)) {
        setActiveSectionId(hash);
      }
    }
  }, []);

  const handleSelectSection = (id: string) => {
    setActiveSectionId(id);
    if (typeof window !== 'undefined') {
      window.location.hash = id;
    }
  };

  const handleCopyCode = (code: string, id: string) => {
    navigator.clipboard.writeText(code);
    setCopiedCodeIndex(id);
    setTimeout(() => setCopiedCodeIndex(null), 2000);
  };

  // Filter sections based on search query
  const filteredSections = useMemo(() => {
    if (!searchQuery.trim()) return DOC_SECTIONS;
    const q = searchQuery.toLowerCase();
    return DOC_SECTIONS.filter((s) => {
      const matchTitle = s.title.toLowerCase().includes(q);
      const matchSummary = s.summary.toLowerCase().includes(q);
      const matchSubsections = s.content.subsections.some(
        (sub) => sub.title.toLowerCase().includes(q) || sub.body.toLowerCase().includes(q)
      );
      return matchTitle || matchSummary || matchSubsections;
    });
  }, [searchQuery]);

  const activeSection = useMemo(() => {
    return (
      DOC_SECTIONS.find((s) => s.id === activeSectionId) ||
      filteredSections[0] ||
      DOC_SECTIONS[0]
    );
  }, [activeSectionId, filteredSections]);

  const currentIndex = DOC_SECTIONS.findIndex((s) => s.id === activeSection.id);
  const prevSection = currentIndex > 0 ? DOC_SECTIONS[currentIndex - 1] : null;
  const nextSection = currentIndex < DOC_SECTIONS.length - 1 ? DOC_SECTIONS[currentIndex + 1] : null;

  return (
    <div className="min-h-screen bg-slate-950 text-slate-100 flex flex-col font-sans">
      {/* Top Header */}
      <header className="sticky top-0 z-30 px-6 py-3.5 border-b border-slate-800 bg-slate-900/90 backdrop-blur-md flex flex-wrap justify-between items-center gap-4">
        <div className="flex items-center gap-4">
          <Link
            href="/"
            className="flex items-center gap-1.5 text-xs font-semibold text-slate-400 hover:text-sky-400 bg-slate-800/80 hover:bg-slate-800 px-3 py-1.5 rounded-lg border border-slate-700 transition"
          >
            <span>←</span> Upstream Settings
          </Link>
          <div className="h-4 w-px bg-slate-700" />
          <div className="flex items-center gap-2">
            <span className="text-xl">📖</span>
            <div>
              <h1 className="text-sm font-bold text-slate-100 flex items-center gap-2">
                Eluvix In-App Documentation
                <span className="bg-sky-500/10 text-sky-400 border border-sky-500/30 text-[10px] font-mono px-2 py-0.5 rounded-full">
                  v1.0.4
                </span>
              </h1>
              <p className="text-[11px] text-slate-400">
                Complete architectural guide, agent harnesses, memory engines, and API reference
              </p>
            </div>
          </div>
        </div>

        {/* Global Navigation Shortcuts */}
        <div className="flex items-center gap-2">
          <div className="hidden md:flex items-center gap-2 px-3 py-1 rounded-full bg-emerald-950/60 border border-emerald-600/40 text-[11px] text-emerald-400">
            <span className="w-2 h-2 rounded-full bg-emerald-400 animate-pulse" />
            <span>Active: {baseUrl}/api/v1</span>
          </div>
          <Link
            href="/editor"
            className="bg-indigo-600/20 hover:bg-indigo-600 text-indigo-300 hover:text-white border border-indigo-500/40 font-semibold text-xs px-3 py-1.5 rounded-lg transition flex items-center gap-1.5"
          >
            <span>🔀</span> Editor
          </Link>
          <Link
            href="/playground"
            className="bg-emerald-600/20 hover:bg-emerald-600 text-emerald-300 hover:text-white border border-emerald-500/40 font-semibold text-xs px-3 py-1.5 rounded-lg transition flex items-center gap-1.5"
          >
            <span>🧪</span> Playground
          </Link>
          <Link
            href="/observability"
            className="bg-purple-600/20 hover:bg-purple-600 text-purple-300 hover:text-white border border-purple-500/40 font-semibold text-xs px-3 py-1.5 rounded-lg transition flex items-center gap-1.5"
          >
            <span>📊</span> Observability
          </Link>
          <Link
            href="/configurator"
            className="bg-sky-600/20 hover:bg-sky-600 text-sky-300 hover:text-white border border-sky-500/40 font-semibold text-xs px-3 py-1.5 rounded-lg transition flex items-center gap-1.5"
          >
            <span>⚙️</span> Configurator
          </Link>
        </div>
      </header>

      {/* Main Documentation Container */}
      <div className="flex-1 flex max-w-7xl w-full mx-auto px-4 md:px-6 py-6 gap-8">
        {/* Sidebar */}
        <aside className="w-72 shrink-0 hidden md:block">
          <div className="sticky top-20 space-y-6">
            {/* Search Input */}
            <div className="relative">
              <input
                type="text"
                placeholder="Search documentation..."
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                className="w-full bg-slate-900 border border-slate-800 rounded-lg px-3 py-2 text-xs text-slate-200 placeholder-slate-500 focus:outline-none focus:border-sky-500 transition"
              />
              {searchQuery && (
                <button
                  onClick={() => setSearchQuery('')}
                  className="absolute right-2.5 top-2 text-slate-500 hover:text-slate-300 text-xs"
                >
                  ✕
                </button>
              )}
            </div>

            {/* Categorized Topic List */}
            <div className="space-y-5">
              {DOC_CATEGORIES.map((category) => {
                const categorySections = filteredSections.filter((s) => s.category === category);
                if (categorySections.length === 0) return null;

                return (
                  <div key={category}>
                    <h3 className="text-[11px] font-bold text-slate-400 uppercase tracking-wider mb-2 px-2">
                      {category}
                    </h3>
                    <ul className="space-y-1">
                      {categorySections.map((sec) => {
                        const isActive = sec.id === activeSection.id;
                        return (
                          <li key={sec.id}>
                            <button
                              onClick={() => handleSelectSection(sec.id)}
                              className={`w-full text-left px-3 py-2 rounded-lg text-xs font-medium flex items-center justify-between transition ${
                                isActive
                                  ? 'bg-sky-600/20 text-sky-300 border border-sky-500/40 shadow-sm'
                                  : 'text-slate-400 hover:text-slate-200 hover:bg-slate-900/60'
                              }`}
                            >
                              <span className="flex items-center gap-2 truncate">
                                <span>{sec.icon}</span>
                                <span className="truncate">{sec.title}</span>
                              </span>
                              {sec.badge && (
                                <span className="text-[9px] font-mono px-1.5 py-0.5 rounded bg-sky-500/20 text-sky-400 border border-sky-500/30 uppercase">
                                  {sec.badge}
                                </span>
                              )}
                            </button>
                          </li>
                        );
                      })}
                    </ul>
                  </div>
                );
              })}
            </div>

            {/* Quick Link to External Docs / GitHub */}
            <div className="p-3 rounded-xl bg-slate-900/60 border border-slate-800 text-[11px] text-slate-400 space-y-1.5">
              <div className="font-semibold text-slate-200 flex items-center gap-1.5">
                <span>🌐</span> Offline Self-Hosted Mode
              </div>
              <p>
                All documentation is stored locally in the application bundle. No external internet connectivity is required.
              </p>
            </div>
          </div>
        </aside>

        {/* Main Content Area */}
        <main className="flex-1 min-w-0 pb-16">
          <article className="space-y-8">
            {/* Header Section */}
            <div className="border-b border-slate-800 pb-6">
              <div className="flex items-center gap-2 text-xs font-mono text-sky-400 uppercase tracking-wider mb-2">
                <span>{activeSection.category}</span>
                <span>•</span>
                <span>{activeSection.id}</span>
                {activeSection.badge && (
                  <span className="bg-sky-500/20 text-sky-300 border border-sky-500/40 text-[9px] px-2 py-0.5 rounded-full font-bold">
                    {activeSection.badge}
                  </span>
                )}
              </div>
              <h2 className="text-2xl md:text-3xl font-extrabold text-white flex items-center gap-3">
                <span>{activeSection.icon}</span>
                <span>{activeSection.title}</span>
              </h2>
              <p className="mt-3 text-sm text-slate-300 leading-relaxed max-w-3xl">
                {activeSection.summary}
              </p>
            </div>

            {/* Overview */}
            <div className="p-4 rounded-xl bg-slate-900/50 border border-slate-800 text-sm text-slate-300 leading-relaxed">
              {activeSection.content.overview}
            </div>

            {/* Subsections */}
            <div className="space-y-8">
              {activeSection.content.subsections.map((sub, idx) => (
                <section key={idx} className="space-y-4">
                  <h3 className="text-lg font-bold text-slate-100 flex items-center gap-2">
                    <span className="text-sky-400">#</span>
                    <span>{sub.title}</span>
                  </h3>
                  <p className="text-xs md:text-sm text-slate-300 leading-relaxed">
                    {sub.body}
                  </p>

                  {/* Table rendering */}
                  {sub.table && (
                    <div className="overflow-x-auto rounded-xl border border-slate-800 bg-slate-900/40">
                      <table className="w-full text-left text-xs border-collapse">
                        <thead>
                          <tr className="border-b border-slate-800 bg-slate-900/80">
                            {sub.table.headers.map((h, i) => (
                              <th key={i} className="py-2.5 px-3.5 font-bold text-slate-300">
                                {h}
                              </th>
                            ))}
                          </tr>
                        </thead>
                        <tbody className="divide-y divide-slate-800/60">
                          {sub.table.rows.map((row, rIdx) => (
                            <tr key={rIdx} className="hover:bg-slate-800/20 transition">
                              {row.map((cell, cIdx) => (
                                <td key={cIdx} className="py-2.5 px-3.5 text-slate-300 font-mono text-[11px]">
                                  {cell}
                                </td>
                              ))}
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  )}

                  {/* Code block rendering */}
                  {sub.code && (
                    <div className="relative rounded-xl border border-slate-800 bg-slate-900/80 overflow-hidden font-mono text-xs">
                      <div className="px-4 py-2 border-b border-slate-800 flex justify-between items-center bg-slate-950/40 text-[11px] text-slate-400">
                        <span>{sub.code.language}</span>
                        <button
                          onClick={() => handleCopyCode(sub.code!.content, `${activeSection.id}-${idx}`)}
                          className="hover:text-sky-300 transition text-[11px] flex items-center gap-1"
                        >
                          {copiedCodeIndex === `${activeSection.id}-${idx}` ? '✓ Copied' : '📋 Copy'}
                        </button>
                      </div>
                      <pre className="p-4 overflow-x-auto text-sky-200/90 leading-relaxed font-mono">
                        <code>{sub.code.content}</code>
                      </pre>
                    </div>
                  )}

                  {/* Note block */}
                  {sub.note && (
                    <div className="p-3.5 rounded-lg bg-sky-950/30 border border-sky-600/30 text-xs text-sky-200 flex items-start gap-2.5">
                      <span className="text-base">💡</span>
                      <span className="leading-relaxed">{sub.note}</span>
                    </div>
                  )}
                </section>
              ))}
            </div>

            {/* Bottom Navigation */}
            <div className="border-t border-slate-800 pt-6 flex justify-between items-center">
              {prevSection ? (
                <button
                  onClick={() => handleSelectSection(prevSection.id)}
                  className="flex items-center gap-2 px-4 py-2 rounded-lg bg-slate-900 border border-slate-800 hover:border-slate-700 text-xs font-semibold text-slate-300 hover:text-white transition"
                >
                  <span>←</span>
                  <span>{prevSection.title}</span>
                </button>
              ) : (
                <div />
              )}
              {nextSection ? (
                <button
                  onClick={() => handleSelectSection(nextSection.id)}
                  className="flex items-center gap-2 px-4 py-2 rounded-lg bg-slate-900 border border-slate-800 hover:border-slate-700 text-xs font-semibold text-slate-300 hover:text-white transition"
                >
                  <span>{nextSection.title}</span>
                  <span>→</span>
                </button>
              ) : (
                <div />
              )}
            </div>
          </article>
        </main>
      </div>
    </div>
  );
}
