import { THEMES, themeById, themeToCssProperties, themeToXterm } from '../theme/tokens.js';

export type ThemeId = keyof typeof THEMES;

const query = typeof window !== 'undefined' && typeof window.matchMedia === 'function'
  ? window.matchMedia('(prefers-color-scheme: dark)')
  : null;

export function systemThemeId(): ThemeId {
  return query?.matches ? 'dark' : 'light';
}

export function resolveThemeId(themeSource: 'system' | 'light' | 'dark'): ThemeId {
  if (themeSource === 'system') return systemThemeId();
  return themeSource in THEMES ? themeSource : 'dark';
}

/** Follows the OS colour scheme. Returns an unsubscribe function. */
export function watchSystemTheme(onChange: () => void): () => void {
  if (!query) return () => {};
  query.addEventListener('change', onChange);
  return () => query.removeEventListener('change', onChange);
}

/**
 * Publishes the tokens as CSS custom properties.
 *
 * The values come from the same object the Node tests measure contrast against,
 * so what is asserted in CI is what the browser paints.
 */
export function applyTheme(themeId: ThemeId): void {
  const theme = themeById(themeId);
  const root = document.documentElement;
  for (const [name, value] of Object.entries(themeToCssProperties(theme))) {
    root.style.setProperty(name, value);
  }
  root.dataset.theme = themeId;
}

export function xtermTheme(themeId: ThemeId) {
  return themeToXterm(themeById(themeId));
}
