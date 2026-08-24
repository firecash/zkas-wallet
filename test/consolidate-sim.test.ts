// Consolidation against a SIMULATED daemon that holds real notes and really
// selects them, rather than a mock hand-fed the answers a test wanted.
//
// Every consolidation bug this wallet shipped survived a passing test because
// the test asserted the arithmetic it had just copied, or fed the daemon's reply
// in by hand. What matters is a property no mock can fake: after consolidating,
// the wallet must hold FEWER notes than before, and must never pay a fee for a
// round that did not merge anything.

import { describe, expect, it, vi, beforeEach } from "vitest";
import { minRelayFeeForSpends } from "../src/fees";

type Round = { spent: number; amount: bigint; fee: bigint };

let daemon: ReturnType<typeof makeDaemon>;
let rounds: Round[] = [];

// Notes produced by a round are UNMATURED: walletd will not select them again in
// this run, which is what makes multi-round consolidation terminate.
function makeDaemon(notes: bigint[], cap: number) {
  // walletd sorts candidates value-DESCENDING and takes the fewest notes that
  // cover amount+fee (select_spend_count), capped at max_per_tx. Outputs are
  // unmatured, so a later pass cannot select them — that is what makes a
  // multi-pass run terminate.
  const matured = [...notes].sort((a, b) => (a < b ? 1 : a > b ? -1 : 0));
  const fresh: bigint[] = [];
  let picked = 0;
  let pickedSum = 0n;
  return {
    get noteCount() { return matured.length + fresh.length; },
    get maturedTotal() { return matured.reduce((a, b) => a + b, 0n); },
    prepare(amount: bigint, allowPartial: boolean) {
      const have = matured.reduce((a, b) => a + b, 0n);
      let k = Math.min(matured.length, cap);
      let sum = 0n;
      for (let i = 0; i < Math.min(matured.length, cap); i++) {
        sum += matured[i];
        const f = BigInt(minRelayFeeForSpends(i + 1));
        if (sum >= amount + f) { k = i + 1; break; }
      }
      const fee = BigInt(minRelayFeeForSpends(k || 1));
      const selected = matured.slice(0, k).reduce((a, b) => a + b, 0n);
      const need = amount + fee;
      let paid: bigint;
      let change: bigint;
      if (selected < need) {
        // walletd: partial chunk pays every selected note less the fee, change zero.
        const capacity = selected - fee;
        if (!(allowPartial && have >= need && capacity > 0n)) throw new Error("insufficient matured funds");
        paid = capacity;
        change = 0n;
      } else {
        paid = amount;
        change = selected - amount - fee;
      }
      picked = k;
      pickedSum = selected;
      const rest = matured.slice(k).reduce((a, b) => a + b, 0n);
      return { spent: k, amount: paid, fee, change, remaining: rest };
    },
    commit(amount: bigint, change: bigint) {
      matured.splice(0, picked);
      fresh.push(amount);
      if (change > 0n) fresh.push(change);
      void pickedSum;
    },
  };
}

vi.mock("../src/signer", () => ({
  fvkHex: async () => "fv".repeat(48),
  verifyAndSignPayment: async () => "[]",
}));

vi.mock("../src/api", () => ({
  api: {
    prepare: async (_f: string, _t: string, amount: bigint) => {
      const r = daemon.prepare(amount, true);
      lastPrep = r;
      return {
        session: "s", bundle_hex: "00", disclosure: {},
        spend_auth: Array.from({ length: r.spent }, (_, i) => ({ alpha: String(i) })),
        amount_sompi: Number(r.amount), amount_sompi_exact: String(r.amount),
        fee_sompi: Number(r.fee), fee_sompi_exact: String(r.fee),
        remaining_sompi: Number(r.remaining), remaining_sompi_exact: String(r.remaining),
      };
    },
    submit: async () => {
      daemon.commit(lastPrep.amount, lastPrep.change);
      rounds.push({ spent: lastPrep.spent, amount: lastPrep.amount, fee: lastPrep.fee });
      return { txid: `tx${rounds.length}`, amount_sompi: Number(lastPrep.amount), fee_sompi: Number(lastPrep.fee) };
    },
  },
}));

let lastPrep: ReturnType<ReturnType<typeof makeDaemon>["prepare"]>;
const { consolidateNonCustodial, MAX_NOTES_PER_TX } = await import("../src/noncustodial");

async function consolidate(notes: bigint[], target: number) {
  daemon = makeDaemon(notes, MAX_NOTES_PER_TX);
  rounds = [];
  const before = daemon.noteCount;
  let error: string | null = null;
  try {
    await consolidateNonCustodial("00".repeat(32), "mainnet", "zkas:self",
      daemon.maturedTotal, undefined, 12, undefined, target, before);
  } catch (e) { error = (e as Error).message; }
  return { before, after: daemon.noteCount, rounds, error };
}

const U = 100_000_000n; // 1 ZKAS, comfortably above any fee

beforeEach(() => { rounds = []; });

describe("consolidation against a simulated daemon", () => {
  const shapes: Array<[string, bigint[]]> = [
    ["four equal notes", Array(4).fill(U)],
    ["four uneven notes", [U * 10n, U, U, U]],
    ["six equal notes", Array(6).fill(U)],
    ["nine notes", Array(9).fill(U)],
    ["forty small notes", Array(40).fill(U)],
    ["one whale and dust", [U * 100n, ...Array(9).fill(U / 10n)]],
  ];

  for (const [name, notes] of shapes) {
    for (const target of [1, 2, 3, 5]) {
      {
        it(`${name}, keep ${target}: never ends up more fragmented`, async () => {
          const r = await consolidate(notes, target);
          // The one promise the button makes.
          if (!r.error) expect(r.after).toBeLessThanOrEqual(r.before);
          // And never a fee for a round that cannot reduce the count: the fee
          // reserve comes back as a change note, so k in => 2 out.
          for (const round of r.rounds) expect(round.spent).toBeGreaterThanOrEqual(3);
          // Any round that ran must have actually bought a reduction.
          if (r.rounds.length) expect(r.after).toBeLessThan(r.before);
        });
      }
    }
  }

  it("four notes really do become ONE note, in one pass", async () => {
    // Only true since the fee reserve stopped being the 38-note ceiling. Before
    // that the unspent reserve came back as a second, 0.227 ZKAS change note, so
    // "merge everything into one" quietly left two.
    const r = await consolidate(Array(4).fill(U), 1);
    expect(r.error).toBeNull();
    expect(r.after).toBe(1);
    expect(r.rounds).toHaveLength(1);
  });

  it("a sweep leaves no change note, whatever the wallet holds", async () => {
    for (const n of [3, 4, 6, 9, 20]) {
      const r = await consolidate(Array(n).fill(U), 1);
      expect(r.after).toBe(1);
    }
  });

  it("reports what each shape actually ends with", async () => {
    const table: string[] = [];
    for (const notes of [4, 6, 9, 40]) {
      for (const target of [1, 3]) {
        const r = await consolidate(Array(notes).fill(U), target);
        table.push(`${String(notes).padStart(3)} notes, keep ${target} -> ${r.after} notes in ${r.rounds.length} tx` +
          (r.error ? ` (${r.error.slice(0, 40)})` : ""));
      }
    }
    console.log(table.join("\n"));
    expect(table.length).toBe(8);
  });
});
