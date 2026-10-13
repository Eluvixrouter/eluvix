"use client";

import { useState, useMemo } from 'react';
import { LayoutMetadata } from '@/lib/layouts/types';

interface LayoutBrowserModalProps {
  isOpen: boolean;
  onClose: () => void;
  layouts: LayoutMetadata[];
  activeSlug: string;
  layoutsDir: string;
  onSelectLayout: (slug: string) => Promise<void>;
  onDeleteLayout: (slug: string) => Promise<void>;
  onDuplicateLayout: (slug: string) => Promise<void>;
  onRestoreExamples: () => Promise<void>;
}

export default function LayoutBrowserModal({
  isOpen,
  onClose,
  layouts,
  activeSlug,
  layoutsDir,
  onSelectLayout,
  onDeleteLayout,
  onDuplicateLayout,
  onRestoreExamples
}: LayoutBrowserModalProps) {
  const [selectedCategory, setSelectedCategory] = useState<string>('all');
  const [searchQuery, setSearchQuery] = useState<string>('');
  const [deletingSlug, setDeletingSlug] = useState<string | null>(null);
  const [isRestoring, setIsRestoring] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  const categories = useMemo(() => [
    { id: 'all', label: 'All Layouts' },
    { id: 'starter', label: 'Starters' },
    { id: 'local', label: 'Local Inference' },
    { id: 'hybrid', label: 'Hybrid & Coding' },
    { id: 'agent', label: 'Autonomous Agents' },
    { id: 'cost', label: 'Cost Cascades' },
    { id: 'privacy', label: 'Privacy & Airgap' },
    { id: 'custom', label: 'My Custom' },
  ], []);

  const filteredLayouts = useMemo(() => {
    return layouts.filter((layout) => {
      // Category match
      if (selectedCategory !== 'all') {
        if (selectedCategory === 'custom' && (layout.isExample || (layout.category && layout.category !== 'custom'))) {
          return false;
        } else if (selectedCategory !== 'custom' && layout.category !== selectedCategory) {
          return false;
        }
      }

      // Search match
      if (searchQuery.trim()) {
        const q = searchQuery.toLowerCase();
        const matchesName = layout.name.toLowerCase().includes(q);
        const matchesDesc = (layout.description || '').toLowerCase().includes(q);
        const matchesSlug = layout.id.toLowerCase().includes(q);
        const matchesTags = (layout.tags || []).some(t => t.toLowerCase().includes(q));
        if (!matchesName && !matchesDesc && !matchesSlug && !matchesTags) {
          return false;
        }
      }

      return true;
    });
  }, [layouts, selectedCategory, searchQuery]);

  const handleOpen = async (slug: string) => {
    setActionError(null);
    try {
      await onSelectLayout(slug);
      onClose();
    } catch (err: any) {
      setActionError(err.message || 'Failed to open layout');
    }
  };

  const handleDelete = async (slug: string) => {
    if (!confirm(`Are you sure you want to delete the layout "${slug}"? This will remove ~/.config/eluvix/layouts/${slug}.json.`)) {
      return;
    }
    setActionError(null);
    setDeletingSlug(slug);
    try {
      await onDeleteLayout(slug);
    } catch (err: any) {
      setActionError(err.message || 'Failed to delete layout');
    } finally {
      setDeletingSlug(null);
    }
  };

  const handleRestore = async () => {
    if (!confirm('This will restore all 12 bundled example templates to ~/.config/eluvix/layouts. Continue?')) {
      return;
    }
    setActionError(null);
    setIsRestoring(true);
    try {
      await onRestoreExamples();
    } catch (err: any) {
      setActionError(err.message || 'Failed to restore examples');
    } finally {
      setIsRestoring(false);
    }
  };

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 bg-black/80 backdrop-blur-sm flex items-center justify-center z-50 p-4 animate-in fade-in duration-200">
      <div className="bg-slate-900 border border-slate-700 rounded-xl shadow-2xl w-full max-w-5xl h-[85vh] flex flex-col overflow-hidden">
        
        {/* Header */}
        <div className="px-6 py-4 border-b border-slate-800 bg-slate-950/80 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <span className="text-2xl">📁</span>
            <div>
              <h2 className="text-lg font-bold text-white flex items-center gap-2">
                Routing Layouts &amp; Templates
                <span className="text-xs font-mono font-normal bg-sky-500/10 text-sky-400 border border-sky-500/30 px-2 py-0.5 rounded-full">
                  {layouts.length} available
                </span>
              </h2>
              <p className="text-xs text-slate-400 font-mono flex items-center gap-1">
                <span>Directory:</span>
                <span className="text-slate-300 font-semibold">{layoutsDir || '~/.config/eluvix/layouts'}</span>
              </p>
            </div>
          </div>
          
          <button
            type="button"
            onClick={onClose}
            className="text-slate-400 hover:text-white transition p-1.5 rounded-lg hover:bg-slate-800"
          >
            ✕
          </button>
        </div>

        {/* Toolbar: Search + Category Tabs */}
        <div className="px-6 py-3 border-b border-slate-800 bg-slate-900/90 flex flex-col md:flex-row gap-3 items-center justify-between">
          {/* Category Filter Tabs */}
          <div className="flex items-center gap-1.5 overflow-x-auto w-full md:w-auto pb-1 md:pb-0 scrollbar-none">
            {categories.map((cat) => (
              <button
                key={cat.id}
                type="button"
                onClick={() => setSelectedCategory(cat.id)}
                className={`px-3 py-1.5 rounded-lg text-xs font-medium whitespace-nowrap transition ${
                  selectedCategory === cat.id
                    ? 'bg-sky-600 text-white shadow-sm'
                    : 'bg-slate-800/80 text-slate-400 hover:text-slate-200 hover:bg-slate-800'
                }`}
              >
                {cat.label}
              </button>
            ))}
          </div>

          {/* Search Box */}
          <div className="w-full md:w-72 relative">
            <span className="absolute left-3 top-2.5 text-xs text-slate-500">🔍</span>
            <input
              type="text"
              className="w-full bg-slate-950 border border-slate-700 focus:border-sky-500 rounded-lg pl-8 pr-3 py-1.5 text-xs text-white placeholder-slate-500 outline-none transition"
              placeholder="Search by name, tag, or slug..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
            />
            {searchQuery && (
              <button
                type="button"
                onClick={() => setSearchQuery('')}
                className="absolute right-2.5 top-2 text-slate-500 hover:text-slate-300 text-xs"
              >
                ✕
              </button>
            )}
          </div>
        </div>

        {/* Error notification if any */}
        {actionError && (
          <div className="mx-6 mt-3 p-3 bg-red-950/80 border border-red-500/50 rounded-lg text-red-200 text-xs flex items-center justify-between">
            <div className="flex items-center gap-2">
              <span>⚠️</span>
              <span>{actionError}</span>
            </div>
            <button onClick={() => setActionError(null)} className="text-red-400 hover:text-red-200">✕</button>
          </div>
        )}

        {/* Layout Cards Grid */}
        <div className="flex-1 p-6 overflow-y-auto bg-slate-950/50">
          {filteredLayouts.length === 0 ? (
            <div className="h-full flex flex-col items-center justify-center text-slate-500 gap-3">
              <span className="text-4xl">📂</span>
              <p className="text-sm font-medium">No matching layouts found</p>
              {searchQuery && (
                <button
                  type="button"
                  onClick={() => setSearchQuery('')}
                  className="text-xs text-sky-400 hover:underline"
                >
                  Clear search filter
                </button>
              )}
            </div>
          ) : (
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
              {filteredLayouts.map((layout) => {
                const isActive = layout.id === activeSlug;
                return (
                  <div
                    key={layout.id}
                    className={`bg-slate-900 border rounded-xl p-4 flex flex-col justify-between transition group hover:shadow-lg hover:border-slate-600 ${
                      isActive
                        ? 'border-sky-500/80 bg-sky-950/15 ring-1 ring-sky-500/30'
                        : 'border-slate-800'
                    }`}
                  >
                    <div>
                      {/* Top Header */}
                      <div className="flex items-start justify-between gap-2 mb-2">
                        <div className="flex-1 min-w-0">
                          <h4 className="font-bold text-sm text-white truncate flex items-center gap-1.5" title={layout.name}>
                            {layout.isExample ? '🌟' : '📐'} {layout.name}
                          </h4>
                          <span className="text-[10px] font-mono text-slate-500 block truncate">
                            {layout.id}.json
                          </span>
                        </div>
                        {isActive && (
                          <span className="bg-sky-500/20 text-sky-300 border border-sky-500/40 text-[10px] font-semibold px-2 py-0.5 rounded-full whitespace-nowrap">
                            Active
                          </span>
                        )}
                      </div>

                      {/* Description */}
                      <p className="text-xs text-slate-400 line-clamp-2 mb-3 min-h-[32px]">
                        {layout.description || 'No description provided.'}
                      </p>

                      {/* Tags */}
                      <div className="flex flex-wrap gap-1 mb-4">
                        {layout.tags && layout.tags.map((tag) => (
                          <span
                            key={tag}
                            className="text-[10px] bg-slate-800 text-slate-300 border border-slate-700/60 px-1.5 py-0.5 rounded font-mono"
                          >
                            #{tag}
                          </span>
                        ))}
                      </div>
                    </div>

                    {/* Footer / Metrics & Actions */}
                    <div>
                      <div className="flex items-center justify-between text-[11px] text-slate-500 border-t border-slate-800/80 pt-2.5 mb-3">
                        <div className="flex items-center gap-3">
                          <span title="Node count">📦 {layout.nodeCount} nodes</span>
                          <span title="Edge count">🔗 {layout.edgeCount} edges</span>
                        </div>
                        <span className="text-[10px]">
                          v{layout.version}
                        </span>
                      </div>

                      <div className="flex items-center justify-between gap-2">
                        <div className="flex items-center gap-1">
                          <button
                            type="button"
                            onClick={() => onDuplicateLayout(layout.id)}
                            title="Duplicate this layout"
                            className="p-1.5 text-slate-400 hover:text-white bg-slate-800 hover:bg-slate-700 rounded-lg text-xs transition"
                          >
                            📋
                          </button>
                          {layout.id !== 'default' && (
                            <button
                              type="button"
                              onClick={() => handleDelete(layout.id)}
                              disabled={deletingSlug === layout.id}
                              title="Delete layout file"
                              className="p-1.5 text-slate-400 hover:text-red-400 bg-slate-800 hover:bg-slate-700 rounded-lg text-xs transition disabled:opacity-50"
                            >
                              🗑️
                            </button>
                          )}
                        </div>

                        <button
                          type="button"
                          onClick={() => handleOpen(layout.id)}
                          className={`px-3.5 py-1.5 rounded-lg text-xs font-semibold transition flex items-center gap-1.5 ${
                            isActive
                              ? 'bg-sky-600/30 text-sky-300 hover:bg-sky-600/40 border border-sky-500/30'
                              : 'bg-sky-600 hover:bg-sky-500 text-white shadow'
                          }`}
                        >
                          <span>{isActive ? 'Reload Canvas' : 'Load Layout'}</span>
                          <span>→</span>
                        </button>
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>

        {/* Modal Bottom Bar */}
        <div className="px-6 py-3.5 border-t border-slate-800 bg-slate-950 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <button
              type="button"
              onClick={handleRestore}
              disabled={isRestoring}
              className="text-xs text-amber-400 hover:text-amber-300 bg-amber-950/40 hover:bg-amber-950/60 border border-amber-600/40 px-3 py-1.5 rounded-lg transition flex items-center gap-1.5 disabled:opacity-50"
            >
              <span>🔄</span>
              <span>{isRestoring ? 'Restoring Examples...' : 'Restore Example Templates'}</span>
            </button>
          </div>

          <div className="flex items-center gap-3">
            <button
              type="button"
              onClick={onClose}
              className="px-4 py-2 bg-slate-800 hover:bg-slate-700 text-slate-300 hover:text-white rounded-lg text-xs font-semibold transition"
            >
              Close
            </button>
          </div>
        </div>

      </div>
    </div>
  );
}
