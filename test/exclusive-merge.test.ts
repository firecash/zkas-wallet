import { describe, expect, it } from "vitest";
import { exclusiveMerge, mergeInFlight } from "../src/useMaintenance";

// A user-started merge and the background one never run at once: each picked the same notes
// and the second was refused by the node as a double spend (3 Nov). A payment waits for either.
describe("exclusive merges", () => {
  it("shows a user-started merge as in flight while it runs, and clears it after", async () => {
    expect(mergeInFlight()).toBeNull();
    let finish!: () => void;
    const running = exclusiveMerge(() => new Promise<string>((r) => (finish = () => r("done"))));
    await Promise.resolve();
    expect(mergeInFlight()).not.toBeNull();
    finish();
    await expect(running).resolves.toBe("done");
    expect(mergeInFlight()).toBeNull();
  });

  it("clears it after a failure too, and passes the failure on", async () => {
    await expect(exclusiveMerge(() => Promise.reject(new Error("refused")))).rejects.toThrow("refused");
    expect(mergeInFlight()).toBeNull();
  });

  it("runs two user-started merges one after the other", async () => {
    const order: string[] = [];
    let finishFirst!: () => void;
    const first = exclusiveMerge(async () => {
      order.push("first start");
      await new Promise<void>((r) => (finishFirst = r));
      order.push("first end");
    });
    await Promise.resolve();
    finishFirst();
    await first;
    await exclusiveMerge(async () => order.push("second"));
    expect(order).toEqual(["first start", "first end", "second"]);
  });
});
