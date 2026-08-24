// Consolidation, exercised through the real function rather than a copy of its
// arithmetic. The split feature shipped with a fee-burning bug that a pure-maths
// test could not see: splitting disabled the "a round must merge at least three
// notes" guard, so a small wallet paid a fee per round to move ONE note and
// ended up more fragmented than it started — the opposite of the button.

import { describe, expect, it, vi, beforeEach } from "vitest";
import { feeReserveSompi } from "../src/fees";

type Prep = { spendAuth: number; amount: bigint; fee: bigint; remaining: bigint };

let preps: Prep[] = [];
let prepared: bigint[] = [];
let submitted = 0;

vi.mock("../src/signer", () => ({
  fvkHex: async () => "fv".repeat(48),
  verifyAndSignPayment: async () => "[]",
}));

vi.mock("../src/api", () => ({
  api: {
    prepare: async (_fvk: string, _to: string, amount: bigint) => {
      prepared.push(amount);
      const p = preps.shift() ?? { spendAuth: 1, amount, fee: 1000n, remaining: 0n };
      return {
        session: "s",
        bundle_hex: "00",
        disclosure: {},
        spend_auth: Array.from({ length: p.spendAuth }, (_, i) => ({ alpha: String(i) })),
        amount_sompi: Number(p.amount),
        amount_sompi_exact: String(p.amount),
        fee_sompi: Number(p.fee),
        fee_sompi_exact: String(p.fee),
        remaining_sompi: Number(p.remaining),
        remaining_sompi_exact: String(p.remaining),
      };
    },
    submit: async () => {
      submitted += 1;
      return { txid: `tx${submitted}`, amount_sompi: 1, fee_sompi: 1 };
    },
  },
}));

const { consolidateNonCustodial, MAX_NOTES_PER_TX } = await import("../src/noncustodial");
const RESERVE = BigInt(feeReserveSompi(MAX_NOTES_PER_TX));
// The fee reserve now scales with the notes the wallet actually holds, so every
// expectation has to be read against the same number the code used.
const reserveFor = (noteCount: number) =>
  BigInt(feeReserveSompi(noteCount > 0 ? Math.min(noteCount, MAX_NOTES_PER_TX) : MAX_NOTES_PER_TX));
const BAL = RESERVE * 1000n;

function run(targetNotes: number, noteCount: number) {
  return consolidateNonCustodial("00".repeat(32), "mainnet", "zkas:self", BAL,
    undefined, 12, undefined, targetNotes, noteCount);
}

beforeEach(() => { preps = []; prepared = []; submitted = 0; });

describe("consolidation rounds", () => {
  it("does not split a four-note wallet, because a two-note pass reduces nothing", async () => {
    // Each pass hands the unspent fee reserve back as a change note, so a pass
    // that spends two notes produces two. Only a full sweep helps here.
    preps = [{ spendAuth: 4, amount: BAL - reserveFor(4), fee: 500n, remaining: 0n }];
    await run(3, 4);
    expect(prepared).toHaveLength(1);
    expect(prepared[0]).toBe(BAL - reserveFor(4));
    expect(submitted).toBe(1);
  });

  it("refuses to split a wallet too small to merge into that many notes", async () => {
    // Three notes cannot become two AND have each come from two. Sweep instead.
    preps = [{ spendAuth: 3, amount: BAL - reserveFor(3), fee: 500n, remaining: 0n }];
    await run(2, 3);
    expect(prepared).toHaveLength(1);
    expect(prepared[0]).toBe(BAL - reserveFor(3)); // full sweep, not a half
    expect(submitted).toBe(1);
  });

  it("falls back to a full sweep when a split round would merge nothing", async () => {
    // 12 notes permits keeping 3, but the daemon covers the first share from a
    // single big note. Splitting there is pure fee, so it sweeps instead.
    preps = [
      { spendAuth: 1, amount: (BAL - reserveFor(12)) / 3n, fee: 500n, remaining: 0n }, // the split attempt
      { spendAuth: 12, amount: BAL - reserveFor(12), fee: 500n, remaining: 0n }, // the sweep retry
    ];
    await run(3, 12);
    expect(prepared).toHaveLength(2);
    expect(prepared[0]).toBeLessThan(BAL - reserveFor(12)); // asked for a share...
    expect(prepared[1]).toBe(BAL - reserveFor(12));         // ...then swept
    expect(submitted).toBe(1);                       // only the sweep was broadcast
  });

  it("never broadcasts a round that merges nothing", async () => {
    // Real amounts, so it is the note count — not an unsafe amount — that stops it.
    // The split attempt moves one note, so it falls back to a sweep; the sweep
    // also only reaches one note, and a one-note round is never worth its fee.
    preps = [
      { spendAuth: 1, amount: (BAL - reserveFor(30)) / 3n, fee: 500n, remaining: 0n },
      { spendAuth: 1, amount: BAL - reserveFor(30), fee: 500n, remaining: 0n },
    ];
    await expect(run(3, 30)).rejects.toThrow(/Fewer than three notes/);
    expect(submitted).toBe(0);
  });

  it("does split a fragmented wallet, one merged note per round", async () => {
    const third = (BAL - reserveFor(30)) / 3n;
    preps = [
      { spendAuth: 10, amount: third, fee: 500n, remaining: BAL - third },
      { spendAuth: 10, amount: third, fee: 500n, remaining: BAL - third * 2n },
      { spendAuth: 10, amount: third, fee: 500n, remaining: 0n },
    ];
    await run(3, 30);
    expect(submitted).toBe(3);
    expect(prepared[0]).toBe(third);
  });

  it("targetNotes = 1 still sweeps in one ask, as background maintenance expects", async () => {
    preps = [{ spendAuth: 38, amount: BAL - RESERVE, fee: 500n, remaining: 0n }];
    await run(1, 400);
    expect(prepared[0]).toBe(BAL - RESERVE);
  });

  it("a caller that does not know the note count never splits", async () => {
    preps = [{ spendAuth: 38, amount: BAL - RESERVE, fee: 500n, remaining: 0n }];
    await consolidateNonCustodial("00".repeat(32), "mainnet", "zkas:self", BAL,
      undefined, 12, undefined, 5);
    expect(prepared[0]).toBe(BAL - RESERVE);
  });
});
