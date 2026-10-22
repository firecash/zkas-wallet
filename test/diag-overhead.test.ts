import { describe, expect, it } from "vitest";
import { event, flush, installSink, resetForTests, selfStats, setLevel } from "../src/diag/log";
import { setSalt } from "../src/diag/redact";
import { isMainThread } from "node:worker_threads";

/**
 * The budget is < 1% CPU and nothing blocking on the main thread. A logging call must be a
 * few microseconds: at normal level the app records a few hundred events a minute, so even
 * 50 µs each would be ~0.02% of one core. Measured here with realistic field shapes —
 * including the ones that exercise every redaction rule — so a slow regex shows up as a
 * failure, not as a sluggish phone.
 */
describe("logger overhead", () => {
  // Measured as CPU TIME of this test process (vitest 2 runs each file in its own forked
  // process), not wall time. Wall time charged the logger for every other process on the box:
  // on the build host at load 38–50 the full suite read 180 µs/event while the same code
  // alone read 34–40 µs. CPU time does not move with load, so the 50 µs budget still catches
  // a slow regex — and the median of several batches keeps one GC pause from deciding it.
  it("costs well under 50 µs of CPU per event, redaction included", async () => {
    resetForTests();
    setSalt("55".repeat(16));
    setLevel("normal");
    let written = 0;
    installSink({ append: async (lines) => { written += lines.length; } });
    const BATCHES = 5;
    const N = 4_000;
    const shape = (i: number) => ({
      kind: "api",
      method: "GET",
      path: "/api/status",
      host_class: "loopback",
      route: "engine",
      status: 200,
      outcome: "ok",
      bytes: 812,
      note_line: i % 10 === 0 ? `tx 35dd94a1d8d20d8b19e1b70531f105736071876945f04b2028d5b97fdeff43ff to zkas:py82h42m9qjff0knpcmllzq3c7qhurje5auh4tq2ceagf69wjpf23djwwmqr26zhsua8rrglrwdltsh of 1.5 ZKAS` : "plain words only",
    });
    // In a worker THREAD process.cpuUsage() would count the other workers too; only the fork
    // pool gives this file a process of its own. Fall back to wall time (median) otherwise.
    const ownProcess = isMainThread;
    const cpuUs = () => { const u = process.cpuUsage(); return u.user + u.system; };
    const perEvent: number[] = [];
    const wallPerEvent: number[] = [];
    for (let b = 0; b < BATCHES; b++) {
      const c0 = cpuUs();
      const t0 = performance.now();
      for (let i = 0; i < N; i++) event("net", "req", shape(i), { dur: 12.3 });
      wallPerEvent.push(((performance.now() - t0) * 1000) / N);
      perEvent.push((cpuUs() - c0) / N);
    }
    const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];
    const cpu = median(perEvent);
    const wall = median(wallPerEvent);
    await flush();
    console.info(`[diag-overhead] cpu ${cpu.toFixed(2)} µs/event (median of ${BATCHES}×${N}), wall ${wall.toFixed(2)} µs/event, own process ${ownProcess}; flushed ${written}; self ${JSON.stringify(selfStats())}`);
    expect(ownProcess ? cpu : wall).toBeLessThan(50);
    // The measurement must be real: a CPU clock that did not move would pass anything.
    expect(cpu).toBeGreaterThan(0);
    expect(written).toBeGreaterThan(0);
  });
});
