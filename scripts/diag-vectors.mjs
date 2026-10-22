// Regenerate test/diag-redaction-vectors.json from the canonical JS redactor.
//
//   npx vite-node scripts/diag-vectors.mjs
//
// The vectors are what the Rust (src-tauri/src/diag.rs) and Kotlin (DiagRedact.kt) ports are
// tested against, so the three cannot drift. Regenerate ONLY when redact.ts changes on
// purpose, then make both ports pass again.
import { writeFileSync } from "node:fs";
import { redactText, setSalt } from "../src/diag/redact.ts";

const SALT = "000102030405060708090a0b0c0d0e0f";
const inputs = [
  "plain words stay exactly as they are",
  "pay zkas:py82h42m9qjff0knpcmllzq3c7qhurje5auh4tq2ceagf69wjpf23djwwmqr26zhsua8rrglrwdltsh now",
  "ZKAS:PY82H42M9QJFF0KNPCMLLZQ3C7QHURJE5AUH4TQ2CEAGF69WJPF23DJWWMQR26ZHSUA8RRGLRWDLTSH",
  "legacy firecash:py82h42m9qjff0knpcmllzq3c7qhurje5auh4tq2ceagf69wjpf23djwwmqr26zhsua8rrglrwdl",
  "kaspa:qrap6w97jjpwrp59yj8fd3tfkz9jkxjd2spsjn4yxfpw60zzpdzsxnddcggqe merged",
  "tx 35dd94a1d8d20d8b19e1b70531f105736071876945f04b2028d5b97fdeff43ff accepted",
  "wallet 'a1b2c3d4e5f60718293a4b5c6d7e8f90': rescan from DAA 1234",
  "token Ab3dE5gH7jK9mN1pQ3sT5vW7yZ9aB1cD rejected",
  "fvk 0a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f9",
  "abandon ability able about above absent absorb abstract absurd abuse access accident",
  "sent 1234.5678 ZKAS and fee 3,000,000 sompi and 0.5 KAS",
  "-2 ZKAS refund",
  "contact someone@example.org",
  "node 203.0.113.77:16110 and lan 192.168.1.23:8501 and 10.0.0.5",
  "public 185.147.157.125:16110 and seed.zkas.info:16110 and 127.0.0.1:8501",
  "via abcdefghijklmnopqrstuvwxyz234567abcdefghijklmnopqrstuvwx.onion",
  "known plqu6zzg5u6lkofv76m3pnnxzbaus6pgs4thced4wejdroi7z7exd6qd.onion stays",
  "panicked at src/lib.rs:4123:9: called `Option::unwrap()` on a `None` value",
  "page pipeline: fetch 90000 ms (1800 ms/page) | ingest 5000 ms (100 ms/page) | 50 pages",
  "deadbeefdeadbeef inside",
  "CamelCaseIdentifierThatIsVeryLongButHasNoDigits stays",
  "short abc123 and medium a1b2c3d4e5 ok",
  "mixed key_9f86d081884c7d659a2feaa0c55ad015 end",
  "numbers stay: cpu 0.10000000149011612, at 1792686764009, big 12345678901234567890",
  "bare py82h42m9qjff0knpcmllzq3c7qhurje5auh4tq2ceagf69wjpf23djwwmqr26zhsua8rrglrwdltsh body",
  "ua Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.6723.92 Safari/537.36 Edg/130.0.2849.80 via 203.0.113.9 and 10.0.0.5",
  "not a ua: proxy/203.0.113.9 and http://198.51.100.4:8080/x and XChrome 203.0.113.10",
];
setSalt(SALT);
const cases = inputs.map((input) => ({ input, expect: redactText(input, 600) }));
writeFileSync(new URL("../test/diag-redaction-vectors.json", import.meta.url), JSON.stringify({ salt: SALT, max: 600, cases }, null, 2) + "\n");
console.log(`wrote ${cases.length} vectors`);
for (const c of cases) console.log(`${c.input}\n  -> ${c.expect}`);
