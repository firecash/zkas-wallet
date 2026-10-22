// Check an exported diagnostic log against the redaction rules, and summarise it.
//
//   npx vite-node scripts/diag-check.mjs zkas-diagnostics-<stamp>.jsonl [--secrets file]
//
// Every line must be one JSON object, and no line may contain anything the redactor forbids
// (addresses, hex runs of 16+, long tokens, phrase-shaped word runs, bare amounts, emails) or
// any exact value listed in the optional secrets file (one per line). Exits 1 on a violation.
import { readFileSync } from "node:fs";
import { violations } from "../src/diag/redact.ts";

const file = process.argv[2];
if (!file) {
  console.error("usage: diag-check.mjs <export.jsonl> [--secrets file]");
  process.exit(2);
}
const si = process.argv.indexOf("--secrets");
const secrets = si > 0 ? readFileSync(process.argv[si + 1], "utf8").split(/\r?\n/).map((s) => s.trim()).filter(Boolean) : [];
// CRLF-tolerant: an export opened and re-saved on Windows, or checked out with autocrlf.
const lines = readFileSync(file, "utf8").replace(/^\uFEFF/, "").split(/\r?\n/).filter((l) => l.trim());
let bad = 0;
let unparsable = 0;
const counts = new Map();
const sources = new Map();
for (const [i, line] of lines.entries()) {
  let o;
  try {
    o = JSON.parse(line);
  } catch {
    unparsable++;
    console.log(`line ${i + 1}: not JSON`);
    continue;
  }
  const v = violations(line, secrets);
  if (v.length) {
    bad++;
    console.log(`line ${i + 1}: ${v.join(",")}: ${line.slice(0, 200)}`);
  }
  if (o.cat && o.ev) counts.set(`${o.cat}.${o.ev}`, (counts.get(`${o.cat}.${o.ev}`) ?? 0) + 1);
  if (o.src) sources.set(o.src, (sources.get(o.src) ?? 0) + 1);
}
console.log(`\n${lines.length} lines, ${unparsable} unparsable, ${bad} with violations`);
console.log(`sources: ${[...sources].map(([k, v]) => `${k}=${v}`).join(" ")}`);
console.log("events:");
for (const [k, v] of [...counts].sort((a, b) => b[1] - a[1])) console.log(`  ${String(v).padStart(6)}  ${k}`);
process.exit(bad || unparsable ? 1 : 0);
