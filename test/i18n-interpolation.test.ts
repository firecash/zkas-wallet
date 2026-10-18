import { readFileSync, readdirSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * Interpolation, on both sides of it.
 *
 * i18next replaces `{{name}}` from the object a `t()` call passes. Two ways that breaks, and
 * neither shows up in a type check or a render test:
 *
 *   - a call that does not pass what its string needs, which prints the literal braces;
 *   - a TRANSLATION whose placeholder was renamed — `{{amount}}` written as `{{montant}}` —
 *     which prints the literal braces in that language only, so it survives any review done
 *     in English.
 *
 * The app ships 24 languages and 1,774 keys, so this is checked mechanically. Both came back
 * clean when written; the point is the next translation PR.
 */
const flat = (o: unknown, p = "", out: Record<string, string> = {}): Record<string, string> => {
  if (o && typeof o === "object") {
    for (const [k, v] of Object.entries(o)) flat(v, p ? `${p}.${k}` : k, out);
  } else if (typeof o === "string") out[p] = o;
  return out;
};
const placeholders = (s: string) => new Set([...s.matchAll(/\{\{\s*([a-zA-Z0-9_]+)/g)].map((m) => m[1]));

const en: Record<string, string> = {};
for (const f of readdirSync("src/i18n/en")) Object.assign(en, flat(JSON.parse(readFileSync(`src/i18n/en/${f}`, "utf8"))));

describe("i18n interpolation", () => {
  it("has English strings to check", () => {
    expect(Object.keys(en).length).toBeGreaterThan(1000);
  });

  it("every translation uses the SAME placeholders as English", () => {
    const wrong: string[] = [];
    for (const f of readdirSync("src/i18n/locales")) {
      const loc = flat(JSON.parse(readFileSync(`src/i18n/locales/${f}`, "utf8")));
      for (const [k, v] of Object.entries(loc)) {
        if (!(k in en)) continue;
        const want = [...placeholders(en[k])].sort().join(",");
        const got = [...placeholders(v)].sort().join(",");
        if (want !== got) wrong.push(`${f} ${k}: en={{${want}}} vs {{${got}}}`);
      }
    }
    // A renamed placeholder prints raw braces in that language and nowhere else.
    expect(wrong).toEqual([]);
  });

  it("every t() call passes the names its string interpolates", () => {
    const walk = (d: string): string[] =>
      readdirSync(d, { withFileTypes: true }).flatMap((e) =>
        e.isDirectory() ? (e.name === "signer" || e.name === "i18n" ? [] : walk(`${d}/${e.name}`))
          : /\.tsx?$/.test(e.name) ? [`${d}/${e.name}`] : []);

    const names = (args: string) => {
      const out = new Set<string>();
      let depth = 0, cur = "";
      const parts: string[] = [];
      for (const ch of args) {
        if ("([{".includes(ch)) depth++;
        if (")]}".includes(ch)) depth--;
        if (ch === "," && depth === 0) { parts.push(cur); cur = ""; } else cur += ch;
      }
      parts.push(cur);
      for (const raw of parts) {
        const p = raw.trim();
        if (!p) continue;
        if (p.startsWith("...")) return null;            // spread: contents unknown
        const kv = /^([a-zA-Z0-9_]+)\s*:/.exec(p);
        if (kv) { out.add(kv[1]); continue; }
        const short = /^([a-zA-Z0-9_]+)$/.exec(p);       // ES6 shorthand { detail }
        if (short) out.add(short[1]);
      }
      return out;
    };

    const gaps: string[] = [];
    for (const f of walk("src")) {
      const src = readFileSync(f, "utf8");
      for (const m of src.matchAll(/\bt\(\s*"([a-zA-Z0-9_.]+)"\s*,\s*\{([^{}]*)\}/g)) {
        const [, key, args] = m;
        const passed = names(args);
        if (passed === null) continue;
        let need = new Set<string>();
        let known = false;
        for (const c of [key, ...["_one", "_other", "_zero", "_few", "_many", "_two"].map((s) => key + s)]) {
          if (c in en) { for (const p of placeholders(en[c])) need.add(p); known = true; }
        }
        if (!known) continue;
        const missing = [...need].filter((n) => n !== "count" && !passed.has(n));
        if (missing.length) gaps.push(`${f} ${key}: needs ${missing.join(",")}`);
      }
    }
    expect(gaps).toEqual([]);
  });
});
