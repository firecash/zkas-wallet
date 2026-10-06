// Shared harness: a jsdom environment that looks enough like a phone/browser for
// the wallet to run — WebCrypto, clipboard, camera-less navigator, matchMedia.
import "@testing-library/jest-dom/vitest";
import { webcrypto } from "node:crypto";
// The catalogue, loaded exactly where `main.tsx` loads it: once, up front.
//
// Without this, a UI test only has translations because SOME module in its
// import graph happened to pull in `src/i18n` transitively — and a test asserting
// on `"Configure"` then broke the moment an unrelated module stopped importing
// `api.ts`, rendering every label as a raw key. Which product file imports what
// is not a property any test should depend on.
import "../src/i18n";

if (!globalThis.crypto?.subtle) {
  Object.defineProperty(globalThis, "crypto", { value: webcrypto, configurable: true });
}
if (!("randomUUID" in globalThis.crypto)) {
  // @ts-expect-error test shim
  globalThis.crypto.randomUUID = () => Math.random().toString(16).slice(2);
}

Object.defineProperty(window, "matchMedia", {
  writable: true,
  value: (query: string) => ({
    matches: false,
    media: query,
    addEventListener: () => {},
    removeEventListener: () => {},
    addListener: () => {},
    removeListener: () => {},
    dispatchEvent: () => false,
  }),
});

Object.assign(navigator, {
  clipboard: { writeText: async () => {}, readText: async () => "" },
});

// jsdom has no layout engine; scrollIntoView is called on tab switches.
Element.prototype.scrollIntoView = () => {};
