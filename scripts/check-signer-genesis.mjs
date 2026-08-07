#!/usr/bin/env node
// Refuse to ship a build whose signer WASM was compiled for a different chain.
//
// Why this exists: ZKas-Wallet-0.3.13.apk (2026-07-26) shipped with
// `firecash_signer_bg-CeXRLEkU.wasm` — the 2026-07-19 signer, built before the
// mainnet genesis existed. The signer derives the transaction sighash domain from a
// genesis hash compiled INTO it, and by design "never trusts a server-supplied hash
// or network domain". So a signer built for another chain signs every payment over
// the wrong domain, and the daemon rejects all of them with
// `InvalidExternalSignature` — for every wallet, forever, with an error that says
// nothing about the cause. It cost a user an afternoon of failed payments and sent
// us hunting through the daemon, which was innocent.
//
// Nothing in the pipeline noticed, because a stale asset is a perfectly valid file.
// The only reliable check is: does the shipped binary contain the genesis of the
// chain we are shipping for? That is what this asserts.
//
// Usage:  node scripts/check-signer-genesis.mjs <genesis-hex> [dir ...]
// Runs over dist/ and the Android assets by default.

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const genesisHex = (process.argv[2] || process.env.ZKAS_GENESIS || "").trim().toLowerCase();
if (!/^[0-9a-f]{64}$/.test(genesisHex)) {
  console.error("usage: check-signer-genesis.mjs <64-hex-char genesis> [dir ...]");
  console.error("  (or set ZKAS_GENESIS). Get it from a wallet checkpoint: bytes 5..37 of a .scan file,");
  console.error("  or from the daemon's configured network params.");
  process.exit(2);
}
const needle = Buffer.from(genesisHex, "hex");

const roots = process.argv.slice(3);
if (roots.length === 0) roots.push("dist", "android/app/src/main/assets", "ios/App/App/public");

function* walk(dir) {
  let entries;
  try {
    entries = readdirSync(dir);
  } catch {
    return; // a target that was never built is not a failure
  }
  for (const e of entries) {
    const p = join(dir, e);
    if (statSync(p).isDirectory()) yield* walk(p);
    else if (p.endsWith(".wasm")) yield p;
  }
}

let checked = 0;
const bad = [];
for (const root of roots) {
  for (const f of walk(root)) {
    checked++;
    if (!readFileSync(f).includes(needle)) bad.push(f);
  }
}

if (checked === 0) {
  console.error(`✗ no signer WASM found under: ${roots.join(", ")} — nothing was verified.`);
  console.error("  Refusing to pass: a build with no signer is not a build that can pay.");
  process.exit(1);
}
if (bad.length) {
  console.error(`✗ ${bad.length} of ${checked} signer WASM(s) were NOT built for genesis ${genesisHex}:`);
  for (const f of bad) console.error(`    ${f}`);
  console.error("");
  console.error("  These sign payments over the wrong chain's domain. Every payment they make will be");
  console.error("  rejected with InvalidExternalSignature. Rebuild the signer for this chain and re-sync");
  console.error("  the native assets (npm run mobile:sync) before shipping.");
  process.exit(1);
}
console.log(`✓ all ${checked} signer WASM(s) carry genesis ${genesisHex.slice(0, 8)}…`);
