#!/usr/bin/env node
// Translate the English catalogue into every language in src/i18n/index.ts with the
// DeepSeek API (OpenAI-compatible chat completions).
//
//   VENICE_API_KEY=… node scripts/translate.mjs                 # all languages, missing/changed keys only (DeepSeek via Venice)
//   DEEPSEEK_API_KEY=sk-… node scripts/translate.mjs            # same, straight to DeepSeek's API
//   … de ja                                                      # only these languages
//   … --force                                                    # retranslate everything
//   … --dry-run                                                  # show what would be sent
//   … --review                                                   # stronger model re-reads every translation and fixes the bad ones
//
// Incremental: src/i18n/locales/<lang>.json carries every key; src/i18n/locales/.source.json
// remembers the English text each translation was made from, so only keys whose English
// changed (or that are new) are sent again. Batches of ~40 keys per request, strict JSON
// in and out, and every answer is validated before it is kept: same key set, every
// `{{placeholder}}` preserved verbatim, `<b>…</b>`-style Trans tags preserved, no empty strings.
// Keys that fail validation (placeholders, length budget) are resent up to three times, then reported and skipped — the app
// falls back to English for a missing key, never to a broken string.
import { readFileSync, writeFileSync, existsSync, readdirSync, mkdirSync } from "node:fs";
import { join } from "node:path";

const ROOT = new URL("..", import.meta.url).pathname;
const EN_DIR = join(ROOT, "src", "i18n", "en");
const OUT_DIR = join(ROOT, "src", "i18n", "locales");
const SOURCE_FILE = join(OUT_DIR, ".source.json");
// Provider: Venice (OpenAI-compatible, hosts DeepSeek) when VENICE_API_KEY is set, else
// DeepSeek's own API. Both take the same request shape.
const VENICE = !!process.env.VENICE_API_KEY;
const API = process.env.TRANSLATE_API_URL || (VENICE ? "https://api.venice.ai/api/v1/chat/completions" : "https://api.deepseek.com/chat/completions");
const MODEL = process.env.TRANSLATE_MODEL || (VENICE ? "deepseek-v4-flash" : "deepseek-chat");
const KEY = process.env.VENICE_API_KEY || process.env.DEEPSEEK_API_KEY;
const BATCH = 40;

const args = process.argv.slice(2);
const force = args.includes("--force");
const dryRun = args.includes("--dry-run");
const only = args.filter((a) => !a.startsWith("--"));

// The language list lives in index.ts; read it without importing TS.
const indexTs = readFileSync(join(ROOT, "src", "i18n", "index.ts"), "utf8");
const LANGUAGES = [...indexTs.matchAll(/\{ code: "([^"]+)", name: "([^"]+)"/g)].map((m) => ({ code: m[1], name: m[2] })).filter((l) => l.code !== "en");
const NAMES = {
  "zh-CN": "Simplified Chinese (Mainland China)", "zh-TW": "Traditional Chinese (Taiwan)", es: "Spanish", hi: "Hindi", ar: "Modern Standard Arabic",
  fr: "French", bn: "Bengali", "pt-BR": "Brazilian Portuguese", ru: "Russian", ur: "Urdu", id: "Indonesian", de: "German", ja: "Japanese",
  tr: "Turkish", vi: "Vietnamese", ko: "Korean", it: "Italian", th: "Thai", pl: "Polish", fa: "Persian (Farsi)", uk: "Ukrainian", nl: "Dutch",
  ms: "Malay", sw: "Swahili",
};

function flatten(obj, prefix = "", out = {}) {
  for (const [k, v] of Object.entries(obj)) {
    const key = prefix ? `${prefix}.${k}` : k;
    if (v && typeof v === "object") flatten(v, key, out);
    else out[key] = String(v);
  }
  return out;
}
function unflatten(flat) {
  const out = {};
  for (const [key, v] of Object.entries(flat)) {
    const parts = key.split(".");
    let node = out;
    for (const p of parts.slice(0, -1)) node = node[p] ??= {};
    node[parts.at(-1)] = v;
  }
  return out;
}
function english() {
  const merged = {};
  for (const f of readdirSync(EN_DIR).filter((f) => f.endsWith(".json")).sort()) {
    Object.assign(merged, flatten(JSON.parse(readFileSync(join(EN_DIR, f), "utf8"))));
  }
  return merged;
}
// Character budget per string: buttons/labels (short) get exactly the English length;
// sentences get 20% slack because some languages genuinely need it, but never more.
// A hard equal-length rule made the model drop keys it could not fit (German verbs are
// long); the budget is the target the model is pushed toward, with slack for short
// strings, and a translation that still overruns after retries is KEPT (shortest seen)
// rather than replaced by English — an over-long label beats an untranslated one.
const budget = (en) => (en.length <= 24 ? Math.max(en.length + 2, Math.ceil(en.length * 1.25), 6) : Math.ceil(en.length * 1.3));
const placeholders = (s) => (s.match(/\{\{[^}]+\}\}|<\/?[a-z0-9]+>/g) || []).sort().join("|");

