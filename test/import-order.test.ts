import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

// The import and restore flows both used to write the seed to the device BEFORE
// anything validated it. `fvkHex` is the validator — it throws on a bad BIP39
// checksum — so one mistyped word left a stored secret for a wallet that was
// never registered: the app believed a wallet existed, "Create new wallet" went
// unreachable, and the typed phrase sat in storage in the clear.
const src = readFileSync(resolve(process.cwd(), "src/App.tsx"), "utf8");

function body(name: string): string {
  const i = src.indexOf(`const ${name} = async`);
  expect(i, `${name} not found`).toBeGreaterThan(-1);
  return src.slice(i, i + 2200);
}

describe("a seed is validated before it is stored", () => {
  for (const [flow, seed] of [["doImport", "seed"], ["doRestoreFile", "seedHex"]] as const) {
    it(`${flow} derives the viewing key before persisting`, () => {
      const b = body(flow);
      const derive = b.indexOf("await fvkHex(");
      const persist = b.indexOf("persistDeviceSeed(");
      expect(derive, "no fvkHex call").toBeGreaterThan(-1);
      expect(persist, "no persistDeviceSeed call").toBeGreaterThan(-1);
      expect(derive, `${flow} stores ${seed} before validating it`).toBeLessThan(persist);
    });

    it(`${flow} drops the stored seed if registration fails`, () => {
      expect(body(flow)).toContain("localStorage.removeItem(`device_seed_");
    });
  }

  it("doImport reports a bare-string throw instead of an empty box", () => {
    // The signer throws a bare string for a bad phrase, so `.message` was
    // undefined and the error box rendered blank.
    const b = body("doImport");
    expect(b).toContain("setError(failureText(e))");
    expect(b).not.toContain("setError((e as Error).message)");
  });

  it("the seed textarea is not autocompleted, corrected or spellchecked", () => {
    const i = src.indexOf("<textarea value={importHex}");
    const tag = src.slice(i, src.indexOf(">", i));
    expect(tag).toContain('autoComplete="off"');
    expect(tag).toContain('autoCorrect="off"');
    expect(tag).toContain('autoCapitalize="off"');
    expect(tag).toContain("spellCheck={false}");
  });
});
