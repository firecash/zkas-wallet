import { describe, expect, it } from "vitest";
import i18n from "../src/i18n";

/**
 * The note count sits on a chip under the balance. It used to be the detail line of a
 * grid button whose LABEL supplied the noun, so "{{n}} · manage" read fine underneath
 * the word "Notes". On its own it rendered as "2 · manage" — a number, a dot, and a
 * verb, naming nothing.
 *
 * So the string has to carry its own noun, and therefore has to pluralise.
 */
describe("the notes chip reads as words, not a bare count", () => {
  it("names the unit and pluralises it", async () => {
    await i18n.changeLanguage("en");
    expect(i18n.t("app.notesManage", { count: 1, n: 1 })).toBe("1 note · manage");
    expect(i18n.t("app.notesManage", { count: 2, n: 2 })).toBe("2 notes · manage");
    expect(i18n.t("app.notesManage", { count: 17, n: 17 })).toBe("17 notes · manage");
  });
});