const GLOSSARY = `Never translate or transliterate (product/protocol names): ZKAS (the coin ticker), zkas: (address prefix), ZKas (the project), Kaspa, KAS, Tor, Orbot, Orchard, walletd, DAA, QR, Halo 2.`;

// Core vocabulary. Translated ONCE per language before the batches, then pinned into every
// batch prompt, so "recovery phrase" or "viewing key" reads the same on every screen —
// batch-by-batch translation otherwise drifts between synonyms.
const TERMS = {
  "recovery phrase": "the 12-word seed phrase that restores the wallet — the term popular wallets (Trust Wallet, MetaMask, Zashi) use in this language",
  "viewing key": "a key that lets a device see balances and history but never spend",
  "passphrase": "the password that unlocks the app / a backup file — render with the language's ordinary word for password/passphrase, never a bare 'phrase'",
  wallet: "the app or an account in it",
  "wallet service": "the server (daemon) the app talks to — hosted by ZKas or self-hosted",
  node: "a blockchain node (the technical term used by crypto apps in this language)",
  shielded: "private/encrypted on-chain, as in 'shielded transaction' (Zcash's term)",
  note: "one shielded coin inside the wallet (Zcash jargon). Render it with the language's everyday word for 'coin' (as in 'your balance is spread across 12 coins') — NEVER the word for a written note, a banknote or a musical note",
  "sync / syncing / synced": "keeping the wallet up to date with the chain",
  "scan / rescan": "reading the chain to find the wallet's coins",
  birthday: "the block height/date the wallet was created at (scanning starts there)",
  send: "verb, button", receive: "verb, button", pay: "verb, button", connect: "verb, button (imperative)", continue: "verb, button", "set up": "verb, button",
  history: "list of past transactions", settings: "", balance: "", address: "", amount: "", fee: "network fee", memo: "an encrypted message attached to a payment",
  pending: "not yet confirmed", confirmed: "", maturing: "received but not spendable yet",
  "back up / backup": "verb / noun: safety copy", restore: "bring a wallet back from its phrase or backup", import: "", "watch-only": "can see, cannot spend",
  "app lock": "the PIN/biometric lock of the app", mining: "", explorer: "the block explorer",
  "chain source": "which node the desktop app reads the chain from",
};

// One register per language, held throughout. Mixed "du/Sie" or "tú/usted" inside one
// app is the most visible tell of machine translation.
const REGISTER = {
  de: "informal 'du' throughout (as popular consumer apps do), never 'Sie'",
  fr: "'vous' throughout", es: "'tú' throughout (neutral Latin-American Spanish, no vosotros)", "pt-BR": "'você' throughout",
  it: "informal 'tu' throughout", nl: "'je/jij' throughout", pl: "second person singular, no 'Pan/Pani'", uk: "'ви' throughout", ru: "'вы' (lowercase) throughout, never 'ты'",
  tr: "'siz' throughout", id: "'Anda' throughout", ms: "'anda' throughout", vi: "'bạn' throughout", th: "polite (คุณ), no ครับ/ค่ะ particles in labels",
  ja: "です・ます polite form; labels and buttons as concise noun/verb forms without です", ko: "해요체 polite form; buttons as concise noun forms",
  "zh-CN": "neutral 您/你 → use 你 throughout", "zh-TW": "你 throughout", hi: "'आप' throughout", bn: "'আপনি' throughout", ur: "'آپ' throughout", ar: "Modern Standard Arabic, second person masculine singular as apps do", fa: "'شما' throughout", sw: "second person singular",
};

