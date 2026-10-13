'use client';

import { useState, useEffect, useRef, useMemo } from 'react';
import { ALL_THEMES, DEFAULT_THEME_ID, getThemeById, applyTheme, EluvixTheme, ThemeCategory } from '@/lib/themes';

const CATEGORY_TABS: { key: ThemeCategory | 'all'; label: string }[] = [
  { key: 'all', label: 'All (20)' },
  { key: 'original', label: 'Original' },
  { key: 'dark-ambient', label: 'Ambient Dark' },
  { key: 'oled', label: 'OLED' },
  { key: 'light', label: 'Light' },
  { key: 'catppuccin', label: 'Catppuccin' },
  { key: 'gruvbox', label: 'Gruvbox' },
  { key: 'solarized', label: 'Solarized' },
  { key: 'dark-red', label: 'Night Red' },
];

export function ThemeSwitcher() {
  const [currentThemeId, setCurrentThemeId] = useState<string>(DEFAULT_THEME_ID);
  const [isOpen, setIsOpen] = useState(false);
  const [activeCategory, setActiveCategory] = useState<ThemeCategory | 'all'>('all');
  const [searchQuery, setSearchQuery] = useState('');
  const popoverRef = useRef<HTMLDivElement>(null);

  // Initialize theme on mount
  useEffect(() => {
    try {
      const saved = localStorage.getItem('eluvix-theme');
      if (saved) {
        const theme = getThemeById(saved);
        setCurrentThemeId(theme.id);
        applyTheme(theme);
      }
    } catch {
      // Ignore localStorage security exceptions
    }
  }, []);

  // Close on outside click or Escape
  useEffect(() => {
    if (!isOpen) return;

    function handleClickOutside(e: MouseEvent) {
      if (popoverRef.current && !popoverRef.current.contains(e.target as Node)) {
        setIsOpen(false);
      }
    }

    function handleKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape') {
        setIsOpen(false);
      }
    }

    document.addEventListener('mousedown', handleClickOutside);
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [isOpen]);

  const activeTheme = useMemo(() => getThemeById(currentThemeId), [currentThemeId]);

  const filteredThemes = useMemo(() => {
    return ALL_THEMES.filter((theme) => {
      const matchesCategory =
        activeCategory === 'all' || theme.category === activeCategory;
      const query = searchQuery.trim().toLowerCase();
      const matchesSearch =
        !query ||
        theme.name.toLowerCase().includes(query) ||
        theme.description.toLowerCase().includes(query) ||
        theme.id.toLowerCase().includes(query) ||
        theme.category.toLowerCase().includes(query);
      return matchesCategory && matchesSearch;
    });
  }, [activeCategory, searchQuery]);

  function handleSelectTheme(theme: EluvixTheme) {
    setCurrentThemeId(theme.id);
    applyTheme(theme);
    try {
      localStorage.setItem('eluvix-theme', theme.id);
    } catch {
      // Ignore
    }
    setIsOpen(false);
  }

  function handleReset() {
    const defaultTheme = getThemeById(DEFAULT_THEME_ID);
    handleSelectTheme(defaultTheme);
  }

  return (
    <div className="relative inline-block text-left" ref={popoverRef}>
      {/* Trigger Button */}
      <button
        type="button"
        onClick={() => setIsOpen((prev) => !prev)}
        className="flex items-center gap-2 rounded-lg border border-slate-800 bg-slate-900/90 hover:bg-slate-800/90 px-2.5 py-1.5 text-xs font-medium text-slate-200 shadow-sm transition-all focus:outline-none focus:ring-2 focus:ring-sky-500/50"
        aria-label="Change theme"
        aria-expanded={isOpen}
      >
        {/* Color Palette Icon */}
        <svg
          viewBox="0 0 24 24"
          className="w-3.5 h-3.5 text-sky-400"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <circle cx="13.5" cy="6.5" r=".5" fill="currentColor" />
          <circle cx="17.5" cy="10.5" r=".5" fill="currentColor" />
          <circle cx="8.5" cy="7.5" r=".5" fill="currentColor" />
          <circle cx="6.5" cy="12.5" r=".5" fill="currentColor" />
          <path d="M12 2C6.5 2 2 6.5 2 12s4.5 10 10 10c.926 0 1.648-.746 1.648-1.688 0-.437-.18-.835-.437-1.125-.29-.289-.438-.652-.438-1.125a1.64 1.64 0 0 1 1.668-1.668h1.996c3.051 0 5.563-2.512 5.563-5.563C22 6.5 17.5 2 12 2z" />
        </svg>

        {/* Current Active Theme Swatch & Label */}
        <div className="flex items-center gap-1.5">
          <span
            className="w-3 h-3 rounded-full border border-white/20 shadow-inner shrink-0"
            style={{
              background: `linear-gradient(135deg, ${activeTheme.colors.bg} 50%, ${activeTheme.colors.accent} 50%)`,
            }}
          />
          <span className="hidden sm:inline-block max-w-[100px] truncate text-slate-300">
            {activeTheme.name.replace(/ \(Original\)/, '')}
          </span>
        </div>

        {/* Chevron */}
        <svg
          viewBox="0 0 20 20"
          className={`w-3.5 h-3.5 text-slate-400 transition-transform duration-200 ${
            isOpen ? 'rotate-180' : ''
          }`}
          fill="currentColor"
        >
          <path
            fillRule="evenodd"
            d="M5.293 7.293a1 1 0 011.414 0L10 10.586l3.293-3.293a1 1 0 111.414 1.414l-4 4a1 1 0 01-1.414 0l-4-4a1 1 0 010-1.414z"
            clipRule="evenodd"
          />
        </svg>
      </button>

      {/* Popover Dropdown Panel */}
      {isOpen && (
        <div className="absolute right-0 mt-2 w-80 sm:w-96 rounded-2xl border border-slate-800 bg-slate-950/95 p-3 shadow-2xl backdrop-blur-xl z-50 animate-in fade-in zoom-in-95 duration-150">
          {/* Header */}
          <div className="flex items-center justify-between pb-2.5 mb-2.5 border-b border-slate-800/80">
            <div>
              <div className="flex items-center gap-1.5 font-bold text-xs text-white">
                <span>🎨 Visual Palette Switcher</span>
                <span className="rounded bg-sky-500/20 px-1.5 py-0.2 text-[10px] font-mono text-sky-400">
                  {ALL_THEMES.length}
                </span>
              </div>
              <p className="text-[10px] text-slate-400">
                Supports Winnegans themes &amp; Eluvix original
              </p>
            </div>

            <button
              type="button"
              onClick={handleReset}
              className="text-[10px] font-medium text-slate-400 hover:text-sky-400 transition-colors"
              title="Reset to default Eluvix Cyberpunk theme"
            >
              Reset Default
            </button>
          </div>

          {/* Search Box */}
          <div className="relative mb-2.5">
            <input
              type="text"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="Search themes (e.g. OLED, Gruvbox, Light)..."
              className="w-full rounded-lg border border-slate-800 bg-slate-900/90 px-2.5 py-1.5 text-xs text-slate-200 placeholder-slate-500 focus:border-sky-500 focus:outline-none focus:ring-1 focus:ring-sky-500"
            />
            {searchQuery && (
              <button
                type="button"
                onClick={() => setSearchQuery('')}
                className="absolute right-2.5 top-1/2 -translate-y-1/2 text-xs text-slate-400 hover:text-white"
              >
                ✕
              </button>
            )}
          </div>

          {/* Category Filter Tabs */}
          <div className="flex items-center gap-1 overflow-x-auto pb-2 mb-2 scrollbar-none text-[11px]">
            {CATEGORY_TABS.map((tab) => {
              const isSelected = activeCategory === tab.key;
              return (
                <button
                  key={tab.key}
                  type="button"
                  onClick={() => setActiveCategory(tab.key)}
                  className={`px-2 py-0.5 rounded-md whitespace-nowrap font-medium transition-all ${
                    isSelected
                      ? 'bg-sky-500 text-slate-950 font-bold shadow-sm'
                      : 'bg-slate-900/80 text-slate-400 hover:text-slate-200 hover:bg-slate-800'
                  }`}
                >
                  {tab.label}
                </button>
              );
            })}
          </div>

          {/* Theme List */}
          <div className="max-h-72 overflow-y-auto space-y-1.5 pr-1">
            {filteredThemes.length === 0 ? (
              <div className="py-8 text-center text-xs text-slate-500">
                No themes match &quot;{searchQuery}&quot;
              </div>
            ) : (
              filteredThemes.map((theme) => {
                const isSelected = theme.id === currentThemeId;
                return (
                  <button
                    key={theme.id}
                    type="button"
                    onClick={() => handleSelectTheme(theme)}
                    className={`w-full flex items-start gap-2.5 p-2 rounded-xl text-left transition-all border ${
                      isSelected
                        ? 'border-sky-500/80 bg-sky-500/10 shadow-sm'
                        : 'border-transparent hover:border-slate-800 hover:bg-slate-900/60'
                    }`}
                  >
                    {/* Visual Color Triad Swatches */}
                    <div className="flex -space-x-1 shrink-0 mt-0.5">
                      <span
                        className="w-4 h-4 rounded-full border border-black/30 shadow-sm"
                        style={{ backgroundColor: theme.colors.bg }}
                        title={`Background: ${theme.colors.bg}`}
                      />
                      <span
                        className="w-4 h-4 rounded-full border border-black/30 shadow-sm"
                        style={{ backgroundColor: theme.colors.cardBg }}
                        title={`Surface: ${theme.colors.cardBg}`}
                      />
                      <span
                        className="w-4 h-4 rounded-full border border-black/30 shadow-sm"
                        style={{ backgroundColor: theme.colors.accent }}
                        title={`Accent: ${theme.colors.accent}`}
                      />
                    </div>

                    {/* Theme Info */}
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center justify-between gap-1">
                        <span className={`text-xs font-semibold truncate ${
                          isSelected ? 'text-sky-300' : 'text-slate-200'
                        }`}>
                          {theme.name}
                        </span>
                        
                        <span className="shrink-0 text-[9px] uppercase px-1.5 py-0.5 rounded font-mono font-semibold bg-slate-800/80 text-slate-400">
                          {theme.isDark ? 'Dark' : 'Light'}
                        </span>
                      </div>
                      <p className="text-[10px] text-slate-400 line-clamp-1 mt-0.5">
                        {theme.description}
                      </p>
                    </div>

                    {/* Active Checkmark */}
                    {isSelected && (
                      <span className="text-sky-400 text-xs shrink-0 self-center">
                        ✓
                      </span>
                    )}
                  </button>
                );
              })
            )}
          </div>
        </div>
      )}
    </div>
  );
}
