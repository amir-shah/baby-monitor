/**
 * Theme state.
 *
 * Three settings: `dark`, `light`, `system`. The default when nothing is
 * stored is **dark** — this dashboard's primary use is at 3am in an unlit
 * bedroom, and a light flash there wakes the room. index.html hardcodes
 * `data-theme="dark"` on `<html>` and runs a tiny bootstrap script so the very
 * first paint is already correct; this module just keeps it in sync
 * afterwards.
 *
 * `system` is represented by the *absence* of the attribute, which lets the
 * `@media (prefers-color-scheme: dark)` block in tokens.css take over.
 */

import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';

export type ThemeSetting = 'dark' | 'light' | 'system';
export type ResolvedTheme = 'dark' | 'light';

/** Keep in sync with the bootstrap script in index.html. */
export const THEME_STORAGE_KEY = 'babymon.theme';

const DEFAULT_SETTING: ThemeSetting = 'dark';

interface ThemeContextValue {
  /** What the user chose. */
  setting: ThemeSetting;
  /** What that resolves to right now. */
  theme: ResolvedTheme;
  setSetting: (setting: ThemeSetting) => void;
  /** Cycle dark -> light -> system -> dark. */
  cycle: () => void;
  /** Flip between dark and light, leaving `system` behind. */
  toggle: () => void;
}

const ThemeContext = createContext<ThemeContextValue | null>(null);

function readStored(): ThemeSetting {
  if (typeof localStorage === 'undefined') return DEFAULT_SETTING;
  try {
    const stored = localStorage.getItem(THEME_STORAGE_KEY);
    if (stored === 'dark' || stored === 'light' || stored === 'system') return stored;
  } catch {
    /* private mode, storage disabled */
  }
  return DEFAULT_SETTING;
}

function prefersDark(): boolean {
  if (typeof matchMedia === 'undefined') return true;
  return matchMedia('(prefers-color-scheme: dark)').matches;
}

function resolve(setting: ThemeSetting, systemDark: boolean): ResolvedTheme {
  if (setting === 'system') return systemDark ? 'dark' : 'light';
  return setting;
}

function applyToDocument(setting: ThemeSetting): void {
  const root = document.documentElement;
  if (setting === 'system') {
    root.removeAttribute('data-theme');
  } else {
    root.setAttribute('data-theme', setting);
  }
}

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [setting, setSettingState] = useState<ThemeSetting>(readStored);
  const [systemDark, setSystemDark] = useState<boolean>(prefersDark);

  // Track the OS preference so `system` stays live rather than sampling once.
  useEffect(() => {
    if (typeof matchMedia === 'undefined') return;
    const query = matchMedia('(prefers-color-scheme: dark)');
    const onChange = (event: MediaQueryListEvent) => setSystemDark(event.matches);
    query.addEventListener('change', onChange);
    return () => query.removeEventListener('change', onChange);
  }, []);

  useEffect(() => {
    applyToDocument(setting);
  }, [setting]);

  // Another tab changed the preference.
  useEffect(() => {
    const onStorage = (event: StorageEvent) => {
      if (event.key !== THEME_STORAGE_KEY) return;
      setSettingState(readStored());
    };
    window.addEventListener('storage', onStorage);
    return () => window.removeEventListener('storage', onStorage);
  }, []);

  const setSetting = useCallback((next: ThemeSetting) => {
    setSettingState(next);
    try {
      localStorage.setItem(THEME_STORAGE_KEY, next);
    } catch {
      /* not fatal: the theme still applies for this session */
    }
  }, []);

  const theme = resolve(setting, systemDark);

  const value = useMemo<ThemeContextValue>(
    () => ({
      setting,
      theme,
      setSetting,
      toggle: () => setSetting(theme === 'dark' ? 'light' : 'dark'),
      cycle: () =>
        setSetting(setting === 'dark' ? 'light' : setting === 'light' ? 'system' : 'dark'),
    }),
    [setting, theme, setSetting],
  );

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function useTheme(): ThemeContextValue {
  const context = useContext(ThemeContext);
  if (!context) throw new Error('useTheme must be used inside <ThemeProvider>');
  return context;
}