function kindOf(key, en) {
  const k = key.toLowerCase();
  if (/placeholder|hint$/.test(k)) return "input placeholder";
  if (/title|heading|eyebrow/.test(k)) return "title";
  if (en.length <= 24 && !/[.!?]$/.test(en)) return "button/label (must stay short)";
  return "sentence";
}

function systemPrompt(lang, termBank) {
  const terms = termBank ? `Established terminology for this language — use these EXACT renderings whenever the concept appears, never a synonym:\n${JSON.stringify(termBank)}\n` : "";
  return `You are the localisation lead for a cryptocurrency wallet app (ZKas: a private, shielded coin; screens: Send, Receive, History, Settings, Node, Mining, Explorer). You translate its UI strings from English into ${NAMES[lang] || lang}.
Input: a JSON object {strings: {key: English}, kind: {key: "button/label" | "title" | "input placeholder" | "sentence"}, maxChars: {key: N}}. Output: a JSON object with EXACTLY the keys of "strings", each mapped to its translation. JSON only, no commentary.
Register: ${REGISTER[lang] || "one consistent register throughout"}. Buttons (kind button/label) take the form a native app uses on a button — an imperative verb or a short noun, never an infinitive-as-noun or a description.
Quality bar: write what a native speaker would expect to read in a polished, popular wallet app in this language — the most natural, idiomatic, everyday wording, never a literal or bureaucratic rendering. Prefer the common term over the technically precise one when both are understood. Match the English register: plain and direct, no marketing tone, sentence case unless the English is a title.
Length: a translation should be at most maxChars[key] characters and should be SHORTER than the English whenever the language allows. Buttons, tabs and labels are the priority: abbreviate, drop articles and filler, use the short synonym, use everyday forms — a short natural phrase beats a long precise one. If a key truly cannot fit, still answer it with the shortest natural wording; NEVER omit a key and never leave a value empty.
Example (English → German): "Confirm & send" → "Senden" is wrong (meaning lost); "Bestätigen und senden" is too long; "Bestätigen & senden" is right. "Loading…" → "Lädt…". "Show all" → "Alle".
Placeholders and markup: keep every {{placeholder}} verbatim (same spelling, same double braces) and every tag pair such as <b>…</b>, <code>…</code>, <a>…</a> around the corresponding words; tag names are markup and are never translated; do not add, drop or reorder tags. Keys are identifiers: never translate or change them.
Plurals: keys ending in _one / _other are the singular / plural form of the same sentence; translate both per the language's plural rules (identical if the language does not inflect for number). Keep "…" and "·" characters, numbers, units and product names as in the English.
${GLOSSARY}
${terms}`;
}

const REVIEW = args.includes("--review");
const REVIEW_MODEL = process.env.REVIEW_MODEL || (VENICE ? "gemini-3-8-flash" : "deepseek-reasoner");

