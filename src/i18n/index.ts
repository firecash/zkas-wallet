// One catalogue, many languages.
//
// English is the SOURCE: it lives in src/i18n/en/*.json, one file per area of the app
// (send, settings, node, …) so that people can work on different areas without editing
// one giant file. The files are merged at runtime into the single "translation"
// namespace. Every other language is ONE generated file in src/i18n/locales/<lang>.json,
// produced by scripts/translate.mjs from the merged English, and loaded lazily so the
// bundle carries only the language in use.
//
// Keys are stable identifiers (`send.confirm.title`), never the English text: a copy
// change must not orphan 24 translations. Interpolation is i18next's `{{name}}`; plurals
// are `key_one` / `key_other` (i18next resolves them per language's plural rules).
import i18n from "i18next";
import { initReactI18next } from "react-i18next";

/// The languages the app ships. Native names are what a user looks for in a list —
/// nobody searches for "Japanese" in a menu written in Japanese. `rtl` flips the
/// document direction for the scripts that run right-to-left.
export const LANGUAGES: { code: string; name: string; rtl?: boolean }[] = [
  { code: "en", name: "English" },
  { code: "zh-CN", name: "简体中文" },
  { code: "zh-TW", name: "繁體中文" },
  { code: "es", name: "Español" },
  { code: "hi", name: "हिन्दी" },
  { code: "ar", name: "العربية", rtl: true },
  { code: "fr", name: "Français" },
  { code: "bn", name: "বাংলা" },
  { code: "pt-BR", name: "Português (Brasil)" },
  { code: "ru", name: "Русский" },
  { code: "ur", name: "اردو", rtl: true },
  { code: "id", name: "Bahasa Indonesia" },
  { code: "de", name: "Deutsch" },
  { code: "ja", name: "日本語" },
  { code: "tr", name: "Türkçe" },
  { code: "vi", name: "Tiếng Việt" },
  { code: "ko", name: "한국어" },
  { code: "it", name: "Italiano" },
  { code: "th", name: "ไทย" },
  { code: "pl", name: "Polski" },
  { code: "fa", name: "فارسی", rtl: true },
  { code: "uk", name: "Українська" },
  { code: "nl", name: "Nederlands" },
  { code: "ms", name: "Bahasa Melayu" },
  { code: "sw", name: "Kiswahili" },
];

const LANG_KEY = "lang";

// Merge every English partial into one flat namespace. A duplicate key across two
// partials is a bug: the second silently wins, so it is reported once in dev.
const partials = import.meta.glob("./en/*.json", { eager: true, import: "default" }) as Record<string, Record<string, unknown>>;
function mergedEnglish(): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [file, tree] of Object.entries(partials)) {
    for (const [top, value] of Object.entries(tree)) {
      if (top in out && typeof out[top] === "object" && typeof value === "object" && value) {
        // Two partials contributing to the same top-level area (e.g. two files both
        // adding under "settings") merge one level deep; deeper collisions are reported.
        const dst = out[top] as Record<string, unknown>;
        for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
          if (k in dst && import.meta.env.DEV) console.warn(`i18n: duplicate key ${top}.${k} (also in ${file})`);
          dst[k] = v;
        }
      } else {
        out[top] = value;
      }
    }
  }
  return out;
}
export const EN = mergedEnglish();

// Generated translations, loaded on demand.
const locales = import.meta.glob("./locales/*.json", { import: "default" }) as Record<string, () => Promise<Record<string, unknown>>>;

/// Pick the best supported language for a BCP-47 tag ("pt-BR" → pt-BR, "pt" → pt-BR,
/// "zh-Hant-TW" → zh-TW, "de-AT" → de). Unknown → null.
export function matchLanguage(tag: string): string | null {
  const lower = tag.toLowerCase();
  const exact = LANGUAGES.find((l) => l.code.toLowerCase() === lower);
  if (exact) return exact.code;
  if (lower.startsWith("zh")) return /hant|tw|hk|mo/.test(lower) ? "zh-TW" : "zh-CN";
  const base = lower.split("-")[0];
  const byBase = LANGUAGES.find((l) => l.code.toLowerCase().split("-")[0] === base);
  return byBase ? byBase.code : null;
}

/// The stored choice, else the first of the browser's languages we ship, else English.
export function detectLanguage(): string {
  try {
    const stored = localStorage.getItem(LANG_KEY);
    if (stored && LANGUAGES.some((l) => l.code === stored)) return stored;
  } catch {
    /* storage blocked: fall through to the browser's preference */
  }
  const prefs = typeof navigator !== "undefined" ? navigator.languages ?? [navigator.language] : [];
  for (const p of prefs) {
    const m = p ? matchLanguage(p) : null;
    if (m) return m;
  }
  return "en";
}

function applyDirection(code: string) {
  if (typeof document === "undefined") return;
  const lang = LANGUAGES.find((l) => l.code === code);
  document.documentElement.lang = code;
  document.documentElement.dir = lang?.rtl ? "rtl" : "ltr";
}

/// Switch language: loads the catalogue if needed, persists the choice, flips direction.
export async function setLanguage(code: string): Promise<void> {
  await applyLanguage(code);
  try {
    localStorage.setItem(LANG_KEY, currentLanguage());
  } catch {
    /* best effort */
  }
}

/// Load and activate a language without recording it as the user's choice.
export async function applyLanguage(code: string): Promise<void> {
  if (!LANGUAGES.some((l) => l.code === code)) code = "en";
  if (code !== "en" && !i18n.hasResourceBundle(code, "translation")) {
    const loader = locales[`./locales/${code}.json`];
    if (loader) {
      try {
        i18n.addResourceBundle(code, "translation", await loader(), true, true);
      } catch (e) {
        console.warn(`i18n: could not load ${code}`, e);
      }
    }
  }
  await i18n.changeLanguage(code);
  applyDirection(code);
}

export function currentLanguage(): string {
  return i18n.language || "en";
}

/// True once the user picked a language themselves (Settings, the welcome screen, or
/// the one-time "showing in X" bar). Until then the app follows the device language and
/// tells the user so, so a wrong guess is one tap away from fixed.
export function hasChosenLanguage(): boolean {
  try {
    return !!localStorage.getItem(LANG_KEY);
  } catch {
    return false;
  }
}

/// Human name of a language code, for the "showing in …" bar.
export function languageName(code: string): string {
  return LANGUAGES.find((l) => l.code === code)?.name ?? code;
}

/// Number/date formatting follows the UI language, not the OS locale, so a user who
/// switched the app to Arabic gets Arabic digits and separators throughout.
export function formatNumber(n: number, opts?: Intl.NumberFormatOptions): string {
  return new Intl.NumberFormat(currentLanguage(), opts).format(n);
}
export function formatDate(d: Date | number, opts: Intl.DateTimeFormatOptions = { dateStyle: "medium", timeStyle: "short" }): string {
  return new Intl.DateTimeFormat(currentLanguage(), opts).format(d);
}

void i18n.use(initReactI18next).init({
  resources: { en: { translation: EN } },
  lng: "en",
  fallbackLng: "en",
  interpolation: { escapeValue: false },
  returnEmptyString: false,
});

// Apply the detected language at boot. English needs no load, so the first paint is
// already right for English users; other languages arrive after one small fetch.
const initial = detectLanguage();
// Direction first, before any paint: an RTL user must not see the page flip after the
// catalogue arrives. Following the device language is not a "choice" yet, so the
// stored key is only written when the user confirms or picks one (see setLanguage
// callers); `applyLanguage` below loads without persisting.
applyDirection(initial);
if (initial !== "en") void applyLanguage(initial);

export { i18n };
export default i18n;
