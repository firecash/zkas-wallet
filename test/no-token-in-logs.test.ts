import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { redactKeyName } from "../src/securestore";

/**
 * The wallet TOKEN authenticates every request to the hosted daemon, which holds the
 * wallet's view key and answers with its balance and full transaction history. So the token
 * is read access to exactly the metadata this project exists to keep private.
 *
 * Every per-wallet key carries it as a suffix, and the iOS keychain-restore path logged the
 * names of the keys it put back — `device_seed_<token>`, `watch_fvk_<token>` — into the
 * console, which on a debuggable Android build is logcat, on desktop is devtools, and in a
 * screen-share is the screen.
 */
describe("the wallet token does not reach a log", () => {
  const TOKEN = "8f3ad21c4b5e6079aabbccddeeff0011";

  it("strips the token from a per-wallet key name", () => {
    for (const prefix of ["device_seed_", "watch_fvk_", "contacts_", "app_lock_v1_", "seed_unsealed_"]) {
      const out = redactKeyName(prefix + TOKEN);
      expect(out).toBe(`${prefix}…`);
      expect(out).not.toContain(TOKEN);
      // Any fragment of it is still a correlatable identifier.
      expect(out).not.toContain(TOKEN.slice(0, 8));
    }
  });

  it("keeps the kind of key, which is the part worth logging", () => {
    expect(redactKeyName(`device_seed_${TOKEN}`)).toContain("device_seed");
    expect(redactKeyName(`watch_fvk_${TOKEN}`)).toContain("watch_fvk");
  });

  it("leaves global key names alone", () => {
    expect(redactKeyName("app_lock_v2")).toBe("app_lock_v2");
    expect(redactKeyName("mnemonic_unsealed")).toBe("mnemonic_unsealed");
    expect(redactKeyName("contacts_default")).toBe("contacts_default");
  });

  it("is actually what the restore path logs", () => {
    // The redactor being correct says nothing about it being called — the same gap the
    // memo byte-clamp had.
    const main = readFileSync("src/main.tsx", "utf8");
    const i = main.indexOf("restored ${restored.length} evicted key(s)");
    expect(i).toBeGreaterThan(0);
    const line = main.slice(i - 400, i + 200);
    expect(line).toContain("redactKeyName");
    expect(line).not.toContain("restored.join");
  });

  it("no console call in src prints a token, seed or phrase directly", () => {
    const files = ["src/main.tsx", "src/applock.ts", "src/securestore.ts", "src/api.ts", "src/App.tsx"];
    for (const f of files) {
      const src = readFileSync(f, "utf8");
      for (const m of src.matchAll(/console\.(log|warn|error|info|debug)\(([^\n]*)/g)) {
        const args = m[2];
        // A bare identifier for a secret, or a template hole holding one.
        expect(args, `${f}: ${args.slice(0, 80)}`).not.toMatch(/\b(seed|mnemonic|phrase|secret|fvk|viewKey|password)\b(?!\w)/i);
      }
    }
  });
});
