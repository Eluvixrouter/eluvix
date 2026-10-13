export interface ThemeColorSet {
  bg: string;
  text: string;
  textMuted: string;
  cardBg: string;
  border: string;
  accent: string;
  accentHover: string;
  ring: string;
}

export type ThemeCategory = 
  | 'all'
  | 'original'
  | 'dark-ambient'
  | 'oled'
  | 'light'
  | 'catppuccin'
  | 'gruvbox'
  | 'solarized'
  | 'dark-red'
  | 'fun';

export interface EluvixTheme {
  id: string;
  name: string;
  description: string;
  category: ThemeCategory;
  isDark: boolean;
  colors: ThemeColorSet;
}

export const ALL_THEMES: EluvixTheme[] = [
  // 1. Original Sovereign Cyberpunk (Eluvix Original Default)
  {
    id: 'eluvix-cyberpunk',
    name: 'Eluvix Cyberpunk (Original)',
    description: 'The canonical Eluvix palette: deep obsidian slate with electric cyan routing nexus and ultraviolet accents.',
    category: 'original',
    isDark: true,
    colors: {
      bg: '#020617',
      text: '#f8fafc',
      textMuted: '#94a3b8',
      cardBg: '#0f172a',
      border: '#1e293b',
      accent: '#38bdf8',
      accentHover: '#0284c7',
      ring: '#38bdf8',
    },
  },

  // 2. Daylight White
  {
    id: 'daylight-pure',
    name: 'Daylight White',
    description: 'Crisp, high-contrast pure white (#FFFFFF) with solid black font for bright sunlight and daytime reading.',
    category: 'light',
    isDark: false,
    colors: {
      bg: '#ffffff',
      text: '#000000',
      textMuted: '#4b5563',
      cardBg: '#f9fafb',
      border: '#e5e7eb',
      accent: '#059669',
      accentHover: '#047857',
      ring: '#10b981',
    },
  },

  // 3. Book Parchment
  {
    id: 'warm-parchment',
    name: 'Book Parchment',
    description: 'Subtle warm cream and antique paper tones that eliminate eye fatigue for marathon reading.',
    category: 'light',
    isDark: false,
    colors: {
      bg: '#fbf7ee',
      text: '#2c2416',
      textMuted: '#786851',
      cardBg: '#f4ede0',
      border: '#e2d5be',
      accent: '#b45309',
      accentHover: '#92400e',
      ring: '#d97706',
    },
  },

  // 4. Obsidian OLED
  {
    id: 'obsidian-oled',
    name: 'Obsidian OLED',
    description: 'True pitch-black (#000000) pixels with stark white (#FFFFFF) text for zero power emission on OLED displays.',
    category: 'oled',
    isDark: true,
    colors: {
      bg: '#000000',
      text: '#ffffff',
      textMuted: '#9ca3af',
      cardBg: '#0a0a0a',
      border: '#262626',
      accent: '#10b981',
      accentHover: '#34d399',
      ring: '#059669',
    },
  },

  // 5. Crimson Midnight
  {
    id: 'dark-crimson',
    name: 'Crimson Midnight',
    description: 'Deep nocturnal maroon and soft burgundy red to preserve scotopic night vision and circadian rhythm.',
    category: 'dark-red',
    isDark: true,
    colors: {
      bg: '#140507',
      text: '#fecdd3',
      textMuted: '#fda4af',
      cardBg: '#220a0d',
      border: '#4c1117',
      accent: '#e11d48',
      accentHover: '#f43f5e',
      ring: '#fb7185',
    },
  },

  // 6. Blood Ember
  {
    id: 'dark-ember',
    name: 'Blood Ember',
    description: 'Smoldering dark embers and ruby tones engineered for dim bedrooms and late-night research.',
    category: 'dark-red',
    isDark: true,
    colors: {
      bg: '#180806',
      text: '#fed7aa',
      textMuted: '#fb923c',
      cardBg: '#270e0a',
      border: '#541c14',
      accent: '#ea580c',
      accentHover: '#f97316',
      ring: '#fb923c',
    },
  },

  // 7. Burgundy Velvet
  {
    id: 'dark-burgundy',
    name: 'Burgundy Velvet',
    description: 'Rich vintage port-wine red and aged rose gold highlights for gentle, atmospheric night reading.',
    category: 'dark-red',
    isDark: true,
    colors: {
      bg: '#190a12',
      text: '#fce7f3',
      textMuted: '#f472b6',
      cardBg: '#28101e',
      border: '#581c3f',
      accent: '#db2777',
      accentHover: '#ec4899',
      ring: '#f472b6',
    },
  },

  // 8. Slate Midnight
  {
    id: 'slate-midnight',
    name: 'Slate Midnight',
    description: 'The standard scholarly palette: deep indigo-slate with radiant emerald annotations.',
    category: 'dark-ambient',
    isDark: true,
    colors: {
      bg: '#020617',
      text: '#f1f5f9',
      textMuted: '#94a3b8',
      cardBg: '#0f172a',
      border: '#1e293b',
      accent: '#10b981',
      accentHover: '#34d399',
      ring: '#059669',
    },
  },

  // 9. Cyberpunk Neon
  {
    id: 'neon-cyberpunk',
    name: 'Cyberpunk Neon',
    description: 'Electrifying dark synthwave with hot neon cyan, electric purple, and high-energy contrasts.',
    category: 'fun',
    isDark: true,
    colors: {
      bg: '#0b0813',
      text: '#f5f3ff',
      textMuted: '#c4b5fd',
      cardBg: '#161026',
      border: '#3b2d5a',
      accent: '#06b6d4',
      accentHover: '#22d3ee',
      ring: '#a855f7',
    },
  },

  // 10. Emerald Forest
  {
    id: 'forest-glade',
    name: 'Emerald Forest',
    description: 'Deep pine woods and mossy greens inspired by fertile riverbanks and sovereign enclaves.',
    category: 'dark-ambient',
    isDark: true,
    colors: {
      bg: '#04130c',
      text: '#ecfdf5',
      textMuted: '#6ee7b7',
      cardBg: '#0a2318',
      border: '#134e35',
      accent: '#10b981',
      accentHover: '#34d399',
      ring: '#059669',
    },
  },

  // 11. Solarized Dark
  {
    id: 'solarized-dark',
    name: 'Solarized Dark',
    description: 'Ethan Schoonover’s canonical Solarized Dark: precise LAB color space palette with base03 (#002b36).',
    category: 'solarized',
    isDark: true,
    colors: {
      bg: '#002b36',
      text: '#839496',
      textMuted: '#586e75',
      cardBg: '#073642',
      border: '#073642',
      accent: '#2aa198',
      accentHover: '#268bd2',
      ring: '#b58900',
    },
  },

  // 12. Solarized Light
  {
    id: 'solarized-light',
    name: 'Solarized Light',
    description: 'Ethan Schoonover’s canonical Solarized Light: warm base3 (#fdf6e3) background with base00 (#657b83) text.',
    category: 'solarized',
    isDark: false,
    colors: {
      bg: '#fdf6e3',
      text: '#657b83',
      textMuted: '#93a1a1',
      cardBg: '#eee8d5',
      border: '#eee8d5',
      accent: '#268bd2',
      accentHover: '#2aa198',
      ring: '#b58900',
    },
  },

  // 13. Dublin Amber
  {
    id: 'solarized-amber',
    name: 'Dublin Amber',
    description: 'Muted warm solarized dark background with incandescent honey and amber highlights.',
    category: 'dark-ambient',
    isDark: true,
    colors: {
      bg: '#14120e',
      text: '#fef3c7',
      textMuted: '#fcd34d',
      cardBg: '#211d17',
      border: '#453a29',
      accent: '#f59e0b',
      accentHover: '#fbbf24',
      ring: '#d97706',
    },
  },

  // 14. Gruvbox Dark
  {
    id: 'gruvbox-dark',
    name: 'Gruvbox Dark',
    description: 'Retro groove dark palette by Pavel Pertsev: warm dark background (#282828) with high-contrast light fg (#ebdbb2).',
    category: 'gruvbox',
    isDark: true,
    colors: {
      bg: '#282828',
      text: '#ebdbb2',
      textMuted: '#a89984',
      cardBg: '#3c3836',
      border: '#504945',
      accent: '#fabd2f',
      accentHover: '#fe8019',
      ring: '#d79921',
    },
  },

  // 15. Gruvbox Light
  {
    id: 'gruvbox-light',
    name: 'Gruvbox Light',
    description: 'Retro groove light palette by Pavel Pertsev: soft light parchment background (#fbf1c7) with dark0 (#282828) text.',
    category: 'gruvbox',
    isDark: false,
    colors: {
      bg: '#fbf1c7',
      text: '#3c3836',
      textMuted: '#7c6f64',
      cardBg: '#ebdbb2',
      border: '#d5c4a1',
      accent: '#b57614',
      accentHover: '#af3a03',
      ring: '#b57614',
    },
  },

  // 16. Catppuccin Latte
  {
    id: 'catppuccin-latte',
    name: 'Catppuccin Latte',
    description: 'Catppuccin’s light flavor: warm base (#eff1f5) background, text (#4c4f69), and lavender (#7287fd) accents.',
    category: 'catppuccin',
    isDark: false,
    colors: {
      bg: '#eff1f5',
      text: '#4c4f69',
      textMuted: '#6c6f85',
      cardBg: '#e6e9ef',
      border: '#ccd0da',
      accent: '#7287fd',
      accentHover: '#1e66f5',
      ring: '#8839ef',
    },
  },

  // 17. Catppuccin Frappé
  {
    id: 'catppuccin-frappe',
    name: 'Catppuccin Frappé',
    description: 'Catppuccin’s balanced dark flavor: muted base (#303446) background, text (#c6d0f5), and mauve (#ca9ee6) accents.',
    category: 'catppuccin',
    isDark: true,
    colors: {
      bg: '#303446',
      text: '#c6d0f5',
      textMuted: '#a5adce',
      cardBg: '#292c3c',
      border: '#414559',
      accent: '#ca9ee6',
      accentHover: '#8caaee',
      ring: '#babbf1',
    },
  },

  // 18. Catppuccin Macchiato
  {
    id: 'catppuccin-macchiato',
    name: 'Catppuccin Macchiato',
    description: 'Catppuccin’s medium dark flavor: rich base (#24273a) background, text (#cad3f5), and lavender (#b7bdf8) accents.',
    category: 'catppuccin',
    isDark: true,
    colors: {
      bg: '#24273a',
      text: '#cad3f5',
      textMuted: '#a5adcb',
      cardBg: '#1e2030',
      border: '#363a4f',
      accent: '#c6a0f6',
      accentHover: '#8aadf4',
      ring: '#b7bdf8',
    },
  },

  // 19. Catppuccin Mocha
  {
    id: 'catppuccin-mocha',
    name: 'Catppuccin Mocha',
    description: 'Catppuccin’s deep dark flavor: base (#1e1e2e) background, crisp text (#cdd6f4), and mauve (#cba6f7) accents.',
    category: 'catppuccin',
    isDark: true,
    colors: {
      bg: '#1e1e2e',
      text: '#cdd6f4',
      textMuted: '#a6adc8',
      cardBg: '#181825',
      border: '#313244',
      accent: '#cba6f7',
      accentHover: '#89b4fa',
      ring: '#b4befe',
    },
  },

  // 20. Obsidian Crimson
  {
    id: 'obsidian-crimson',
    name: 'Obsidian Crimson',
    description: 'Pure pitch-black OLED background (#000000) with deep blood-red foreground (#9A2F2F) for darkroom night reading.',
    category: 'dark-red',
    isDark: true,
    colors: {
      bg: '#000000',
      text: '#9a2f2f',
      textMuted: '#6f2222',
      cardBg: '#0a0202',
      border: '#2a0c0c',
      accent: '#9a2f2f',
      accentHover: '#ba3939',
      ring: '#9a2f2f',
    },
  },
];

