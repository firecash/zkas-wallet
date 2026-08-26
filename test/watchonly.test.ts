// A watch-only wallet must be unable to spend BECAUSE it has no spending key,
// not because the UI hid a button. These pin that distinction.

import { describe, expect, it, beforeEach } from "vitest";
import { isViewKey, watchKey, setWatchKey, clearWatchKey, isWatchOnly, watchLink, viewKeyFromUrl } from "../src/lib/watchonly";

const FVK = "ab".repeat(96);          // 96 bytes = 192 hex
const SEED = "cd".repeat(32);         // 32 bytes = 64 hex

beforeEach(() => {
  localStorage.clear();
  localStorage.setItem("wallet_token", "tok1");
  location.hash = "#/";
});

describe("view keys", () => {
  it("accepts a 96-byte key and rejects everything else", () => {
    expect(isViewKey(FVK)).toBe(true);
    expect(isViewKey(FVK.toUpperCase())).toBe(true);
    expect(isViewKey(SEED)).toBe(false);              // a seed is not a view key
    expect(isViewKey(FVK.slice(0, 190))).toBe(false);
    expect(isViewKey(`${FVK}ab`)).toBe(false);
    expect(isViewKey("zz".repeat(96))).toBe(false);   // not hex
    expect(isViewKey("")).toBe(false);
  });

  it("refuses to store anything that is not a view key", () => {
    expect(() => setWatchKey(SEED)).toThrow();
    expect(watchKey()).toBe("");
  });

  it("keeps one key per wallet, like the seed does", () => {
    setWatchKey(FVK);
    expect(watchKey()).toBe(FVK);
    localStorage.setItem("wallet_token", "tok2");
    expect(watchKey()).toBe("");
    localStorage.setItem("wallet_token", "tok1");
    expect(watchKey()).toBe(FVK);
  });
});

describe("what makes a device watch-only", () => {
  it("is the ABSENCE of a seed, not the presence of a view key", () => {
    setWatchKey(FVK);
    expect(isWatchOnly()).toBe(true);
    // A full wallet that also knows its own view key can still spend.
    localStorage.setItem("device_seed_tok1", SEED);
    expect(isWatchOnly()).toBe(false);
  });

  it("is false for an ordinary wallet with no view key at all", () => {
    localStorage.setItem("device_seed_tok1", SEED);
    expect(isWatchOnly()).toBe(false);
  });

  it("stops being watch-only once the key is cleared", () => {
    setWatchKey(FVK);
    clearWatchKey();
    expect(isWatchOnly()).toBe(false);
  });
});

describe("the sharing link", () => {
  it("puts the key in the fragment, which never reaches the server", () => {
    const url = watchLink(FVK);
    const [before, fragment] = url.split("#");
    expect(before).not.toContain(FVK);   // nothing before the # — no server sees it
    expect(fragment).toContain(FVK);
  });

  it("refuses to build a link around anything but a view key", () => {
    expect(() => watchLink(SEED)).toThrow();
  });

  it("reads a key back out of the URL, and ignores junk", () => {
    location.hash = `#/watch?key=${FVK}`;
    expect(viewKeyFromUrl()).toBe(FVK);
    location.hash = `#/watch?key=${SEED}`;
    expect(viewKeyFromUrl()).toBe("");
    location.hash = "#/watch";
    expect(viewKeyFromUrl()).toBe("");
  });
});
