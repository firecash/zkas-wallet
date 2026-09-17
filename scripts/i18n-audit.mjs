#!/usr/bin/env node
// Guard against untranslated UI. Scans the SPA sources for user-facing string literals
// that are not routed through i18next, and for keys referenced in code that the English
// catalogue does not define (and the reverse: catalogue keys nothing references).
//
//   node scripts/i18n-audit.mjs            # report; exit 1 on findings
//   node scripts/i18n-audit.mjs --list     # print every leftover literal with file:line
//
// What counts as user-facing: JSX text nodes, and the attributes placeholder / title /
// aria-label / alt / label. A literal is ignored when it is only punctuation, digits,
// a brand token (ZKAS, zkas:, KAS, Tor, …) or is inside a line carrying the marker
// comment `// i18n-ignore`.
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const ROOT = new URL("..", import.meta.url).pathname;
const SRC = join(ROOT, "src");
const list = process.argv.includes("--list");

const IGNORE_DIRS = new Set(["signer", "i18n", "assets"]);
const BRAND = /^(ZKAS|ZKas|zkas:?|KAS|Kaspa|Tor|Orbot|BIP-?39|ZIP-?32|Halo ?2|Orchard|DAA|QR|CSV|JSON|PWA|GPU|CPU|RAM|OK|v?\d[\d.]*(-rc\d+)?|[A-Z]{2,5}|[\d\s.,:;%+\-–—/()×·•…|]+)$/;

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    if (IGNORE_DIRS.has(name)) continue;
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) walk(p, out);
    else if (/\.(tsx|ts)$/.test(name) && !name.endsWith(".d.ts")) out.push(p);
  }
  return out;
}

function catalogueKeys() {
  const dir = join(SRC, "i18n", "en");
  const keys = new Set();
  const flat = (obj, prefix) => {
    for (const [k, v] of Object.entries(obj)) {
      const key = prefix ? `${prefix}.${k}` : k;
      if (v && typeof v === "object") flat(v, key);
      else keys.add(key);
    }
  };
  for (const f of readdirSync(dir)) if (f.endsWith(".json")) flat(JSON.parse(readFileSync(join(dir, f), "utf8")), "");
  return keys;
}

const files = walk(SRC);
const keys = catalogueKeys();
const leftovers = [];
const used = new Set();
const keyRe = /\bt\(\s*["'`]([a-zA-Z0-9_.-]+)["'`]/g;
const transRe = /i18nKey=["']([a-zA-Z0-9_.-]+)["']/g;

for (const file of files) {
  const src = readFileSync(file, "utf8");
  const rel = relative(ROOT, file);
  for (const m of src.matchAll(keyRe)) used.add(m[1]);
  for (const m of src.matchAll(transRe)) used.add(m[1]);
  if (!file.endsWith(".tsx")) continue;
  const lines = src.split("\n");
  lines.forEach((line, i) => {
    if (line.includes("i18n-ignore")) return;
    // JSX text: `>Some words<` on one line, or a line that is only text between tags
    // spanning lines. Word-bearing only.
    const texts = [];
    for (const m of line.matchAll(/>([^<>{}]*[A-Za-z][^<>{}]*)</g)) {
      const v = m[1].trim();
      // `a > 0 && b < c`, `Promise<void>` and `x ? y : z` are operators/generics, not copy.
      if (/&&|\|\||[!=]==|^[=,:;()?]|^\d|\($|Promise$|\?$/.test(v)) continue;
      texts.push(m[1]);
    }
    // A bare text line is JSX text only when it sits between a line ending in `>` (or a
    // `{" "}` spacer) and a line starting with `<` or `{`; anything with code punctuation,
    // a comment marker or a type/statement shape is code, not copy.
    const trimmed = line.trim();
    const prev = (lines.slice(0, i).reverse().find((l) => l.trim()) ?? "").trim();
    const next = (lines.slice(i + 1).find((l) => l.trim()) ?? "").trim();
    const jsxNeighbours = (/(>|\{" "\})$/.test(prev) || prev.endsWith("*/>")) && /^[<{]/.test(next);
    if (
      jsxNeighbours &&
      /^[A-Za-z][^<>{}=;()]*[a-z][^<>{}=;()]*$/.test(trimmed) &&
      !/^(import|export|const|let|return|type|interface|case|default|if|else|for|while|function|async|await|throw|try|catch|finally|\*|\/\/|\/\*)\b/.test(trimmed) &&
      !trimmed.startsWith("*") &&
      !/[:?]$/.test(trimmed) &&
      trimmed.split(" ").length > 1
    ) {
      texts.push(trimmed);
    }
    for (const m of line.matchAll(/\b(placeholder|title|aria-label|alt|label)=["']([^"']*[A-Za-z]{2,}[^"']*)["']/g)) texts.push(m[2]);
    for (const t of texts) {
      const v = t.trim();
      if (!v || BRAND.test(v)) continue;
      leftovers.push(`${rel}:${i + 1}: ${v.slice(0, 80)}`);
    }
  });
}

const missing = [...used].filter((k) => !keys.has(k) && !keys.has(`${k}_one`) && !keys.has(`${k}_other`)).sort();
const unused = [...keys].filter((k) => !used.has(k) && !used.has(k.replace(/_(one|other)$/, ""))).sort();

console.log(`i18n audit: ${files.length} files, ${keys.size} catalogue keys, ${used.size} keys referenced`);
console.log(`  leftover literals: ${leftovers.length}`);
console.log(`  keys used but not defined: ${missing.length}${missing.length ? "\n    " + missing.slice(0, 40).join("\n    ") : ""}`);
console.log(`  catalogue keys never referenced: ${unused.length}${list && unused.length ? "\n    " + unused.join("\n    ") : ""}`);
if (list && leftovers.length) console.log(leftovers.join("\n"));
process.exit(leftovers.length || missing.length ? 1 : 0);
