import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ACTION_WINDOW_MS, beginAction, currentAction, event, flush, installSink, recent, resetForTests, selfStats, setLevel, span } from "../src/diag/log";
import { setSalt } from "../src/diag/redact";
import { claimSignal, flushNetSummary, installFetchWrapper, ipcCommand, recordRequest, uninstallFetchWrapper } from "../src/diag/net";
import { ingestEngineText, observePollFailure, observeStatus, parseEngineMessage, resetSyncForTests, rustDurationMs, splitEngineLine } from "../src/diag/sync";
import { resetScreensForTests, screenChanged } from "../src/diag/screens";
import { summarize } from "../src/diag/summary";
import type { Status } from "../src/api";

function evs(cat?: string, ev?: string) {
  return recent().filter((e) => (!cat || e.cat === cat) && (!ev || e.ev === ev));
}

beforeEach(() => {
  resetForTests();
  resetSyncForTests();
  resetScreensForTests();
  setSalt("44".repeat(16));
});
afterEach(() => {
  uninstallFetchWrapper();
  vi.useRealTimers();
});

describe("levels", () => {
  it("off records nothing; verbose-only events need verbose", () => {
    setLevel("off");
    event("ui", "tap", { id: "x" });
    expect(evs("ui").length).toBe(0);
    setLevel("normal");
    event("perf", "frames", {}, { verbose: true });
    expect(evs("perf").length).toBe(0);
    setLevel("verbose");
    event("perf", "frames", {}, { verbose: true });
    expect(evs("perf").length).toBe(1);
  });

  it("records the level change itself, on both sides of off", () => {
    setLevel("off");
    setLevel("verbose");
    const changes = evs("app", "level");
    expect(changes.map((e) => [e.prev, e.next])).toEqual([["normal", "off"], ["off", "verbose"]]);
  });

  it("the envelope cannot be overwritten by a field", () => {
    event("x", "y", { seq: 999, cat: "evil", t: "never", lvl: "debug" });
    const e = evs("x", "y")[0];
    expect(e.seq).not.toBe(999);
    expect(e.cat).toBe("x");
  });
});

describe("the sink", () => {
  it("batches writes off the calling path and drains everything", async () => {
    const got: string[][] = [];
    installSink({ append: async (lines) => { got.push(lines); } });
    for (let i = 0; i < 10; i++) event("t", "e", { i });
    expect(got.length).toBe(0); // nothing written synchronously
    await flush();
    expect(got.flat().length).toBe(10);
    for (const line of got.flat()) expect(() => JSON.parse(line)).not.toThrow();
  });

  it("a failing sink keeps the lines for the next attempt", async () => {
    let fail = true;
    const got: string[] = [];
    installSink({ append: async (lines) => { if (fail) throw new Error("disk full"); got.push(...lines); } });
    event("t", "a");
    await flush();
    expect(selfStats().sinkErrors).toBe(1);
    fail = false;
    event("t", "b");
    await flush();
    expect(got.map((l) => JSON.parse(l).ev)).toEqual(["a", "b"]);
  });

  it("events before the platform answers are kept for it", async () => {
    event("app", "early");
    const got: string[] = [];
    installSink({ append: async (lines) => { got.push(...lines); } });
    await flush();
    expect(got.some((l) => l.includes('"early"'))).toBe(true);
  });

  it("the web (no sink) keeps the ring only", () => {
    installSink(null);
    event("app", "x");
    expect(recent().length).toBe(1);
    expect(selfStats().queued).toBe(0);
  });
});

