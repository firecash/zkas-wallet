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
/// nobody searches for "Japanese" in a menu written in Japanese. The flag is what the
/// language button shows (a flag is recognised faster than a code; it stands for the
/// language, not a country — Spanish gets Spain's, Swahili Kenya's). `rtl` flips the
/// document direction for the scripts that run right-to-left.
export const LANGUAGES: { code: string; name: string; flag: string; rtl?: boolean }[] = [
  { code: "en", name: "English", flag: "🇬🇧" },
  { code: "zh-CN", name: "简体中文", flag: "🇨🇳" },
  { code: "zh-TW", name: "繁體中文", flag: "🇹🇼" },
  { code: "es", name: "Español", flag: "🇪🇸" },
  { code: "hi", name: "हिन्दी", flag: "🇮🇳" },
  { code: "ar", name: "العربية", flag: "🇸🇦", rtl: true },
  { code: "fr", name: "Français", flag: "🇫🇷" },
  { code: "bn", name: "বাংলা", flag: "🇧🇩" },
  { code: "pt-BR", name: "Português (Brasil)", flag: "🇧🇷" },
  { code: "ru", name: "Русский", flag: "🇷🇺" },
  { code: "ur", name: "اردو", flag: "🇵🇰", rtl: true },
  { code: "id", name: "Bahasa Indonesia", flag: "🇮🇩" },
  { code: "de", name: "Deutsch", flag: "🇩🇪" },
  { code: "ja", name: "日本語", flag: "🇯🇵" },
  { code: "tr", name: "Türkçe", flag: "🇹🇷" },
  { code: "vi", name: "Tiếng Việt", flag: "🇻🇳" },
  { code: "ko", name: "한국어", flag: "🇰🇷" },
  { code: "it", name: "Italiano", flag: "🇮🇹" },
  { code: "th", name: "ไทย", flag: "🇹🇭" },
  { code: "pl", name: "Polski", flag: "🇵🇱" },
  { code: "fa", name: "فارسی", flag: "🇮🇷", rtl: true },
  { code: "uk", name: "Українська", flag: "🇺🇦" },
  { code: "nl", name: "Nederlands", flag: "🇳🇱" },
  { code: "ms", name: "Bahasa Melayu", flag: "🇲🇾" },
  { code: "sw", name: "Kiswahili", flag: "🇰🇪" },
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

/// i18next picks `key_few` / `key_many` / … by the language's plural rules and falls back
/// to ENGLISH when that form is missing. The catalogues carry every form the language
/// has (scripts/translate.mjs --plurals); this is the belt to those braces: a form that
/// is still missing borrows the language's `_other` text, so a Russian dialog never says
/// "5 notes" in English while the rest is Russian.
function fillPluralForms(code: string, tree: Record<string, unknown>): Record<string, unknown> {
  let cats: string[] = [];
  try {
    cats = new Intl.PluralRules(code).resolvedOptions().pluralCategories;
  } catch {
    return tree;
  }
  const walk = (node: Record<string, unknown>) => {
    for (const [k, v] of Object.entries(node)) {
      if (v && typeof v === "object") walk(v as Record<string, unknown>);
      else if (k.endsWith("_other")) {
        const base = k.slice(0, -6);
        for (const c of cats) if (!(`${base}_${c}` in node)) node[`${base}_${c}`] = v;
      }
    }
  };
  walk(tree);
  return tree;
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
        i18n.addResourceBundle(code, "translation", fillPluralForms(code, await loader()), true, true);
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
