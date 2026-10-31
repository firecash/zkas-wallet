import { beforeEach, describe, expect, it } from "vitest";
import { filterEngineText, partOfEngineLine, partEnabled, resetPartsForTests, setPartEnabled, LOG_PARTS } from "../src/diag/parts";
import { ingestEngineText, parseEngineMessage, resetSyncForTests } from "../src/diag/sync";
import { event, recent, resetForTests, setLevel } from "../src/diag/log";

describe("log parts", () => {
  beforeEach(() => {
    try {
      localStorage.clear();
    } catch {
      /* no storage in this environment */
    }
    resetPartsForTests();
  });

  it("keeps everything by default", () => {
    for (const p of LOG_PARTS) expect(partEnabled(p)).toBe(true);
    const text = "1 [INFO] zkas_walletd: page pipeline: x\n1 [DEBUG] h2::codec: frame";
    expect(filterEngineText(text)).toBe(text);
  });

  it("puts chain files and almanac lines in their own part, by module and by message", () => {
    expect(partOfEngineLine("zkas_walletd::chain_files", "segment 114 ready")).toBe("files");
    expect(partOfEngineLine("zkas_walletd", "wallet birthday 5: the node cannot place it; starting from the frontier almanac at daa 9 (tree position 1) instead of genesis")).toBe("files");
    expect(partOfEngineLine("zkas_walletd", "wallet ab: chain files verified: the tree built from them equals the node's at block c (1 leaves)")).toBe("files");
  });

  it("separates walletd's own submodules from third-party libraries", () => {
    expect(partOfEngineLine("zkas_walletd::engine_host", "page pipeline: fetch 1 ms")).toBe("sync");
    expect(partOfEngineLine("hyper_util::client::legacy::pool", "reuse idle connection")).toBe("libs");
    expect(partOfEngineLine("h2::codec::framed_write", "send frame")).toBe("libs");
    expect(partOfEngineLine("zkas_walletd", "prepare: Halo2 proof took 1.2s")).toBe("send");
  });

  it("drops a switched-off part but never its warnings or errors", () => {
    setPartEnabled("libs", false);
    setPartEnabled("files", false);
    const text = [
      "1 [INFO] zkas_walletd: page pipeline: fetch 1 ms",
      "1 [DEBUG] h2::codec: frame",
      "1 [INFO] zkas_walletd::chain_files: chain files: segment 3 ready: 1 blocks, 1 KB, 1 ms (1 MB downloaded this session, 1 pages served from files)",
      "1 [WARN] zkas_walletd::chain_files: chain files: segment 3 fetched 3 times this session (30 MB downloaded in total)",
      "1 [ERROR] zkas_walletd::chain_files: chain files DISABLED: mismatch",
      "how this app ended last time:",
    ].join("\n");
    const out = filterEngineText(text).split("\n");
    expect(out).toContain("1 [INFO] zkas_walletd: page pipeline: fetch 1 ms");
    expect(out.some((l) => l.includes("h2::codec"))).toBe(false);
    expect(out.some((l) => l.includes("segment 3 ready"))).toBe(false);
    expect(out.some((l) => l.includes("fetched 3 times"))).toBe(true);
    expect(out.some((l) => l.includes("DISABLED"))).toBe(true);
    expect(out).toContain("how this app ended last time:");
    setPartEnabled("files", true);
    expect(partEnabled("files")).toBe(true);
  });

  it("turns the chain files and almanac lines into structured sync events", () => {
    expect(parseEngineMessage("chain files: segment 114 ready: 21188 blocks, 9772 KB, 812 ms (73 MB downloaded this session, 40 pages served from files)")).toEqual({
      ev: "chain_file_segment",
      fields: { segment: 114, blocks: 21188, kb: 9772, ms: 812, session_mb: 73, pages: 40 },
    });
    expect(parseEngineMessage("chain files: segment 114 fetched 3 times this session (1400 MB downloaded in total) — x")?.ev).toBe("chain_file_refetch");
    expect(parseEngineMessage("wallet birthday 5811052: the node cannot place it; starting from the frontier almanac at daa 5788799 (tree position 11841227) instead of genesis")).toEqual({
      ev: "almanac_start",
      fields: { daa: 5788799, position: 11841227 },
    });
    expect(parseEngineMessage("chain files DISABLED: a file page differs; every page now comes from the node")?.ev).toBe("chain_files_disabled");
  });

  it("a part switched off drops its engine lines AND the events parsed from them; other parts are untouched", () => {
    resetForTests();
    resetSyncForTests();
    setLevel("normal");
    const seg = "1 [INFO] zkas_walletd::chain_files: chain files: segment 9 ready: 1 blocks, 1 KB, 1 ms (1 MB downloaded this session, 1 pages served from files)";
    const pipe = "2 [INFO] zkas_walletd: page pipeline: fetch 10 ms (1.0 ms/page) | ingest 5 ms (0.5 ms/page) | 10 pages -> fetch is 66%";
    setPartEnabled("files", false);
    ingestEngineText([seg, pipe].join("\n"), "android");
    expect(recent().some((e) => e.ev === "chain_file_segment")).toBe(false);
    expect(recent().some((e) => e.ev === "page_pipeline")).toBe(true);

    // The other way round: sync off, files on. The chain-files event is recorded although it
    // is a `sync` category event, because it belongs to the files part.
    resetForTests();
    resetSyncForTests();
    localStorage.clear();
    resetPartsForTests();
    setLevel("normal");
    setPartEnabled("sync", false);
    ingestEngineText([seg, pipe].join("\n"), "android");
    expect(recent().some((e) => e.ev === "chain_file_segment")).toBe(true);
    expect(recent().some((e) => e.ev === "page_pipeline")).toBe(false);
  });

  it("switching off taps drops ui events but keeps a ui error", () => {
    resetForTests();
    setLevel("normal");
    setPartEnabled("ui", false);
    event("ui", "tap", { id: "x" });
    event("ui", "broken", { id: "y" }, { lvl: "error" });
    expect(recent().filter((e) => e.cat === "ui").map((e) => e.ev)).toEqual(["broken"]);
  });
});