describe("correlation", () => {
  it("work started inside an action's window carries its id; after the window it does not", () => {
    vi.useFakeTimers({ toFake: ["performance"] });
    const id = beginAction("tap", "send");
    event("net", "req", { path: "/api/wallet/prepare" });
    expect(evs("net")[0].aid).toBe(id);
    vi.advanceTimersByTime(ACTION_WINDOW_MS + 10);
    expect(currentAction()).toBeNull();
    event("net", "req", { path: "/api/status" });
    expect(evs("net")[1].aid).toBeUndefined();
  });

  it("a screen that renders after a tap records tap-to-commit and paint", async () => {
    beginAction("tap", "explore");
    screenChanged("explore");
    await new Promise((r) => setTimeout(r, 1_600));
    const s = evs("nav", "screen")[0];
    expect(s.screen).toBe("explore");
    expect(typeof s.since_tap).toBe("number");
    expect(s.cause).toBe("tap");
    expect(s.aid).toBeDefined();
  });

  it("span measures duration", async () => {
    const sp = span("send", "prepare", { part: 1 });
    await new Promise((r) => setTimeout(r, 20));
    sp.end({ spends: 2 });
    const e = evs("send", "prepare")[0];
    expect(e.dur).toBeGreaterThanOrEqual(15);
    expect(e.spends).toBe(2);
  });
});

describe("network observer", () => {
  it("the fetch wrapper forwards the identical call and returns the identical result", async () => {
    const response = new Response("{}", { status: 200 });
    const inner = vi.fn(async () => response);
    globalThis.fetch = inner as unknown as typeof fetch;
    installFetchWrapper();
    const init = { method: "POST", headers: { "X-A": "1" }, body: "x" };
    const got = await fetch("https://wallet.zkas.info/chain/info", init);
    expect(got).toBe(response);
    expect(inner).toHaveBeenCalledTimes(1);
    expect(inner.mock.calls[0]).toEqual(["https://wallet.zkas.info/chain/info", init]);
    // Nothing was added to the request.
    expect(init).toEqual({ method: "POST", headers: { "X-A": "1" }, body: "x" });
    expect(evs("net", "req")[0].path).toBe("/chain/info");
  });

  it("a rejection reaches the caller unchanged", async () => {
    const boom = new TypeError("Failed to fetch");
    globalThis.fetch = vi.fn(async () => { throw boom; }) as unknown as typeof fetch;
    installFetchWrapper();
    await expect(fetch("https://x.example/a")).rejects.toBe(boom);
    await new Promise((r) => setTimeout(r, 0));
    expect(evs("net", "req")[0].outcome).toBe("unreachable");
  });

  it("requests the wallet API claims are not double-counted", async () => {
    globalThis.fetch = vi.fn(async () => new Response("{}")) as unknown as typeof fetch;
    installFetchWrapper();
    const ctl = new AbortController();
    claimSignal(ctl.signal);
    await fetch("http://127.0.0.1:1234/api/status", { signal: ctl.signal });
    expect(evs("net").length).toBe(0);
  });

  it("Tauri IPC over fetch is recorded as IPC, and the log's own plumbing never records itself", async () => {
    // Found in the first real desktop run: WebKitGTK routes IPC through fetch, so every
    // diag_append flush logged a request, which the next flush wrote, forever.
    globalThis.fetch = vi.fn(async () => new Response("{}")) as unknown as typeof fetch;
    installFetchWrapper();
    await fetch("ipc://localhost/diag_append", { method: "POST" });
    await fetch("http://ipc.localhost/wallet_api_request", { method: "POST" });
    await fetch("ipc://localhost/vault_status", { method: "POST" });
    await fetch("ipc://localhost/plugin%3Aevent%7Clisten", { method: "POST" });
    await new Promise((r) => setTimeout(r, 0));
    const ipc = evs("net", "ipc");
    expect(ipc.map((e) => e.cmd)).toEqual(["vault_status"]);
    expect(evs("net", "req").length).toBe(0);
    expect(ipcCommand("ipc://localhost/plugin%3Aevent%7Clisten")).toBe("plugin:event|listen");
    expect(ipcCommand("https://wallet.zkas.info/x")).toBeNull();
  });

  it("polls fold into a per-minute summary at normal level", () => {
    for (let i = 0; i < 30; i++) recordRequest({ kind: "api", method: "GET", path: "/api/status", status: 200, ms: 10 + i, outcome: "ok", host: "loopback" });
    // The first of its kind is recorded individually, the rest are summarised.
    expect(evs("net", "req").length).toBe(1);
    flushNetSummary();
    const s = evs("net", "summary")[0];
    expect(s.n).toBe(30);
    expect(s.p95).toBeGreaterThanOrEqual(37);
    expect(s.errors).toBe(0);
  });

  it("failures and slow requests are always individual", () => {
    recordRequest({ kind: "api", method: "GET", path: "/api/status", status: 200, ms: 10, outcome: "ok" });
    recordRequest({ kind: "api", method: "GET", path: "/api/status", ms: 4000, outcome: "timeout" });
    recordRequest({ kind: "api", method: "GET", path: "/api/status", status: 200, ms: 5000, outcome: "ok" });
    expect(evs("net", "req").length).toBe(3);
    expect(evs("net", "req")[1].lvl).toBe("error");
  });
});

