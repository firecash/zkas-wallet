import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// Below 900px the wallet keeps only History and the gear in its tab row (and below 620px
// hides it), so Signatures and Wallet tools had no way in on a phone, and a guard reset any
// other tab to History, which also undid every route that tried. They open from Settings now,
// with their own way back, and the guard keeps them.
const app = readFileSync("src/App.tsx", "utf8");
const css = readFileSync("src/styles.css", "utf8");

describe("Signatures and Wallet tools on a phone", () => {
  it("Settings reaches both: Wallet tools by a link (not on native), Signatures by its own card", () => {
    expect(app).toContain('{!viewOnly && !isNative() && <SettingsLink className="phone-only" title={t("walletTools.eyebrow")} to="tools" />}');
    // Exactly one Signatures entry in Settings on narrow screens (a second one duplicated it).
    expect(app).toMatch(/\{!roomy && \(\s*<Collapsible title=\{t\("settingsPane\.signatures"\)\}>\s*<Signatures status=\{status\} \/>/);
    expect(app).not.toContain('to="signatures"');
  });

  it("the narrow-screen guard keeps a pane opened that way", () => {
    const i = app.indexOf("const reachable: Tab[] = roomy ? tabs :");
    expect(i).toBeGreaterThan(0);
    expect(app.slice(i, i + 300)).toMatch(/"signatures"[\s\S]*"tools"[\s\S]*!reachable\.includes\(tab\)\) setTab\("history"\)/);
  });

  it("both panes carry a way back, shown exactly where the row lacks them", () => {
    expect(app.match(/<PhoneBackToWallet onBack=\{\(\) => setTab\("history"\)\} \/>/g)?.length).toBe(2);
    expect(app).toContain('const ROOMY_QUERY = "(min-width: 900px)"');
    expect(css).toMatch(/@media \(max-width: 899\.98px\) \{\s*\.app-shell:not\(\.desktop-shell\) \.phone-only \{ display: revert; \}/);
    expect(css).toMatch(/\.phone-only \{ display: none; \}/);
  });
});
