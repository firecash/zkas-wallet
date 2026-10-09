import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

// On desktop every wallet call is proxied through the Rust command
// `wallet_api_request`, which refuses any path not in its allowlist. A path the
// app calls but Rust does not allow is a feature that is dead on desktop only,
// and the user sees the raw backend refusal. Three were missing at once.
describe("the desktop proxy allows every path the app calls", () => {
  const api = readFileSync(resolve(process.cwd(), "src/api.ts"), "utf8");
  const rust = readFileSync(resolve(process.cwd(), "src-tauri/src/lib.rs"), "utf8");

  const allowStart = rust.indexOf("fn allowed_wallet_api_path");
  const allowed = new Set(
    [...rust.slice(allowStart, rust.indexOf("}", allowStart)).matchAll(/"(\/[a-z0-9/_-]+)"/g)].map((m) => m[1]),
  );

  // Paths as api.ts writes them, with any query string and template tail cut.
  const called = [...new Set(
    [...api.matchAll(/["`](\/api\/[a-zA-Z0-9/_-]+)/g)].map((m) => m[1]),
  )];

  it("finds the paths to compare", () => {
    expect(allowed.size).toBeGreaterThan(10);
    expect(called.length).toBeGreaterThan(10);
  });

  for (const path of called) {
    it(`${path} is allowed`, () => {
      expect(allowed.has(path)).toBe(true);
    });
  }
});
