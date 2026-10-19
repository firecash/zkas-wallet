import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * `run(name, task)` performs a desktop service action and then refreshes the page's state.
 * `refresh` deliberately rethrows — the page needs to tell a dead supervisor from a live one,
 * and its own comment explains why: "A failed poll used to write nothing and say nothing, so
 * the page kept presenting the last good reading as live: 'Synced', 6,229,623 blocks, 8 peers,
 * PID 9931, with Stop still enabled."
 *
 * But awaiting it inside `run`'s try meant a SUCCESSFUL action whose refresh then failed was
 * reported as a failed action. `startNode` does `if (started) setShowStart(false)`, so the
 * Start dialog stayed open with an error on it while the node was running — and the next click
 * answered "already running".
 *
 * The send path states the same principle: "A submit that never got an answer is NOT a failed
 * send — it is an unknown one."
 */
const src = readFileSync("src/pages/NodeRunner.tsx", "utf8");
const run = src.slice(src.indexOf("const run = async"), src.indexOf("const run = async") + 1600);

describe("a desktop action reports its own outcome", () => {
  it("returns the task's result, not the refresh's", () => {
    expect(run).toMatch(/let ok = false;/);
    expect(run).toMatch(/ok = true;/);
    // The refresh must not be able to flip it back.
    expect(run).toMatch(/await refresh\(\)\.catch\(\(\) => undefined\)/);
  });

  it("marks success BEFORE refreshing", () => {
    expect(run.indexOf("ok = true;")).toBeLessThan(run.indexOf("await refresh()"));
  });

  it("still surfaces a task failure", () => {
    expect(run).toMatch(/catch \(e\) \{\s*setError\(/);
    expect(run).toMatch(/return ok;/);
  });

  it("still clears busy whatever happens", () => {
    expect(run).toMatch(/finally \{\s*setBusy\(null\);/);
  });

  it("leaves refresh rethrowing, since the poll needs it", () => {
    // The staleness machinery depends on refresh throwing to its other caller.
    const refresh = src.slice(src.indexOf("const refresh = useCallback"));
    expect(refresh.slice(0, 1400)).toContain("setStale(true)");
    expect(refresh.slice(0, 1400)).toContain("throw e;");
  });
});
