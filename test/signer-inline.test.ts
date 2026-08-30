import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { WASM_B64 } from "../src/signer/wasm-base64";

// The app loads the signer from the inlined base64 (wasm-base64.ts), NOT from the .wasm
// file next to it. Twice (1.0.24, 1.0.25) the .wasm and the JS glue were refreshed while
// the base64 stayed at an older build, and the glue no longer provided an import the old
// wasm needed: users saw `WebAssembly.instantiate(): Import #2 "wbg" "__wbindgen_is_object":
// function import requires a callable` when entering a recovery phrase. Pin the three
// together: the inlined bytes must be the committed .wasm, and every import the wasm asks
// of the glue must exist in the glue.
describe("inlined signer wasm", () => {
  const inlined = Buffer.from(WASM_B64, "base64");
  const file = readFileSync(join(process.cwd(), "src/signer/firecash_signer_bg.wasm"));
  const glue = readFileSync(join(process.cwd(), "src/signer/firecash_signer.js"), "utf8");

  it("is byte-identical to the committed .wasm", () => {
    const sha = (b: Buffer) => createHash("sha256").update(b).digest("hex");
    expect(sha(inlined)).toBe(sha(file));
  });

  it("only imports functions the JS glue provides", () => {
    const mod = new WebAssembly.Module(inlined);
    const missing = WebAssembly.Module.imports(mod)
      .filter((i) => i.module === "wbg" && !glue.includes(`imports.wbg.${i.name}`))
      .map((i) => i.name);
    expect(missing).toEqual([]);
  });
});
