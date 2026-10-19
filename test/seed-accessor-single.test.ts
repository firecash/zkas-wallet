import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * `getDeviceSeed` and `setDeviceSeed` each existed TWICE, in App.tsx and lib/deviceseed.ts,
 * with the same logic and different safety:
 *
 *   getDeviceSeed — the lib reads through `readSeed`, which catches the throw a BLOCKED store
 *     raises on every access (and deliberately skips safestore's session fallback, since a
 *     spending key must not live somewhere that empties on reload). App.tsx used a bare
 *     `localStorage.getItem`, and App.tsx's was the one called from render and the status
 *     poll. Same class as the `bgSyncEnabled` fix: "a bare accessor takes the settings row
 *     down on a browser with site data blocked".
 *
 *   setDeviceSeed — App.tsx's has `.catch(fallback)`; the lib's had only `.then`. That one was
 *     not dead: `resolveDeviceSeed` calls it on the orphan-recovery path, so on a full store
 *     the seal rejected and the rescued seed was persisted NOWHERE — a working key for one
 *     call, gone on reload.
 *
 * The file already says this is the rule, for the duplicates fixed before these two:
 * "SEED_REQUIRED and resolveDeviceSeed — ONE implementation, in ./lib/deviceseed."
 */
const APP = readFileSync("src/App.tsx", "utf8");
const LIB = readFileSync("src/lib/deviceseed.ts", "utf8");

describe("one implementation of each seed accessor", () => {
  it("defines each exactly once, in the lib", () => {
    for (const fn of ["getDeviceSeed", "setDeviceSeed"]) {
      expect(LIB, `${fn} belongs in lib/deviceseed`).toContain(`export function ${fn}`);
      expect(APP, `${fn} must not be redefined in App.tsx`).not.toContain(`export function ${fn}`);
    }
  });

  it("still exports both from App.tsx for its own call sites", () => {
    // Deleting the re-export would break the many callers in that file and the existing
    // seal-failure test, which imports setDeviceSeed from ../src/App.
    expect(APP).toContain("export { getDeviceSeed };");
    expect(APP).toContain("export { setDeviceSeed };");
    expect(APP).toMatch(/import \{[^}]*getDeviceSeed[^}]*\} from "\.\/lib\/deviceseed"/s);
  });

  it("reads the seed through the guarded reader, never a bare getItem", () => {
    const get = LIB.slice(LIB.indexOf("export function getDeviceSeed"));
    const body = get.slice(0, get.indexOf("\n}") + 2);
    expect(body).toContain("readSeed(");
    expect(body).not.toContain("localStorage.getItem");
  });

  it("keeps the fallback on BOTH a false result and a rejection", () => {
    const set = LIB.slice(LIB.indexOf("export function setDeviceSeed"));
    const body = set.slice(0, set.indexOf("\n}") + 2);
    expect(body).toContain("if (!ok) fallback();");
    expect(body).toContain(".catch(fallback)");
  });

  it("the orphan-recovery path still persists what it rescued", () => {
    // The call that made the buggy copy reachable; it must keep writing the seed home.
    const resolve = LIB.slice(LIB.indexOf("export async function resolveDeviceSeed"));
    expect(resolve.slice(0, resolve.indexOf("\n}") + 2)).toContain("setDeviceSeed(orphan)");
  });
});
