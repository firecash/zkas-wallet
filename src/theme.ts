// Theme choice: follow the OS, or override it.
//
// The wallet is dark by identity and stays dark unless the user says otherwise.
// An explicit light choice stamps data-theme="light" on <html>; nothing else
// can change the palette, least of all the OS.

export type Theme = "dark" | "light";

const KEY = "theme";

export function currentTheme(): Theme {
  // Dark unless the user explicitly chose light. Deliberately NOT derived from
  // the OS: auto-switching flipped the palette while the window stayed dark and
  // made the wallet's own title invisible.
  return localStorage.getItem(KEY) === "light" ? "light" : "dark";
}

export function applyStoredTheme(): void {
  apply(currentTheme());
}

export function setTheme(t: Theme): void {
  if (t === "dark") localStorage.removeItem(KEY);
  else localStorage.setItem(KEY, t);
  apply(t);
}

function apply(t: Theme): void {
  const root = document.documentElement;
  if (t === "dark") root.removeAttribute("data-theme"); // :root defaults to dark
  else root.setAttribute("data-theme", "light");
}
