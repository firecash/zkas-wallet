import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";

// The Arriving row must survive the moment the payment settles until the history list
// includes it: it vanished for ~3-12 s in two tracked real payments (2 Nov).
const app = readFileSync("src/App.tsx", "utf8");

describe("the Arriving row is held until its history row has loaded", () => {
  it("times the hold from when the amount went to zero", () => {
    const i = app.indexOf("const heldArriving = useRef<");
    const block = app.slice(i, i + 700);
    expect(block).toContain("goneAt ??= Date.now()");
    expect(block).toMatch(/rowCount > heldArriving\.current\.rows \|\| Date\.now\(\) - heldArriving\.current\.goneAt > 30_000/);
    // And the held amount is what History shows.
    expect(app).toContain("arrivingZkas = arrivingZkas > 0 ? arrivingZkas : (heldArriving.current?.amount ?? 0);");
  });
});
