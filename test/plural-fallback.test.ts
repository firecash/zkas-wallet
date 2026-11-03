import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import i18n, { applyLanguage } from "../src/i18n";

// A plural form a language lacks falls back to ENGLISH unless the language has an `_other` to
// borrow (fillPluralForms). "N notes · manage" had only a plain key in every language, so it
// showed in English everywhere; and the borrowed `_other` gave Russian, Ukrainian, Polish and
// Arabic the wrong grammatical form for 2-4 / 5+ ("2 подтверждений"). Every form is written now.
const flat = (d: Record<string, unknown>, p = "", out: Record<string, unknown> = {}) => {
  for (const [k, v] of Object.entries(d)) {
    if (v && typeof v === "object") flat(v as Record<string, unknown>, p + k + ".", out);
    else out[p + k] = v;
  }
  return out;
};

describe("plural forms", () => {
  it("every plural key has every form each language uses", () => {
    const en: Record<string, unknown> = {};
    for (const f of fs.readdirSync("src/i18n/en")) Object.assign(en, flat(JSON.parse(fs.readFileSync(path.join("src/i18n/en", f), "utf8"))));
    const bases = [...new Set(Object.keys(en).filter((k) => /_(one|other)$/.test(k)).map((k) => k.replace(/_(one|other)$/, "")))];
    const gaps: string[] = [];
    for (const f of fs.readdirSync("src/i18n/locales").filter((f) => !f.startsWith("."))) {
      const lng = f.replace(/\.json$/, "");
      const d = flat(JSON.parse(fs.readFileSync(path.join("src/i18n/locales", f), "utf8")));
      for (const c of new Intl.PluralRules(lng).resolvedOptions().pluralCategories) {
        for (const b of bases) if (d[`${b}_${c}`] === undefined) gaps.push(`${lng} ${b}_${c}`);
      }
    }
    expect(gaps).toEqual([]);
  });

  const cases: [string, number, string, RegExp][] = [
    ["de", 5, "app.notesManage", /notes|manage/],
    ["ru", 2, "status.aboutMinutes", /minute/],
    ["ru", 5, "txDetail.confirmations", /confirmation/],
    ["pl", 5, "walletCountLabel.wallets", /wallet/],
    ["ar", 12, "status.aboutHours", /hour/],
  ];
  for (const [lng, count, key, english] of cases) {
    it(`${key} with ${count} is not English in ${lng}`, async () => {
      await applyLanguage(lng);
      expect(i18n.t(key, { count, n: count, from: 1, notes: 1, round: 1, payees: 1, amount: 1 })).not.toMatch(english);
    });
  }
});
