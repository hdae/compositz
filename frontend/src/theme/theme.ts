// Theme primitives (no React) — shared by the early boot in main.tsx and the
// ThemeProvider. Dark mode is a `.dark` class on <html> (index.css keys its dark
// tokens off `&:is(.dark *)`), the choice persisted in localStorage, default
// "system" (follows the OS). ADR-019.

export type Theme = "light" | "dark" | "system";

export const THEME_STORAGE_KEY = "compositz-theme";

/** Read the saved theme, defaulting to "system" for anything unset or unrecognized. */
export function readStoredTheme(): Theme {
  try {
    const saved = localStorage.getItem(THEME_STORAGE_KEY);
    if (saved === "light" || saved === "dark" || saved === "system") return saved;
  } catch {
    // localStorage can throw in locked-down contexts — fall through to the default.
  }
  return "system";
}

export function systemPrefersDark(): boolean {
  return window.matchMedia("(prefers-color-scheme: dark)").matches;
}

/** Whether a chosen theme resolves to dark right now (resolving "system" against the OS). */
export function resolvesToDark(theme: Theme): boolean {
  return theme === "dark" || (theme === "system" && systemPrefersDark());
}

/** Apply a theme to the document by toggling the `.dark` class on <html>. */
export function applyThemeClass(theme: Theme): void {
  document.documentElement.classList.toggle("dark", resolvesToDark(theme));
}