/// Review pass: send English + current translation, get back ONLY the keys that need a
/// better rendering. A stronger model judges what the fast one produced.
async function reviewBatch(lang, batch, current, termBank) {
  const body = {
    model: REVIEW_MODEL,
    temperature: 0.1,
    response_format: { type: "json_object" },
    ...(VENICE ? { venice_parameters: { include_venice_system_prompt: false, disable_thinking: true } } : {}),
    messages: [
      { role: "system", content: systemPrompt(lang, termBank) + `
REVIEW MODE. You receive {strings: {key: English}, current: {key: current translation}, kind, maxChars}. Judge every current translation as the app's ${NAMES[lang] || lang} localisation lead would. Return a JSON object containing ONLY the keys whose translation must change, each mapped to the corrected translation. Change a translation when it is: wrong in meaning; an unnatural, literal or bureaucratic rendering a native speaker would not write; the wrong sense of a word (e.g. musical/written 'note' for a coin, 'phrase' for a password); inconsistent with the established terminology or the required register; a noun/description where a button needs a verb; grammatically off; clumsily over-abbreviated; or clearly longer than needed; also fix abbreviations cut with a period on buttons/labels ("Подключ.", "Einst.") — use the full word or a shorter synonym; a label may exceed maxChars by a few characters rather than be mangled. Keep good translations out of the answer. If everything is fine, answer {}.` },
      { role: "user", content: JSON.stringify({
        strings: batch, current,
        kind: Object.fromEntries(Object.entries(batch).map(([k, v]) => [k, kindOf(k, v)])),
        maxChars: Object.fromEntries(Object.entries(batch).map(([k, v]) => [k, budget(v)])),
      }) },
    ],
  };
  let res;
  for (let wait = 1; ; wait++) {
    res = await fetch(API, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${KEY}` }, body: JSON.stringify(body), signal: AbortSignal.timeout(240_000) });
    if (res.ok) break;
    const text = (await res.text()).slice(0, 200);
    if ((res.status === 429 || res.status >= 500) && wait <= 6) { await new Promise((r) => setTimeout(r, wait * 8_000 + Math.random() * 4_000)); continue; }
    throw new Error(`HTTP ${res.status}: ${text}`);
  }
  const data = await res.json();
  let parsed = JSON.parse(data.choices?.[0]?.message?.content ?? "{}");
  if (parsed && typeof parsed === "object" && !Object.keys(batch).some((k) => k in parsed)) {
    const inner = Object.values(parsed).find((v) => v && typeof v === "object" && Object.keys(batch).some((k) => k in v));
    if (inner) parsed = inner; else { const flat = flatten(parsed); if (Object.keys(batch).some((k) => k in flat)) parsed = flat; }
  }
  return parsed;
}

async function printTermBank(lang) {
  const bank = await termBankFor(lang);
  console.log(`${lang}: ${JSON.stringify(bank)}`);
}

async function reviewLanguage(lang, en, source) {
  const file = join(OUT_DIR, `${lang}.json`);
  if (!existsSync(file)) { console.log(`${lang}: nothing to review`); return; }
  const cur = flatten(JSON.parse(readFileSync(file, "utf8")));
  const keys = Object.keys(en).filter((k) => k in cur);
  const termBank = await termBankFor(lang);
  let changed = 0, rejected = 0;
  const starts = []; for (let i = 0; i < keys.length; i += BATCH) starts.push(i);
  const INFLIGHT = Number(process.env.TRANSLATE_BATCHES || 3);
  await Promise.all(Array.from({ length: INFLIGHT }, async () => {
    for (let i = starts.shift(); i !== undefined; i = starts.shift()) {
      const slice = keys.slice(i, i + BATCH);
      const batch = Object.fromEntries(slice.map((k) => [k, en[k]]));
      const current = Object.fromEntries(slice.map((k) => [k, cur[k]]));
      let a;
      try { a = await reviewBatch(lang, batch, current, termBank); } catch (e) { console.warn(`  ${lang} review batch ${i / BATCH + 1} failed: ${e.message}`); continue; }
      for (const [k, v] of Object.entries(a || {})) {
        if (!(k in batch) || typeof v !== "string" || !v.trim() || v === cur[k]) continue;
        if (placeholders(v) !== placeholders(en[k])) { rejected++; continue; }
        cur[k] = v; source[lang][k] = en[k]; changed++;
      }
      writeFileSync(file, JSON.stringify(unflatten(cur), null, 2) + "\n");
      writeFileSync(SOURCE_FILE, JSON.stringify(source, null, 0) + "\n");
      console.log(`  ${lang}: reviewed ${Math.min(i + BATCH, keys.length)}/${keys.length}, ${changed} changed`);
    }
  }));
  console.log(`  ${lang}: review done — ${changed} improved, ${rejected} rejected (placeholders)`);
}

async function callDeepSeek(lang, batch, termBank) {
  const body = {
    model: MODEL,
    temperature: 0.2,
    response_format: { type: "json_object" },
    // Venice injects its own system prompt unless told not to; ours must be the only one.
    // DeepSeek v4 on Venice "thinks" by default, which turned a 2 s batch into minutes —
    // translation needs no chain of thought, so it is off.
    ...(VENICE ? { venice_parameters: { include_venice_system_prompt: false, disable_thinking: true } } : {}),
    messages: [
      // The system prompt is byte-identical for every batch of a language so the
      // provider's prompt cache serves it; only the user turn changes.
      { role: "system", content: systemPrompt(lang, termBank) },
      {
        role: "user",
        content: JSON.stringify({
          strings: batch,
          kind: Object.fromEntries(Object.entries(batch).map(([k, v]) => [k, kindOf(k, v)])),
          maxChars: Object.fromEntries(Object.entries(batch).map(([k, v]) => [k, budget(v)])),
        }),
      },
    ],
  };
  // "Model overloaded" (429) and 5xx are transient: back off and retry here, so a
  // burst of load does not turn a whole batch into English fallbacks.
  let res;
  for (let wait = 1; ; wait++) {
    res = await fetch(API, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${KEY}` },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(180_000),
    });
    if (res.ok) break;
    const text = (await res.text()).slice(0, 200);
    if ((res.status === 429 || res.status >= 500) && wait <= 6) {
      await new Promise((r) => setTimeout(r, wait * 8_000 + Math.random() * 4_000));
      continue;
    }
    throw new Error(`HTTP ${res.status}: ${text}`);
  }
  const data = await res.json();
  const text = data.choices?.[0]?.message?.content ?? "";
  let parsed = JSON.parse(text);
  // The model sometimes mirrors the request shape and answers {strings: {...}} (or any
  // single wrapper object). Unwrap when the batch keys sit one level down.
  if (parsed && typeof parsed === "object" && !Object.keys(batch).some((k) => k in parsed)) {
    const inner = Object.values(parsed).find((v) => v && typeof v === "object" && Object.keys(batch).some((k) => k in v));
    if (inner) parsed = inner;
    else {
      // Or it nested the dotted keys ({"walletBar": {"switchWallet": …}}): flatten back.
      const flat = flatten(parsed);
      if (Object.keys(batch).some((k) => k in flat)) parsed = flat;
    }
  }
  return parsed;
}

