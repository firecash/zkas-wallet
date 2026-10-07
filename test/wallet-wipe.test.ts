// Removing a wallet has to remove ALL of it.
//
// Two keys survived: `watch_fvk_<token>` — which watchonly.ts calls "the
// wallet's entire financial history in one string", a permanent disclosure —
// and `device_seed_stray_<token>_<ts>`, where shelveMismatchedSeed parks a
// SPENDING KEY, in the clear when no lock is on. The stray was missed because
// the list removes the exact key `device_seed_<token>`, and the stray's token
// sits in the middle of the name rather than at the end of that prefix.

import { beforeEach, describe, expect, it } from "vitest";
import { wipeWalletState } from "../src/walletstate";

const TOKEN = "tok";
const OTHER = "other";

beforeEach(() => {
  localStorage.clear();
  localStorage.setItem("wallet_token", TOKEN);
});

describe("wipeWalletState", () => {
  it("removes the view key of a watch-only wallet", () => {
    localStorage.setItem(`watch_fvk_${TOKEN}`, "ab".repeat(96));
    wipeWalletState(TOKEN);
    expect(localStorage.getItem(`watch_fvk_${TOKEN}`)).toBeNull();
  });

  it("removes a shelved plaintext spending key", () => {
    localStorage.setItem(`device_seed_stray_${TOKEN}_1700000000000`, "cd".repeat(32));
    localStorage.setItem(`device_seed_stray_${TOKEN}_1700000000001`, "ef".repeat(32));
    wipeWalletState(TOKEN);
    const left = Object.keys(localStorage).filter((k) => k.startsWith("device_seed_stray_"));
    expect(left).toEqual([]);
  });

  it("removes the arrival baseline and announced-receipt log", () => {
    localStorage.setItem(`last_final_balance_${TOKEN}`, "123");
    localStorage.setItem(`local_receipts_${TOKEN}`, "[]");
    localStorage.setItem(`maintenance_last_run_${TOKEN}`, "1");
    wipeWalletState(TOKEN);
    expect(localStorage.getItem(`last_final_balance_${TOKEN}`)).toBeNull();
    expect(localStorage.getItem(`local_receipts_${TOKEN}`)).toBeNull();
    expect(localStorage.getItem(`maintenance_last_run_${TOKEN}`)).toBeNull();
  });

  it("removes timing estimates, whose token is a SUFFIX not a prefix", () => {
    localStorage.setItem(`timing_prepare_${TOKEN}`, "{}");
    localStorage.setItem(`timing_consolidate-pass_${TOKEN}`, "{}");
    wipeWalletState(TOKEN);
    expect(Object.keys(localStorage).filter((k) => k.startsWith("timing_"))).toEqual([]);
  });

  it("leaves another wallet's keys completely alone", () => {
    localStorage.setItem(`watch_fvk_${OTHER}`, "11".repeat(96));
    localStorage.setItem(`device_seed_stray_${OTHER}_1700000000000`, "22".repeat(32));
    localStorage.setItem(`timing_prepare_${OTHER}`, "{}");
    localStorage.setItem(`local_receipts_${OTHER}`, "[]");
    wipeWalletState(TOKEN);
    expect(localStorage.getItem(`watch_fvk_${OTHER}`)).not.toBeNull();
    expect(localStorage.getItem(`device_seed_stray_${OTHER}_1700000000000`)).not.toBeNull();
    expect(localStorage.getItem(`timing_prepare_${OTHER}`)).not.toBeNull();
    expect(localStorage.getItem(`local_receipts_${OTHER}`)).not.toBeNull();
  });

  it("never touches the device lock, which holds every wallet's sealed seed", () => {
    localStorage.setItem("app_lock_v2", JSON.stringify({ wallets: { other: "sealed" } }));
    wipeWalletState(TOKEN);
    expect(localStorage.getItem("app_lock_v2")).not.toBeNull();
  });
});
