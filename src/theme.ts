// Theme choice: follow the OS, or override it.
//
// The wallet is dark by identity, but people use it in daylight and at night on
// different machines. `system` is the default and simply lets the CSS media
// query decide; an explicit choice stamps data-theme on <html>, which the
// stylesheet gives precedence over the media query.

export type Theme = "system" | "dark" | "light";

const KEY = "theme";

export function currentTheme(): Theme {
  const t = localStorage.getItem(KEY);
  return t === "dark" || t === "light" ? t : "system";
}

export function applyStoredTheme(): void {
  apply(currentTheme());
}

export function setTheme(t: Theme): void {
  if (t === "system") localStorage.removeItem(KEY);
  else localStorage.setItem(KEY, t);
  apply(t);
}

function apply(t: Theme): void {
  const root = document.documentElement;
  if (t === "system") root.removeAttribute("data-theme");
  else root.setAttribute("data-theme", t);
}
