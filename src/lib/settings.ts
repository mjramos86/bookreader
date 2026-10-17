import { useCallback, useEffect, useState } from 'react';

export type ThemeName = 'light' | 'sepia' | 'green' | 'dark' | 'black';

export interface Theme {
  name: ThemeName;
  label: string;
  bg: string;
  fg: string;
  muted: string;
  link: string;
  panel: string;
  border: string;
  accent: string;
  dark: boolean;
}

export const THEMES: Theme[] = [
  { name: 'light', label: 'White', bg: '#ffffff', fg: '#1d1d1f', muted: '#6b6b70', link: '#0b5cad', panel: '#f6f6f7', border: '#dcdce0', accent: '#b45f06', dark: false },
  { name: 'sepia', label: 'Sepia', bg: '#f4ecd8', fg: '#433422', muted: '#8a7a62', link: '#8a4b08', panel: '#ece2c8', border: '#d8caa8', accent: '#9a4f05', dark: false },
  { name: 'green', label: 'Green', bg: '#d8e8d0', fg: '#233523', muted: '#5f785c', link: '#1b5e20', panel: '#cadcc1', border: '#b4cba9', accent: '#2e6b32', dark: false },
  { name: 'dark', label: 'Dark', bg: '#1f2023', fg: '#d6d6d4', muted: '#8d8d92', link: '#7db4ee', panel: '#2a2b2f', border: '#3a3b40', accent: '#e8a33d', dark: true },
  { name: 'black', label: 'Black', bg: '#000000', fg: '#bdbdbd', muted: '#777', link: '#6aa8e8', panel: '#121212', border: '#262626', accent: '#e8a33d', dark: true },
];

export function themeByName(name: ThemeName): Theme {
  return THEMES.find((t) => t.name === name) ?? THEMES[0];
}

export interface Settings {
  theme: ThemeName;
  fontFamily: string;
  /** Base font size in px. */
  fontSize: number;
  lineHeight: number;
  margin: 'narrow' | 'medium' | 'wide';
  align: 'left' | 'justify';
  hyphenate: boolean;
  layout: 'paged' | 'scroll';
  columns: 'auto' | 1 | 2;
  /** Use the book's own fonts instead of the selected one. */
  publisherFonts: boolean;
  /** 40..100, simulated by dimming the page. */
  brightness: number;
}

export const FONT_SIZE_MIN = 13;
export const FONT_SIZE_MAX = 36;

export const DEFAULT_SETTINGS: Settings = {
  theme: 'light',
  fontFamily: 'literata',
  fontSize: 19,
  lineHeight: 1.55,
  margin: 'medium',
  align: 'left',
  hyphenate: true,
  layout: 'paged',
  columns: 'auto',
  publisherFonts: false,
  brightness: 100,
};

const KEY = 'bookreader.settings.v1';

function systemDefault(): Settings {
  const dark = typeof matchMedia === 'function' && matchMedia('(prefers-color-scheme: dark)').matches;
  return { ...DEFAULT_SETTINGS, theme: dark ? 'dark' : 'light' };
}

export function loadSettings(): Settings {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) return { ...systemDefault(), ...JSON.parse(raw) };
  } catch {
    /* ignore corrupt or unavailable storage */
  }
  return systemDefault();
}

function saveSettings(s: Settings): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(s));
  } catch {
    /* ignore */
  }
}

/** Settings shared by the library and reader; persisted to localStorage. */
export function useSettings(): [Settings, (patch: Partial<Settings>) => void] {
  const [settings, setSettings] = useState<Settings>(loadSettings);
  const update = useCallback((patch: Partial<Settings>) => {
    setSettings((prev) => {
      const next = { ...prev, ...patch };
      saveSettings(next);
      return next;
    });
  }, []);
  useEffect(() => {
    const t = themeByName(settings.theme);
    document.documentElement.dataset.theme = t.name;
    document.documentElement.style.colorScheme = t.dark ? 'dark' : 'light';
    const vars: Record<string, string> = {
      '--bg': t.bg,
      '--fg': t.fg,
      '--muted': t.muted,
      '--link': t.link,
      '--panel': t.panel,
      '--border': t.border,
      '--accent': t.accent,
    };
    for (const [k, v] of Object.entries(vars)) document.documentElement.style.setProperty(k, v);
    document.querySelector('meta[name="theme-color"]')?.setAttribute('content', t.bg);
  }, [settings.theme]);
  return [settings, update];
}
