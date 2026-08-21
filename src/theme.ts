// Theme choice: dark/light, plus an accent color.
//
// The wallet is dark by identity and stays dark unless the user says otherwise.
// An explicit light choice stamps data-theme="light" on <html>; nothing else
// can change the palette, least of all the OS.
//
// The accent is the one color the user gets to make their own — the balance glow,
// the primary button, the active tab, every highlight derive from it. It is a
// personalization, not a rebrand: teal is the default and the identity.

// "system" is an explicit, opt-in choice — the wallet still never follows the OS
// on its own (dark is the default identity). Only a user who picks "system" gets
// OS-tracking, and then it is honest: switching the OS palette updates the app.
export type Theme = "dark" | "light" | "system";

export type Accent = "teal" | "violet" | "amber" | "rose" | "ice";

/// The accents, with everything the palette needs derived per color. `ink` is the
/// text that sits ON the accent (buttons, active tab) — always the darkest tone of
/// that hue so it reads at AA on the bright fill.
export const ACCENTS: Record<Accent, { label: string; base: string; hover: string; ink: string }> = {
  teal: { label: "Teal", base: "#17d6be", hover: "#3ee6d1", ink: "#04211c" },
  violet: { label: "Violet", base: "#9d8bff", hover: "#b4a6ff", ink: "#140a2e" },
  amber: { label: "Amber", base: "#ffb020", hover: "#ffc44d", ink: "#2e1c00" },
  rose: { label: "Rose", base: "#ff6f9c", hover: "#ff8fb3", ink: "#2e0a17" },
  ice: { label: "Ice", base: "#4db8ff", hover: "#7accff", ink: "#04182e" },
};

const KEY = "theme";
const ACCENT_KEY = "accent";

export function currentTheme(): Theme {
  // Dark unless the user explicitly chose otherwise. Never derived from the OS on
  // its own — only if the user deliberately selected "system".
  const v = localStorage.getItem(KEY);
  return v === "light" || v === "system" ? v : "dark";
}

/// The concrete palette to paint right now: "system" resolves against the OS,
/// everything else is literal.
function resolveTheme(t: Theme): "dark" | "light" {
  if (t !== "system") return t;
  try {
    return window.matchMedia?.("(prefers-color-scheme: light)").matches ? "light" : "dark";
  } catch {
    return "dark";
  }
}

export function currentAccent(): Accent {
  const a = localStorage.getItem(ACCENT_KEY);
  return a && a in ACCENTS ? (a as Accent) : "teal";
}

export function applyStoredTheme(): void {
  apply(currentTheme());
  applyAccent(currentAccent());
  installSystemThemeWatcher();
}

export function setTheme(t: Theme): void {
  if (t === "dark") localStorage.removeItem(KEY);
  else localStorage.setItem(KEY, t);
  apply(t);
}

/// When (and only when) the user chose "system", track OS palette changes live so
/// the app follows the OS the moment it flips. Installed once; a no-op otherwise.
let watcherInstalled = false;
function installSystemThemeWatcher(): void {
  if (watcherInstalled) return;
  watcherInstalled = true;
  try {
    const mq = window.matchMedia("(prefers-color-scheme: light)");
    mq.addEventListener?.("change", () => {
      if (currentTheme() === "system") apply("system");
    });
  } catch {
    /* engines without matchMedia simply never fire — dark stays */
  }
}

export function setAccent(a: Accent): void {
  if (a === "teal") localStorage.removeItem(ACCENT_KEY);
  else localStorage.setItem(ACCENT_KEY, a);
  applyAccent(a);
}

function apply(t: Theme): void {
  const root = document.documentElement;
  // Resolve "system" to a concrete palette; :root defaults to dark, so only light
  // needs the attribute.
  if (resolveTheme(t) === "light") root.setAttribute("data-theme", "light");
  else root.removeAttribute("data-theme");
}

/// Push the chosen accent into the CSS custom properties every highlight reads.
/// The soft/glow tints are the base at low alpha, derived here so a new accent
/// needs only its three hex values above.
///
/// Teal is the identity and the CSS default — including a darker, contrast-tuned
/// teal for light mode. For teal we therefore CLEAR the inline overrides and let
/// the stylesheet decide, rather than force one teal across both themes. Only a
/// deliberately chosen non-default accent overrides the stylesheet.
const ACCENT_PROPS = ["--ember", "--ember-hover", "--ember-ink", "--ember-soft", "--glow-1", "--glow-2"];
function applyAccent(a: Accent): void {
  const s = document.documentElement.style;
  if (a === "teal") {
    for (const p of ACCENT_PROPS) s.removeProperty(p);
    return;
  }
  const { base, hover, ink } = ACCENTS[a];
  s.setProperty("--ember", base);
  s.setProperty("--ember-hover", hover);
  s.setProperty("--ember-ink", ink);
  s.setProperty("--ember-soft", hexA(base, 0.12));
  s.setProperty("--glow-1", hexA(base, 0.08));
  s.setProperty("--glow-2", hexA(base, 0.05));
}

/// "#rrggbb" + alpha -> "rgba(r,g,b,a)". Kept tiny and dependency-free.
function hexA(hex: string, a: number): string {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${a})`;
}
