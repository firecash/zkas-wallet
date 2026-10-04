// Build-time guard against chat-engine WASM drift — the same failure the signer
// guard exists for (1.0.24/1.0.25 shipped new glue with an old inlined wasm, and
// wallet creation died with "function import requires a callable").
//
// The chat engine is inlined as base64 and instantiated from those bytes, so if
// the glue and the inlined module come from different wasm-bindgen builds the
// break only shows up at runtime, on the first message a user tries to send.
//
// Unlike the signer there is no committed .wasm to hash against: shipping one
// would mean shipping the engine twice (the signer currently does — 580 KB of
// its dist weight is a binary copy nothing fetches). So this checks the half
// that actually catches the fatal case: every `wbg` import the module declares
// must be provided by the glue, and the exports the app calls must exist.
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";

const dir = new URL("../src/chat-engine/", import.meta.url);
const b64 = readFileSync(new URL("wasm-base64.ts", dir), "utf8").match(/WASM_B64 = "([^"]+)"/)?.[1];
if (!b64) fail("could not read WASM_B64 from src/chat-engine/wasm-base64.ts");
const inlined = Buffer.from(b64, "base64");
const glue = readFileSync(new URL("zkas_chat_identity.js", dir), "utf8");

const mod = new WebAssembly.Module(inlined);
const missing = WebAssembly.Module.imports(mod)
  .filter((i) => i.module === "wbg" && !glue.includes(`imports.wbg.${i.name}`))
  .map((i) => i.name);
if (missing.length) {
  fail(`the inlined WASM imports wbg functions the glue does not provide: ${missing.join(", ")}. ` +
       `The wasm and zkas_chat_identity.js are from different wasm-bindgen builds.`);
}

// The engine is useless to the app if any of these is absent, and a stale glue
// is exactly how that happens.
const exports = new Set(WebAssembly.Module.exports(mod).map((e) => e.name));
const needed = ["chat_identity", "sign_chat_event_with_key", "verify_chat_event",
                "dm_wrap", "dm_unwrap", "npub_to_hex", "hex_to_npub", "xonly_pubkey"];
const absent = needed.filter((n) => !exports.has(n));
if (absent.length) fail(`the inlined WASM is missing exports the app calls: ${absent.join(", ")}`);

const sha = createHash("sha256").update(inlined).digest("hex").slice(0, 12);
console.log(`chat engine inline OK — wasm ${sha}, all wbg imports satisfied, ${needed.length} exports present`);

function fail(msg) {
  console.error(`\n✗ chat engine WASM drift: ${msg}\n`);
  process.exit(1);
}
