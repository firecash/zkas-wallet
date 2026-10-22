import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// The UniFFI Kotlin binding is committed so a clean checkout compiles. The danger of a
// committed generated file is that it goes stale while the engine moves on (it once sat
// frozen from 10 September while the engine gained three functions). So: the binding
// carries the engine revision it was generated from, that revision must be the one every
// engine build pins, and every engine function the app calls must exist in it.
const ROOT = process.cwd();
const BINDING = join(ROOT, "android/app/src/main/java/uniffi/zkas_walletd_mobile/zkas_walletd_mobile.kt");
const binding = readFileSync(BINDING, "utf8");

function pins(): string[] {
  const out: string[] = [];
  // Every workflow that checks the engine out, not a fixed list: desktop-diag-smoke.yml
  // joined later and a list would have missed it.
  for (const f of readdirSync(join(ROOT, ".github/workflows")).filter((n) => n.endsWith(".yml"))) {
    const y = readFileSync(join(ROOT, ".github/workflows", f), "utf8");
    for (const m of y.matchAll(/^\s*(?:ref|RK_SHA):\s*([0-9a-f]{40})\s*$/gm)) out.push(m[1]);
  }
  return out;
}

function kotlinSources(dir: string): string[] {
  return readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    return statSync(p).isDirectory() ? kotlinSources(p) : p.endsWith(".kt") ? [p] : [];
  });
}

describe("committed UniFFI engine binding", () => {
  const stamp = binding.split("\n", 1)[0];

  it("is stamped with the engine revision it was generated from", () => {
    expect(stamp).toMatch(/^\/\/ ENGINE-BINDING zkas-rusty=[0-9a-f]{40} zkas-signer=[0-9a-f]{40}$/);
  });

  it("was generated from the engine revision the builds pin", () => {
    const declared = new Set(pins());
    expect(declared.size).toBe(1); // the three workflows agree on one engine
    const rev = /zkas-rusty=([0-9a-f]{40})/.exec(stamp)?.[1];
    expect(rev).toBe([...declared][0]);
  });

  it("declares every engine function the app calls", () => {
    const called = new Set<string>();
    for (const f of kotlinSources(join(ROOT, "android/app/src/main/java/com"))) {
      for (const m of readFileSync(f, "utf8").matchAll(/uniffi\.zkas_walletd_mobile\.([A-Za-z]+)/g)) called.add(m[1]);
    }
    expect(called.size).toBeGreaterThan(0);
    const missing = [...called].filter((fn) => !binding.includes(`fun \`${fn}\`(`));
    expect(missing).toEqual([]);
  });
});
