import { beforeEach, describe, expect, it } from "vitest";
import { recent, resetForTests } from "../src/diag/log";
import { setSalt, violations } from "../src/diag/redact";
import { ingestEngineText, parseEngineMessage, resetSyncForTests } from "../src/diag/sync";
import { summarize } from "../src/diag/summary";

// Real lines from zkas-walletd 0fb6f65 (task W's scan_stats/ckpt_load), copied from the live
// hosted daemon's log on 2026-10-22 19:27-19:29 UTC. tok is walletd's own pseudonym.
const SCAN =
  "scan_stats v=1 tok=54e349cb window_s=93 pages=3 fetched=3 blocks=439 actions=461 leaves=535 wait_ms=99 wait_max_ms=61 rpc_ms=35 decode_ms=62 ingest_ms=71 decrypt_ms=6.4 decrypt_us_per_action=13.79 tree_ms=14.3 mirror_ms=0.0 subtree_ms=14.1 witness_ms=0.0 ckpt_writes=1 ckpt_encode_ms=479 ckpt_write_ms=5661 ckpt_mb=333.8 behind=198 deferred=0";
const SCAN2 =
  "scan_stats v=1 tok=89a72df9 window_s=66 pages=4 fetched=3 blocks=201 actions=1141 leaves=509 wait_ms=50 wait_max_ms=19 rpc_ms=34 decode_ms=15 ingest_ms=62 decrypt_ms=19.7 decrypt_us_per_action=17.30 tree_ms=20.0 mirror_ms=0.0 subtree_ms=19.9 witness_ms=0.0 ckpt_writes=0 ckpt_encode_ms=0 ckpt_write_ms=0 ckpt_mb=0.0 behind=192 deferred=0";
const TREE =
  "scan_stats v=1 tok=chaintree window_s=81 pages=2 fetched=0 blocks=100 actions=0 leaves=17 wait_ms=0 wait_max_ms=0 rpc_ms=0 decode_ms=0 ingest_ms=20 decrypt_ms=0.0 decrypt_us_per_action=0.00 tree_ms=0.6 mirror_ms=0.3 subtree_ms=0.3 witness_ms=0.0 ckpt_writes=1 ckpt_encode_ms=1280 ckpt_write_ms=3861 ckpt_mb=789.4 behind=246 deferred=0";
const LOAD =
  "ckpt_load v=1 tok=a637fe9c via_checkpoint=1 total_ms=5359 queue_ms=0 gate_ms=19 verify_ms=4 restore_ms=5296 ckpt_mb=381.0 notes=33 leaves=15260741";

beforeEach(() => {
  resetForTests();
  resetSyncForTests();
  setSalt("44".repeat(16));
});

describe("walletd scan_stats / ckpt_load lines", () => {
  it("parse every key as a number, and tok as the pseudonym it already is", () => {
    const p = parseEngineMessage(SCAN)!;
    expect(p.ev).toBe("stage_stats");
    expect(p.fields).toMatchObject({
      kind: "scan_stats", v: 1, tok: "54e349cb", window_s: 93, pages: 3, fetched: 3, blocks: 439,
      wait_ms: 99, rpc_ms: 35, decode_ms: 62, ingest_ms: 71, decrypt_us_per_action: 13.79,
      tree_ms: 14.3, witness_ms: 0, ckpt_writes: 1, ckpt_write_ms: 5661, ckpt_mb: 333.8, behind: 198, deferred: 0,
    });
    // 25 key=value pairs after the kind.
    expect(Object.keys(p.fields).length).toBe(1 + 25);
    expect(parseEngineMessage(TREE)!.fields).toMatchObject({ tok: "chaintree", ckpt_mb: 789.4 });
    expect(parseEngineMessage(LOAD)!.fields).toMatchObject({ kind: "ckpt_load", via_checkpoint: 1, total_ms: 5359, restore_ms: 5296, notes: 33, leaves: 15260741 });
  });

  it("a key walletd adds later is recorded without an app change; a malformed line is not parsed", () => {
    expect(parseEngineMessage(`${SCAN} new_key=7`)!.fields.new_key).toBe(7);
    expect(parseEngineMessage("scan_stats tok=54e349cb window_s=93")).toBeNull(); // no v=
    expect(parseEngineMessage(`note: ${SCAN}`)).toBeNull(); // only at the start of a message
  });

  it("arrive through both engine log formats, clean, and feed the summary", () => {
    const now = Math.floor(Date.now() / 1000);
    ingestEngineText([`${now} [INFO] zkas_walletd: ${SCAN}`, `${now} [INFO] zkas_walletd: ${LOAD}`].join("\n"), "android");
    ingestEngineText(`${Date.now()} [INFO zkas_walletd] ${SCAN2}`, "desktop");
    const ev = recent().filter((e) => e.cat === "sync" && e.ev === "stage_stats");
    expect(ev.map((e) => e.kind)).toEqual(["scan_stats", "ckpt_load", "scan_stats"]);
    expect(ev[0].source).toBe("android");
    for (const e of recent()) expect(violations(JSON.stringify(e), [])).toEqual([]);
    const s = summarize(recent()).sync;
    expect(s.stages).toMatchObject({ blocks: 201, wait_ms: 50, rpc_ms: 34, ingest_ms: 62, behind: 192 });
    expect(s.usPerAction).toBe(17.3);
    expect(s.lastLoad).toMatchObject({ total_ms: 5359, restore_ms: 5296, via_checkpoint: 1 });
  });
});