describe("engine lines", () => {
  const SCAN = "scan cost so far: decrypt 1234 ms (12%) over 56789 actions = 21.7 us/action | tree 9000 ms (88%) over 400000 leaves = 22.5 us/leaf";
  const TREE = "  tree split: mirror 6000 ms (15.0 us/leaf, borrowable) | subtree cache 3000 ms (7.5 us/leaf, buys spend speed)";
  const PIPE = "page pipeline: fetch 90000 ms (1800 ms/page) | ingest 5000 ms (100 ms/page) | 50 pages -> fetch is 94% of the two";
  const CONT = "page contents: 2500 actions over 50 pages = 50 actions/page";

  it("parses the engine's scan-cost lines into numbers", () => {
    expect(parseEngineMessage(SCAN)).toEqual({ ev: "scan_cost", fields: { decrypt_ms: 1234, decrypt_pct: 12, actions: 56789, us_per_action: 21.7, tree_ms: 9000, tree_pct: 88, leaves: 400000, us_per_leaf: 22.5 } });
    expect(parseEngineMessage(TREE)?.fields).toEqual({ mirror_ms: 6000, mirror_us_per_leaf: 15, subtree_ms: 3000, subtree_us_per_leaf: 7.5 });
    expect(parseEngineMessage(PIPE)?.fields).toEqual({ fetch_ms: 90000, fetch_ms_per_page: 1800, ingest_ms: 5000, ingest_ms_per_page: 100, pages: 50, fetch_pct: 94 });
    expect(parseEngineMessage(CONT)?.fields).toEqual({ actions: 2500, pages: 50, actions_per_page: 50 });
    expect(parseEngineMessage("prepare: Halo2 proof took 5.2s")?.fields).toEqual({ what: "halo2_proof", ms: 5200 });
    expect(parseEngineMessage("send: tx 1/2 proven in 812ms")?.fields).toEqual({ what: "send_tx_proven", part: 1, parts: 2, ms: 812 });
    expect(rustDurationMs("17µs")).toBeCloseTo(0.017);
  });

  it("splits both engines' line formats", () => {
    expect(splitEngineLine("1729600000 [INFO] zkas_walletd::sync: hello")).toEqual({ level: "INFO", target: "sync", msg: "hello" });
    expect(splitEngineLine("1729600000000 [WARN lib] hi there")).toEqual({ level: "WARN", target: "lib", msg: "hi there" });
  });

  it("records only new lines across polls, and says when the ring wrapped", () => {
    setLevel("verbose");
    const a = "1 [INFO] zkas_walletd: one";
    const b = "2 [INFO] zkas_walletd: two";
    const c = "3 [INFO] zkas_walletd: three";
    expect(ingestEngineText([a, b].join("\n"), "android")).toBe(2);
    expect(ingestEngineText([a, b].join("\n"), "android")).toBe(0);
    expect(ingestEngineText([a, b, c].join("\n"), "android")).toBe(1);
    ingestEngineText(["9 [INFO] zkas_walletd: x", "10 [INFO] zkas_walletd: y"].join("\n"), "android");
    expect(evs("engine", "gap").length).toBe(1);
  });

  it("emits structured sync events alongside the line", () => {
    ingestEngineText(`5 [INFO] zkas_walletd: ${SCAN}\n6 [INFO] zkas_walletd: ${PIPE}`, "android");
    expect(evs("sync", "scan_cost")[0].us_per_action).toBe(21.7);
    expect(evs("sync", "page_pipeline")[0].fetch_pct).toBe(94);
    expect(evs("engine", "line").length).toBe(2);
  });

  it("rate-limits chatty INFO lines at normal level but never warnings", () => {
    const lines: string[] = [];
    for (let i = 0; i < 150; i++) lines.push(`${i} [INFO] zkas_walletd: chatter ${i}`);
    lines.push("999 [WARN] zkas_walletd: something wrong");
    ingestEngineText(lines.join("\n"), "android");
    const recorded = evs("engine", "line");
    expect(recorded.length).toBeLessThanOrEqual(61);
    expect(recorded.some((e) => e.level === "warn")).toBe(true);
  });
});

