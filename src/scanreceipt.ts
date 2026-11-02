// Carrying a finished scan from one wallet service to another.
//
// Switching from the hosted service to the engine inside this app used to throw the
// scan away: the two daemons are separate processes with separate wallet directories,
// so the new one started again from the wallet's birthday. On an old wallet that is a
// tree rebuild over millions of blocks, on a phone, over a network — the sync bar goes
// backwards and stays there for a long time.
//
// It never needed to. A scan is expensive to redo and tiny to carry. Almost all of a
// checkpoint is the public commitment stream, which is identical for every wallet on
// the chain and already on any node; what is genuinely this wallet's is its notes and a
// membership witness for each. So before leaving a service we ask it for that part, and
// after registering on the new one we hand it over.
//
// Nothing secret is in it. The daemon writes no nullifiers — the importer recomputes
// them from its own key — and every note is checked against the tree anchor the receipt
// names before it is believed. A receipt cannot invent money; at worst it omits some,
// which shows up as a balance lower than a later scan finds.

import { api, getBase } from "./api";
import { browserModeChosen } from "./webengine";
import { elapsedSince } from "./lib/elapsed";

const KEY = "zkas_scan_receipt_v1";

/** Receipts above this are not worth stashing: a wallet that fragmented is past the
 * point where a browser storage slot is the right carrier, and a quota error mid-switch
 * would be a worse failure than the rescan we are trying to avoid. */
const MAX_STASH_BYTES = 900_000;

/// A receipt is a snapshot of a scan, so it goes stale. Past this it is dropped rather
/// than offered: a fresh engine has scanned nothing, so it would accept an arbitrarily
/// old one, and while forward sync does correct that, starting from a months-old anchor
/// is worse than the daemon's own birthday logic and much harder to reason about.
const MAX_STASH_AGE_MS = 14 * 24 * 60 * 60 * 1000;

interface Stashed {
  /** The receiving address the receipt belongs to, so it is never applied to another
   * wallet on the same device. */
  address: string;
  receipt: string;
  scannedDaa: number;
  at: number;
  /// The service this was taken from. Adoption refuses to feed a receipt back to the
  /// daemon that produced it: that daemon already knows everything in it, would reject
  /// it as not advancing, and the stash — the only copy — would be consumed before the
  /// service it was captured *for* ever saw it.
  from: string;
  /// The chain block the scan stopped at (newer services name it): what lets an engine that
  /// reads the chain through the gateway check the receipt, as the browser engine does.
  lowBlock?: string;
}

function read(): Stashed | null {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return null;
    const v = JSON.parse(raw) as Partial<Stashed>;
    if (typeof v?.receipt !== "string" || typeof v?.address !== "string") return null;
    const at = Number(v.at ?? 0);
    // elapsedSince: a backward step makes this negative, never greater than the limit, so a
    // stale stash would never be cleared. It folds in the non-finite check too — a bad
    // timestamp reports as Infinity, which IS greater than the limit.
    if (elapsedSince(at) > MAX_STASH_AGE_MS) {
      clear();
      return null;
    }
    return {
      address: v.address,
      receipt: v.receipt,
      scannedDaa: Number(v.scannedDaa ?? 0),
      at,
      from: typeof v.from === "string" ? v.from : "",
      ...(typeof v.lowBlock === "string" ? { lowBlock: v.lowBlock } : {}),
    };
  } catch {
    return null;
  }
}

function clear(): void {
  try {
    localStorage.removeItem(KEY);
  } catch {
    /* storage is a convenience here, never a requirement */
  }
}

/**
 * Ask the service we are about to leave for this wallet's scan, and keep it.
 *
 * Best effort in every direction: an older daemon has no such endpoint, a wallet that
 * is mid-sync cannot produce one, and a phone may have no room to stash it. None of
 * those is a reason to block a switch the user asked for — they only mean the new
 * service scans for itself, which is what happened before this existed.
 */
export async function captureScanReceipt(address?: string | null): Promise<boolean> {
  if (!address) return false;
  try {
    const r = await api.scanReceiptExport();
    if (!r?.receipt || r.receipt.length > MAX_STASH_BYTES) return false;
    const stash: Stashed = { address, receipt: r.receipt, scannedDaa: r.scannedDaa, at: Date.now(), from: getBase(), ...(typeof r.lowBlock === "string" ? { lowBlock: r.lowBlock } : {}) };
    localStorage.setItem(KEY, JSON.stringify(stash));
    return true;
  } catch {
    return false;
  }
}

/**
 * Hand a stashed receipt to the service we have just registered with.
 *
 * Only ever applied to the wallet it came from: a device can hold several, and adopting
 * one wallet's scan into another would be a wrong balance rather than a slow one. The
 * daemon refuses a receipt that does not reach past where it already is, so a repeat
 * call is harmless; we drop the stash either way, because a receipt is a snapshot and a
 * stale one is worth less than the scan that has since run.
 */
/// Drop the stash if it belongs to the wallet being removed.
///
/// The stash records an `address` and that wallet's scan receipt. Adoption is already guarded
/// by the address — "so it is never applied to another" wallet — so a leftover could not be
/// misapplied; what survived "Remove wallet" was the metadata, since the key is GLOBAL
/// (`zkas_scan_receipt_v1`) and no per-wallet prefix sweep can reach it. walletstate removes
/// `birthday_addr_<address>` for the same reason — an address identifies a wallet — and it
/// already has the address in hand at that point.
///
/// Third key found this way, after the transaction labels and the Send draft.
export function forgetScanReceipt(address: string): void {
  if (!address) return;
  // Raw accessor, like every other access in this file — mixing safestore in for one
  // operation is what left a send recorded only in a session map elsewhere.
  try {
    const stash = read();
    if (stash && stash.address === address) localStorage.removeItem(KEY);
  } catch {
    /* storage unavailable: there is no stash at rest to erase */
  }
}

export async function adoptScanReceipt(address?: string | null): Promise<boolean> {
  // The wallet running in this browser takes its receipt when its engine starts
  // (`receiptForEngine`), not through a wallet service.
  if (browserModeChosen()) return false;
  const stash = read();
  if (!stash || !address || stash.address !== address) return false;
  // Never hand it back to the daemon it came from (see `Stashed.from`).
  if (stash.from && stash.from === getBase()) return false;
  try {
    const r = await api.scanReceiptImport(stash.receipt);
    clear();
    return Boolean(r?.adopted);
  } catch {
    // A daemon that does not know the endpoint, or refuses this receipt, scans instead.
    clear();
    return false;
  }
}

/** The receipt waiting for `address`, in the form the in-browser engine adopts (it needs the
 *  block the scan stopped at, which only newer services name). */
export function receiptForEngine(address: string): { hex: string; lowBlock: string; scannedDaa: number } | null {
  const stash = read();
  if (!stash || stash.address !== address || !stash.lowBlock) return null;
  return { hex: stash.receipt, lowBlock: stash.lowBlock, scannedDaa: stash.scannedDaa };
}

/** Whether a receipt is waiting for `address` — used to say "carrying your sync across"
 * rather than leaving the user watching a bar with no explanation. */
export function haveScanReceipt(address?: string | null): boolean {
  const stash = read();
  return Boolean(stash && address && stash.address === address);
}
