import { readLocal, removeLocal, writeLocal } from "./lib/safestore";

// Theme choice: dark/light, plus an accent color.
//
// The wallet is dark by identity and stays dark unless the user says otherwise.
// An explicit light choice stamps data-theme="light" on <html>; nothing else
// can change the palette, least of all the OS.
//
// The accent is the one color the user gets to make their own — the balance glow,
// the primary button, the active tab, every highlight derive from it. It is a
// personalization, not a rebrand: green is the default and the identity.

// "system" is an explicit, opt-in choice — the wallet still never follows the OS
// on its own (dark is the default identity). Only a user who picks "system" gets
// OS-tracking, and then it is honest: switching the OS palette updates the app.
export type Theme = "dark" | "light" | "system";

export type Accent = "green" | "teal" | "violet" | "amber" | "rose" | "ice";

/// The identity accent: the one the stylesheet already paints, in BOTH themes.
///
/// Everything that used to test for the literal "teal" means "is this the default?",
/// so it reads this instead. Getting that wrong is not cosmetic: the default accent
/// is the one case that must write NO inline override, because light mode ships its
/// own contrast-tuned shade of it (#0b7a46 -- the dark-mode green measures 1.70:1 on
/// white and cannot be read). An inline override would clobber that.
export const DEFAULT_ACCENT: Accent = "green";

/// The accents, with everything the palette needs derived per color. `ink` is the
/// text that sits ON the accent (buttons, active tab) — always the darkest tone of
/// that hue so it reads at AA on the bright fill.
export const ACCENTS: Record<Accent, { label: string; base: string; hover: string; ink: string }> = {
  green: { label: "Green", base: "#19e37d", hover: "#4bff9d", ink: "#032013" },
  teal: { label: "Teal", base: "#17d6be", hover: "#3ee6d1", ink: "#04211c" },
  violet: { label: "Violet", base: "#9d8bff", hover: "#b4a6ff", ink: "#140a2e" },
  amber: { label: "Amber", base: "#ffb020", hover: "#ffc44d", ink: "#2e1c00" },
  rose: { label: "Rose", base: "#ff6f9c", hover: "#ff8fb3", ink: "#2e0a17" },
  ice: { label: "Ice", base: "#4db8ff", hover: "#7accff", ink: "#04182e" },
};

const KEY = "theme";
const ACCENT_KEY = "accent";
/// One-time, for the green rebrand.
///
/// An accent stored before the rebrand was chosen against the OLD teal identity — it is
/// a preference for "not teal", not a vote against green, and the person has never seen
/// green. Leaving it in place means the rebrand is invisible to every existing user:
/// the ground changes but every highlight, button, tab and glow keeps the old colour,
/// which reads as "nothing happened" (it is how this was first reported).
///
/// So the stored accent is cleared ONCE and everyone lands on the new identity. Anything
/// chosen AFTER this marker exists is a deliberate choice made with green in front of
/// them, and is kept for good.
const ACCENT_REBRAND_KEY = "accent.rebrand.green";

function migrateAccentForRebrand(): void {
  try {
    if (readLocal(ACCENT_REBRAND_KEY)) return;
    writeLocal(ACCENT_REBRAND_KEY, "1");
    removeLocal(ACCENT_KEY);
  } catch {
    /* storage blocked: there is no stored accent to migrate, and nothing to remember */
  }
}

export function currentTheme(): Theme {
  // Dark unless the user explicitly chose otherwise. Never derived from the OS on
  // its own — only if the user deliberately selected "system".
  // Guarded: with site storage blocked the accessor throws, and this runs on the
  // boot path before React mounts — the identity (dark) is the right answer.
  let v: string | null = null;
  try {
    v = readLocal(KEY);
  } catch {
    /* storage unavailable — dark */
  }
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
  let a: string | null = null;
  try {
    a = readLocal(ACCENT_KEY);
  } catch {
    /* storage unavailable — the identity accent */
  }
  // Unset means the user never opened the picker, so they follow the identity and
  // get green. An explicit "teal" is a choice and is kept.
  return a && a in ACCENTS ? (a as Accent) : DEFAULT_ACCENT;
}

export function applyStoredTheme(): void {
  // Before anything reads the stored accent.
  migrateAccentForRebrand();
  apply(currentTheme());
  applyAccent(currentAccent());
  installSystemThemeWatcher();
}