function validate(batch, answer) {
  const problems = [];
  for (const [k, en] of Object.entries(batch)) {
    const v = answer[k];
    if (typeof v !== "string" || !v.trim()) problems.push(`${k}: missing/empty`);
    else if (placeholders(v) !== placeholders(en)) problems.push(`${k}: placeholders differ (${placeholders(en)} vs ${placeholders(v)})`);
    // A one-character overrun is not worth two more round trips; retry real overruns.
    else if ([...v].length > budget(en) + Math.max(2, Math.ceil(budget(en) * 0.1))) problems.push(`${k}: too long (${[...v].length} > ${budget(en)} chars)`);
  }
  for (const k of Object.keys(answer)) if (!(k in batch)) problems.push(`${k}: unexpected key`);
  return problems;
}

/// Translate the core vocabulary once; the result is pinned into every batch prompt.
async function termBankFor(lang) {
  const req = Object.fromEntries(Object.entries(TERMS).map(([term, gloss]) => [term, gloss ? `${term} — ${gloss}` : term]));
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const res = await fetch(API, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${KEY}` },
        body: JSON.stringify({
          model: REVIEW ? REVIEW_MODEL : MODEL,
          temperature: 0.1,
          response_format: { type: "json_object" },
          ...(VENICE ? { venice_parameters: { include_venice_system_prompt: false, disable_thinking: true } } : {}),
          messages: [
            { role: "system", content: `You are the localisation lead for a cryptocurrency wallet app. For each English term below (with a gloss after " — "), give the single best ${NAMES[lang] || lang} rendering that popular wallet apps in that language use: natural, short, what a native speaker expects on a button or label. Answer a JSON object mapping each English term (the part before " — ", exactly as given) to its translation only. ${GLOSSARY}` },
            { role: "user", content: JSON.stringify(req) },
          ],
        }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      let parsed = JSON.parse(data.choices?.[0]?.message?.content ?? "{}");
      if (!Object.keys(TERMS).some((k) => k in parsed)) parsed = Object.values(parsed).find((v) => v && typeof v === "object") ?? parsed;
      const bank = {};
      for (const term of Object.keys(TERMS)) if (typeof parsed[term] === "string" && parsed[term].trim()) bank[term] = parsed[term].trim();
      if (Object.keys(bank).length >= Object.keys(TERMS).length / 2) return bank;
    } catch (e) {
      console.warn(`  ${lang}: term bank attempt ${attempt} failed: ${e.message}`);
    }
  }
  return null;
}

async function translateLanguage(lang, en, source) {
  const file = join(OUT_DIR, `${lang}.json`);
  const existing = existsSync(file) ? flatten(JSON.parse(readFileSync(file, "utf8"))) : {};
  const todo = Object.entries(en).filter(([k, text]) => force || !(k in existing) || source[lang]?.[k] !== text);
  console.log(`${lang}: ${Object.keys(en).length} keys, ${todo.length} to translate`);
  if (!todo.length || dryRun) return;
  const termBank = await termBankFor(lang);
  if (termBank) console.log(`  ${lang}: term bank ready (${Object.keys(termBank).length} terms)`);
  const out = { ...existing };
  let doneKeys = 0;
  const runBatch = async (i) => {
    const full = Object.fromEntries(todo.slice(i, i + BATCH));
    let pending = { ...full };
    // Best answer seen per key: valid placeholders, shortest length. Used when a key
    // keeps overrunning the budget after every attempt.
    const best = {};
    for (let attempt = 1; attempt <= 3 && Object.keys(pending).length; attempt++) {
      try {
        const a = await callDeepSeek(lang, pending, termBank);
        const problems = validate(pending, a);
        const bad = new Map(problems.map((p) => [p.split(":")[0], p]));
        for (const [k, v] of Object.entries(a)) {
          if (!(k in pending) || typeof v !== "string" || !v.trim()) continue;
          const structural = bad.has(k) && !bad.get(k).includes("too long");
          if (structural) continue; // placeholders broken: never keep
          if (!best[k] || [...v].length < [...best[k]].length) best[k] = v;
          if (!bad.has(k)) delete pending[k];
        }
        if (problems.length) console.warn(`  ${lang} batch ${i / BATCH + 1} attempt ${attempt}: ${problems.length} problems, ${Object.keys(pending).length} keys resent\n    ${problems.slice(0, 4).join("\n    ")}`);
      } catch (e) {
        console.warn(`  ${lang} batch ${i / BATCH + 1} attempt ${attempt} failed: ${e.message}`);
      }
    }
    for (const k of Object.keys(full)) {
      if (best[k]) { out[k] = best[k]; source[lang][k] = full[k]; }
      else console.warn(`  ${lang}: ${k} could not be translated; falls back to English`);
    }
    const kept = Object.keys(full).filter((k) => best[k] && [...best[k]].length > budget(full[k]));
    if (kept.length) console.warn(`  ${lang} batch ${i / BATCH + 1}: ${kept.length} kept over budget (shortest seen): ${kept.slice(0, 5).join(", ")}`);
    // Drop keys that no longer exist in English.
    for (const k of Object.keys(out)) if (!(k in en)) { delete out[k]; delete source[lang][k]; }
    writeFileSync(file, JSON.stringify(unflatten(out), null, 2) + "\n");
    writeFileSync(SOURCE_FILE, JSON.stringify(source, null, 0) + "\n");
    doneKeys += Object.keys(full).length;
    console.log(`  ${lang}: ${doneKeys}/${todo.length}`);
  };
  // A few batches of the same language in flight at once (they are independent; the
  // term bank keeps them consistent). Each finished batch is written to disk at once.
  const starts = [];
  for (let i = 0; i < todo.length; i += BATCH) starts.push(i);
  const INFLIGHT = Number(process.env.TRANSLATE_BATCHES || 3);
  await Promise.all(Array.from({ length: INFLIGHT }, async () => {
    for (let i = starts.shift(); i !== undefined; i = starts.shift()) await runBatch(i);
  }));
  console.log(`  ${lang}: done (${Object.keys(out).length} keys)`);
}

async function main() {
  if (!KEY && !dryRun) {
    console.error("VENICE_API_KEY or DEEPSEEK_API_KEY is not set");
    process.exit(2);
  }
  mkdirSync(OUT_DIR, { recursive: true });
  const en = english();
  const source = existsSync(SOURCE_FILE) ? JSON.parse(readFileSync(SOURCE_FILE, "utf8")) : {};
  const langs = only.length ? LANGUAGES.filter((l) => only.includes(l.code)) : LANGUAGES;
  // Languages are independent: run a few at once (each is a chain of sequential
  // batches). The source map is shared but only ever written under its own language key.
  const PARALLEL = Number(process.env.TRANSLATE_PARALLEL || 6);
  const queue = [...langs];
  await Promise.all(Array.from({ length: PARALLEL }, async () => {
    for (let l = queue.shift(); l; l = queue.shift()) {
      source[l.code] ??= {};
      if (args.includes("--terms")) await printTermBank(l.code);
      else if (REVIEW) await reviewLanguage(l.code, en, source);
      else await translateLanguage(l.code, en, source);
    }
  }));
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