export const DEFAULT_THEME_ID = 'eluvix-cyberpunk';

export function getThemeById(themeId: string): EluvixTheme {
  const found = ALL_THEMES.find((t) => t.id === themeId);
  return found || ALL_THEMES[0];
}

export function applyTheme(theme: EluvixTheme) {
  if (typeof document === 'undefined') return;

  const root = document.documentElement;
  const { colors, isDark } = theme;

  root.style.setProperty('--bg', colors.bg);
  root.style.setProperty('--text', colors.text);
  root.style.setProperty('--text-muted', colors.textMuted);
  root.style.setProperty('--card-bg', colors.cardBg);
  root.style.setProperty('--border', colors.border);
  root.style.setProperty('--accent', colors.accent);
  root.style.setProperty('--accent-hover', colors.accentHover);
  root.style.setProperty('--ring', colors.ring);

  if (isDark) {
    root.classList.add('dark');
    root.classList.remove('light');
  } else {
    root.classList.add('light');
    root.classList.remove('dark');
  }

  root.setAttribute('data-theme', theme.id);
}

export const THEME_INIT_SCRIPT = `
(function() {
  try {
    var id = localStorage.getItem('eluvix-theme');
    if (!id || id === 'eluvix-cyberpunk') return;
    var themes = ${JSON.stringify(
      ALL_THEMES.reduce((acc, t) => {
        acc[t.id] = { colors: t.colors, isDark: t.isDark };
        return acc;
      }, {} as Record<string, { colors: ThemeColorSet; isDark: boolean }>)
    )};
    var t = themes[id];
    if (t) {
      var root = document.documentElement;
      var c = t.colors;
      root.style.setProperty('--bg', c.bg);
      root.style.setProperty('--text', c.text);
      root.style.setProperty('--text-muted', c.textMuted);
      root.style.setProperty('--card-bg', c.cardBg);
      root.style.setProperty('--border', c.border);
      root.style.setProperty('--accent', c.accent);
      root.style.setProperty('--accent-hover', c.accentHover);
      root.style.setProperty('--ring', c.ring);
      if (t.isDark) {
        root.classList.add('dark');
        root.classList.remove('light');
      } else {
        root.classList.add('light');
        root.classList.remove('dark');
      }
      root.setAttribute('data-theme', id);
    }
  } catch (e) {}
})();
`;