export function setTheme(t: Theme): void {
  // Apply FIRST, and never let the storage write stop it.
  //
  // These are raw accessors in a click handler, and on a browser with site data blocked a raw
  // `setItem` THROWS: the exception escaped the handler and `apply` below was never reached, so
  // tapping a theme did nothing at all — not even visually. `switchWallet` records the same
  // failure in almost the same words: "a raw setItem threw out of the click handler that called
  // this, so on a browser with storage blocked tapping another wallet did nothing at all".
  //
  // Through safestore in BOTH directions (see `currentTheme`), so the choice at least holds for
  // this session when it cannot be persisted, and the reader sees what the writer stored —
  // mixing a safestore write with a raw read is the mistake that rule exists to prevent.
  apply(t);
  if (t === "dark") removeLocal(KEY);
  else writeLocal(KEY, t);
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
  // Same as setTheme: paint first, persist after, and never throw out of the handler.
  applyAccent(a);
  if (a === DEFAULT_ACCENT) removeLocal(ACCENT_KEY);
  else writeLocal(ACCENT_KEY, a);
}

/// Browser/OS chrome colors per palette. `theme-color` paints the tab strip and
/// the PWA title bar; the Apple status-bar style is read at launch, so the value
/// written here takes effect the next time the home-screen app opens. Both were
/// static (dark) in index.html and never followed a light choice, leaving dark
/// chrome over a white page.
const CHROME = {
  dark: { color: "#050806", statusBar: "black-translucent" },
  light: { color: "#f5f8f6", statusBar: "default" },
} as const;

function apply(t: Theme): void {
  const root = document.documentElement;
  // Resolve "system" to a concrete palette; :root defaults to dark, so only light
  // needs the attribute.
  const resolved = resolveTheme(t);
  if (resolved === "light") root.setAttribute("data-theme", "light");
  else root.removeAttribute("data-theme");
  const chrome = CHROME[resolved];
  document.querySelector<HTMLMetaElement>('meta[name="theme-color"]')?.setAttribute("content", chrome.color);
  document
    .querySelector<HTMLMetaElement>('meta[name="apple-mobile-web-app-status-bar-style"]')
    ?.setAttribute("content", chrome.statusBar);
}

/// Push the chosen accent into the CSS custom properties every highlight reads.
/// The soft/glow tints are the base at low alpha, derived here so a new accent
/// needs only its three hex values above.
///
/// The identity accent is the CSS default — including a darker, contrast-tuned shade
/// for light mode. For it we therefore CLEAR the inline overrides and let the stylesheet
/// decide, rather than force one shade across both themes. Only a deliberately chosen
/// non-default accent overrides the stylesheet.
const ACCENT_PROPS = ["--ember", "--ember-hover", "--ember-ink", "--ember-soft", "--ember-rgb", "--glow-1", "--glow-2"];
function applyAccent(a: Accent): void {
  const s = document.documentElement.style;
  if (a === DEFAULT_ACCENT) {
    for (const p of ACCENT_PROPS) s.removeProperty(p);
    return;
  }
  const { base, hover, ink } = ACCENTS[a];
  s.setProperty("--ember", base);
  s.setProperty("--ember-hover", hover);
  s.setProperty("--ember-ink", ink);
  s.setProperty("--ember-soft", hexA(base, 0.12));
  // Raw channels ("r g b") so any tint in the stylesheet can be built from the
  // live accent — rgb(var(--ember-rgb) / .18) — instead of a hardcoded teal.
  // This is what makes the balance aurora, shadows, pills and glows follow the
  // chosen accent rather than staying teal.
  s.setProperty("--ember-rgb", rgbTriplet(base));
  s.setProperty("--glow-1", hexA(base, 0.08));
  s.setProperty("--glow-2", hexA(base, 0.05));
}

/// "#rrggbb" + alpha -> "rgba(r,g,b,a)". Kept tiny and dependency-free.
function hexA(hex: string, a: number): string {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${a})`;
}

/// "#rrggbb" -> "r g b" (space-separated channels for rgb(... / alpha)).
function rgbTriplet(hex: string): string {
  const n = parseInt(hex.slice(1), 16);
  return `${(n >> 16) & 255} ${(n >> 8) & 255} ${n & 255}`;
}
