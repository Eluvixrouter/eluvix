"use client";

import { useState, useEffect } from 'react';

interface SaveAsModalProps {
  isOpen: boolean;
  onClose: () => void;
  onSave: (data: {
    name: string;
    slug: string;
    description: string;
    category: string;
    tags: string[];
    overwrite: boolean;
  }) => Promise<void>;
  initialName?: string;
  initialSlug?: string;
  initialDescription?: string;
  initialCategory?: string;
  initialTags?: string[];
  existingSlugs: string[];
}

export default function SaveAsModal({
  isOpen,
  onClose,
  onSave,
  initialName = '',
  initialSlug = '',
  initialDescription = '',
  initialCategory = 'custom',
  initialTags = [],
  existingSlugs = []
}: SaveAsModalProps) {
  const [name, setName] = useState(initialName);
  const [slug, setSlug] = useState(initialSlug);
  const [isSlugManuallyEdited, setIsSlugManuallyEdited] = useState(false);
  const [description, setDescription] = useState(initialDescription);
  const [category, setCategory] = useState(initialCategory);
  const [tagsInput, setTagsInput] = useState(initialTags.join(', '));
  const [overwrite, setOverwrite] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);

  useEffect(() => {
    if (isOpen) {
      setName(initialName || '');
      setSlug(initialSlug || '');
      setIsSlugManuallyEdited(Boolean(initialSlug));
      setDescription(initialDescription || '');
      setCategory(initialCategory || 'custom');
      setTagsInput(initialTags.join(', '));
      setOverwrite(false);
      setError(null);
    }
  }, [isOpen, initialName, initialSlug, initialDescription, initialCategory, initialTags]);

  const handleNameChange = (val: string) => {
    setName(val);
    if (!isSlugManuallyEdited) {
      const generated = val
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '');
      setSlug(generated);
    }
  };

  const handleSlugChange = (val: string) => {
    setIsSlugManuallyEdited(true);
    const cleaned = val
      .toLowerCase()
      .replace(/[^a-z0-9-]/g, '')
      .replace(/^-+/, '');
    setSlug(cleaned);
  };

  const slugExists = existingSlugs.includes(slug.trim());

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);

    const trimmedName = name.trim();
    const trimmedSlug = slug.trim();

    if (!trimmedName) {
      setError('Layout name is required');
      return;
    }
    if (!trimmedSlug) {
      setError('Slug identifier is required');
      return;
    }
    if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(trimmedSlug)) {
      setError('Slug must start with an alphanumeric char and only contain lowercase letters, numbers, and dashes (max 64 chars)');
      return;
    }
    if (slugExists && !overwrite) {
      setError(`A layout with slug "${trimmedSlug}" already exists. Check "Overwrite existing layout" to replace it.`);
      return;
    }

    const tags = tagsInput
      .split(',')
      .map(t => t.trim().toLowerCase())
      .filter(t => t.length > 0);

    setIsSubmitting(true);
    try {
      await onSave({
        name: trimmedName,
        slug: trimmedSlug,
        description: description.trim(),
        category,
        tags,
        overwrite
      });
      onClose();
    } catch (err: any) {
      setError(err.message || 'Failed to save layout');
    } finally {
      setIsSubmitting(false);
    }
  };

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 bg-black/75 backdrop-blur-sm flex items-center justify-center z-50 p-4 animate-in fade-in duration-200">
      <div className="bg-slate-900 border border-slate-700 rounded-xl shadow-2xl w-full max-w-lg overflow-hidden flex flex-col">
        {/* Header */}
        <div className="flex justify-between items-center px-6 py-4 border-b border-slate-800 bg-slate-950/60">
          <div className="flex items-center gap-2">
            <span className="text-xl">💾</span>
            <h3 className="text-lg font-bold text-white">Save Routing Layout</h3>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="text-slate-400 hover:text-white transition p-1 rounded-lg hover:bg-slate-800"
          >
            ✕
          </button>
        </div>

        {/* Form Body */}
        <form onSubmit={handleSubmit} className="p-6 space-y-4">
          {error && (
            <div className="p-3 bg-red-950/80 border border-red-500/50 rounded-lg text-red-200 text-xs flex items-center gap-2">
              <span>⚠️</span>
              <span>{error}</span>
            </div>
          )}

          <div>
            <label className="block text-xs font-semibold text-slate-300 mb-1.5">
              Layout Display Name <span className="text-sky-400">*</span>
            </label>
            <input
              type="text"
              className="w-full bg-slate-950 border border-slate-700 focus:border-sky-500 rounded-lg p-2.5 text-white text-sm outline-none transition"
              placeholder="e.g. My Private Airgapped Stack"
              value={name}
              onChange={(e) => handleNameChange(e.target.value)}
              autoFocus
              required
            />
          </div>

          <div>
            <div className="flex items-center justify-between mb-1.5">
              <label className="block text-xs font-semibold text-slate-300">
                File Slug (Identifier) <span className="text-sky-400">*</span>
              </label>
              <span className="text-[10px] text-slate-400 font-mono">
                ~/.config/eluvix/layouts/{slug || 'layout'}.json
              </span>
            </div>
            <input
              type="text"
              className={`w-full bg-slate-950 border rounded-lg p-2.5 text-white text-sm font-mono outline-none transition ${
                slugExists && !overwrite
                  ? 'border-amber-500/70 focus:border-amber-500'
                  : 'border-slate-700 focus:border-sky-500'
              }`}
              placeholder="e.g. my-private-airgapped-stack"
              value={slug}
              onChange={(e) => handleSlugChange(e.target.value)}
              required
            />
            {slugExists && (
              <div className="mt-2 flex items-center gap-2">
                <input
                  type="checkbox"
                  id="overwrite-checkbox"
                  className="w-4 h-4 accent-amber-500 rounded cursor-pointer"
                  checked={overwrite}
                  onChange={(e) => setOverwrite(e.target.checked)}
                />
                <label htmlFor="overwrite-checkbox" className="text-xs text-amber-300 cursor-pointer">
                  A layout with this slug already exists. Overwrite it?
                </label>
              </div>
            )}
          </div>

          <div>
            <label className="block text-xs font-semibold text-slate-300 mb-1.5">
              Description <span className="text-slate-500 font-normal">(optional)</span>
            </label>
            <textarea
              className="w-full bg-slate-950 border border-slate-700 focus:border-sky-500 rounded-lg p-2.5 text-white text-xs outline-none transition resize-none h-18"
              placeholder="Describe this routing pipeline's purpose and upstreams..."
              value={description}
              onChange={(e) => setDescription(e.target.value)}
            />
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="block text-xs font-semibold text-slate-300 mb-1.5">
                Category
              </label>
              <select
                className="w-full bg-slate-950 border border-slate-700 focus:border-sky-500 rounded-lg p-2.5 text-white text-xs outline-none transition cursor-pointer"
                value={category}
                onChange={(e) => setCategory(e.target.value)}
              >
                <option value="custom">Custom</option>
                <option value="starter">Starter</option>
                <option value="local">Local Inference</option>
                <option value="hybrid">Hybrid / Fallback</option>
                <option value="agent">Autonomous Agents</option>
                <option value="cost">Cost Optimization</option>
                <option value="privacy">Privacy &amp; Security</option>
              </select>
            </div>

            <div>
              <label className="block text-xs font-semibold text-slate-300 mb-1.5">
                Tags <span className="text-slate-500 font-normal">(comma-separated)</span>
              </label>
              <input
                type="text"
                className="w-full bg-slate-950 border border-slate-700 focus:border-sky-500 rounded-lg p-2.5 text-white text-xs outline-none transition"
                placeholder="production, offline, coding"
                value={tagsInput}
                onChange={(e) => setTagsInput(e.target.value)}
              />
            </div>
          </div>

          {/* Action Buttons */}
          <div className="flex justify-end gap-3 pt-3 border-t border-slate-800">
            <button
              type="button"
              onClick={onClose}
              disabled={isSubmitting}
              className="px-4 py-2 bg-slate-800 hover:bg-slate-700 text-slate-300 hover:text-white rounded-lg text-xs font-semibold transition"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={isSubmitting}
              className="px-5 py-2 bg-sky-600 hover:bg-sky-500 text-white rounded-lg text-xs font-bold transition shadow flex items-center gap-1.5 disabled:opacity-50"
            >
              <span>💾</span>
              <span>{isSubmitting ? 'Saving...' : 'Save Layout'}</span>
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
