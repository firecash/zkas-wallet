import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * The explorer's block and transaction views fetch on `[id]`, which comes from the route. So a
 * second request starts whenever the user follows a link — "selected parent" on a block, or a
 * transaction from a list — while the first may still be open.
 *
 * Without a liveness flag the answers are applied in ARRIVAL order, not request order: if the
 * earlier one is slower, the later view renders and is then overwritten, leaving one block's
 * contents displayed under another block's hash. DetailShell is passed `id`, so the heading
 * and the body would disagree — in the page someone opens to check a payment.
 *
 * React 18 makes a post-unmount setState a no-op, so this is not about leaks. It is about
 * which answer wins.
 */
const src = readFileSync("src/pages/Explorer.tsx", "utf8");

function effectAt(marker: string): string {
  const i = src.indexOf(marker);
  expect(i, `missing ${marker}`).toBeGreaterThan(0);
  const start = src.lastIndexOf("useEffect(", i);
  return src.slice(start, i + 400);
}

describe("an explorer detail view shows the id it was asked for", () => {
  for (const [name, marker] of [["block", "explorerApi\n      .block(id)"], ["transaction", "explorerApi\n      .transaction(id)"]] as const) {
    it(`${name}: applies a result only while it is still the current id`, () => {
      const body = effectAt(marker);
      expect(body).toContain("let live = true;");
      expect(body).toMatch(/if \(live\) set/);
      expect(body).toContain("live = false;");
    });

    it(`${name}: guards the error path too, not just the success path`, () => {
      // A stale ERROR overwriting a good view is the same bug wearing a different hat.
      const body = effectAt(marker);
      const catchAt = body.indexOf(".catch(");
      expect(catchAt).toBeGreaterThan(0);
      expect(body.slice(catchAt)).toMatch(/if \(live\) setError/);
    });

    it(`${name}: still clears the previous view immediately`, () => {
      // Clearing must NOT be behind the flag: the old content has to go the moment the id
      // changes, or the previous block stays on screen while the new one loads.
      const body = effectAt(marker);
      const clear = body.search(/set(Block|Tx)\(null\)/);
      expect(clear).toBeGreaterThan(0);
      expect(clear).toBeLessThan(body.indexOf("explorerApi"));
    });
  }
});
