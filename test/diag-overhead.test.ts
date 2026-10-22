import { describe, expect, it } from "vitest";
import { event, flush, installSink, resetForTests, selfStats, setLevel } from "../src/diag/log";
import { setSalt } from "../src/diag/redact";

/**
 * The budget is < 1% CPU and nothing blocking on the main thread. A logging call must be a
 * few microseconds: at normal level the app records a few hundred events a minute, so even
 * 50 µs each would be ~0.02% of one core. Measured here with realistic field shapes —
 * including the ones that exercise every redaction rule — so a slow regex shows up as a
 * failure, not as a sluggish phone.
 */
describe("logger overhead", () => {
  it("costs well under 50 µs per event, redaction included", async () => {
    resetForTests();
    setSalt("55".repeat(16));
    setLevel("normal");
    let written = 0;
    installSink({ append: async (lines) => { written += lines.length; } });
    const N = 20_000;
    const t0 = performance.now();
    for (let i = 0; i < N; i++) {
      event("net", "req", {
        kind: "api",
        method: "GET",
        path: "/api/status",
        host_class: "loopback",
        route: "engine",
        status: 200,
        outcome: "ok",
        bytes: 812,
        note_line: i % 10 === 0 ? `tx 35dd94a1d8d20d8b19e1b70531f105736071876945f04b2028d5b97fdeff43ff to zkas:py82h42m9qjff0knpcmllzq3c7qhurje5auh4tq2ceagf69wjpf23djwwmqr26zhsua8rrglrwdltsh of 1.5 ZKAS` : "plain words only",
      }, { dur: 12.3 });
    }
    const perEventUs = ((performance.now() - t0) * 1000) / N;
    await flush();
    console.info(`[diag-overhead] ${perEventUs.toFixed(2)} µs/event over ${N} events; flushed ${written}; self ${JSON.stringify(selfStats())}`);
    expect(perEventUs).toBeLessThan(50);
    expect(written).toBeGreaterThan(0);
  });
});
