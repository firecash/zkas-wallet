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
function makeDaemon(notes: bigint[], order: "asc" | "desc", cap: number) {
  const spendable = [...notes].sort((a, b) => (order === "asc" ? (a < b ? -1 : 1) : a < b ? 1 : -1));
  const pending: bigint[] = [];
  let picked: bigint[] = [];
  return {
    get noteCount() { return spendable.length + pending.length; },
    get spendableTotal() { return spendable.reduce((a, b) => a + b, 0n); },
    prepare(amount: bigint) {
      picked = [];
      let sum = 0n;
      for (const n of spendable) {
        if (picked.length >= cap) break;
        picked.push(n);
        sum += n;
        if (sum >= amount + BigInt(minRelayFeeForSpends(picked.length))) break;
      }
      const fee = BigInt(minRelayFeeForSpends(picked.length || 1));
      const payable = sum - fee;
      const amt = payable >= amount ? amount : payable;
      const change = payable - amt;
      const rest = spendable.slice(picked.length).reduce((a, b) => a + b, 0n);
      return { spent: picked.length, amount: amt, fee, change, remaining: rest };
    },
    commit(amount: bigint, change: bigint) {
      spendable.splice(0, picked.length);
      pending.push(amount);
      if (change > 0n) pending.push(change);
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
      const r = daemon.prepare(amount);
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

async function consolidate(notes: bigint[], target: number, order: "asc" | "desc" = "asc") {
  daemon = makeDaemon(notes, order, MAX_NOTES_PER_TX);
  rounds = [];
  const before = daemon.noteCount;
  let error: string | null = null;
  try {
    await consolidateNonCustodial("00".repeat(32), "mainnet", "zkas:self",
      daemon.spendableTotal, undefined, 12, undefined, target, before);
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
      for (const order of ["asc", "desc"] as const) {
        it(`${name}, keep ${target} (${order}): never ends up more fragmented`, async () => {
          const r = await consolidate(notes, target, order);
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

  it("four notes become one merged note plus its change", async () => {
    // The honest result: the unspent fee reserve comes back as a second note.
    const r = await consolidate(Array(4).fill(U), 1);
    expect(r.error).toBeNull();
    expect(r.after).toBe(2);
    expect(r.rounds).toHaveLength(1);
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