describe("sync story", () => {
  const base: Status = {
    has_wallet: true, address: "zkas:x", network: "mainnet", daa_score: 1000, synced: false, scanned_blocks: 100, chain_len: 1000,
    balance_sompi: "0", balance_fc: "0", note_count: 3, updated_unix: 0, error: null,
  };

  it("records state transitions, progress and the moment it synced", () => {
    observeStatus({ ...base, loading: true });
    observeStatus({ ...base });
    observeStatus({ ...base, scanned_blocks: 1000, synced: true });
    const states = evs("sync", "state").map((e) => e.state);
    expect(states).toEqual(["loading", "syncing", "synced"]);
    expect(evs("sync", "synced").length).toBe(1);
    expect(evs("sync", "progress").length).toBeGreaterThanOrEqual(1);
    // No balance in the progress record.
    expect(JSON.stringify(evs("sync"))).not.toMatch(/balance/);
  });

  it("records poll failures as a streak and the recovery", () => {
    for (let i = 0; i < 5; i++) observePollFailure("timeout");
    expect(evs("sync", "state").pop()?.state).toBe("unreachable");
    observeStatus(base);
    expect(evs("sync", "poll_recovered")[0].failures).toBe(5);
  });
});

describe("taps", () => {
  it("a plain-word button keeps its label through the redactor (found blanked in a real run)", async () => {
    const { describeElement } = await import("../src/diag/instrument");
    const b = document.createElement("button");
    b.textContent = "Send";
    b.setAttribute("data-diag", "tab-send");
    document.body.appendChild(b);
    event("ui", "tap", { ...(describeElement(b) ?? {}) });
    const e = evs("ui", "tap")[0];
    expect(e.ui_label).toBe("Send");
    expect(e.id).toBe("tab-send");
  });

  it("the synced record keeps its block count (once hashed by the session rule)", () => {
    event("sync", "synced", { blocks_scanned: 30000, since_boot_ms: 1 });
    expect(evs("sync", "synced")[0].blocks_scanned).toBe(30000);
  });
});

describe("summary", () => {
  it("names the slowest screens and endpoints and the last errors", () => {
    event("nav", "screen", { screen: "explore", tap_to_paint: 800 });
    event("nav", "screen", { screen: "wallet.send", tap_to_paint: 90 });
    recordRequest({ kind: "api", method: "POST", path: "/api/wallet/prepare", status: 200, ms: 7000, outcome: "ok" });
    event("err", "uncaught", { msg: "kaboom" }, { lvl: "error" });
    const s = summarize(recent());
    expect(s.screens[0].screen).toBe("explore");
    expect(s.endpoints[0].key).toContain("/api/wallet/prepare");
    expect(s.lastErrors[0].msg).toBe("kaboom");
  });
});
