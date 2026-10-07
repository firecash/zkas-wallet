import { describe, it, expect } from "vitest";
import i18n from "../src/i18n";
import { EN } from "../src/i18n/index";

// Strings get added in English first and translated later. The one thing that
// must never happen in between is a non-English user seeing `daemonError.network`
// where a sentence belongs. `fallbackLng: "en"` is what prevents it; this is the
// test that notices if that ever changes.
function leafKeys(obj: unknown, prefix = ""): string[] {
  if (typeof obj !== "object" || obj === null) return [];
  return Object.entries(obj as Record<string, unknown>).flatMap(([k, v]) => {
    const path = prefix ? `${prefix}.${k}` : k;
    return typeof v === "string" ? [path] : leafKeys(v, path);
  });
}

describe("i18n fallback", () => {
  it("never shows a raw key to a user whose locale lacks the string", async () => {
    const keys = leafKeys(EN);
    expect(keys.length).toBeGreaterThan(200);
    // Negative control: a key that exists nowhere MUST come back as itself, or
    // the assertion below would pass no matter what and prove nothing.
    await i18n.changeLanguage("fr");
    expect(i18n.t("thisKey.doesNotExist.anywhere")).toBe("thisKey.doesNotExist.anywhere");
    for (const lng of ["fr", "ar", "zh-CN"]) {
      await i18n.changeLanguage(lng);
      const leaked = keys.filter((k) => i18n.t(k, { n: 1, count: 1 }) === k);
      expect(leaked, `${lng} leaked ${leaked.length} keys, e.g. ${leaked.slice(0, 5).join(", ")}`).toEqual([]);
    }
    await i18n.changeLanguage("en");
  });
});
