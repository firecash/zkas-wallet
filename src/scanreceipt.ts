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

import { api } from "./api";

const KEY = "zkas_scan_receipt_v1";

/** Receipts above this are not worth stashing: a wallet that fragmented is past the
 * point where a browser storage slot is the right carrier, and a quota error mid-switch
 * would be a worse failure than the rescan we are trying to avoid. */
const MAX_STASH_BYTES = 900_000;

interface Stashed {
  /** The receiving address the receipt belongs to, so it is never applied to another
   * wallet on the same device. */
  address: string;
  receipt: string;
  scannedDaa: number;
  at: number;
}

function read(): Stashed | null {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return null;
    const v = JSON.parse(raw) as Partial<Stashed>;
    if (typeof v?.receipt !== "string" || typeof v?.address !== "string") return null;
    return { address: v.address, receipt: v.receipt, scannedDaa: Number(v.scannedDaa ?? 0), at: Number(v.at ?? 0) };
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
    const stash: Stashed = { address, receipt: r.receipt, scannedDaa: r.scannedDaa, at: Date.now() };
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
export async function adoptScanReceipt(address?: string | null): Promise<boolean> {
  const stash = read();
  if (!stash || !address || stash.address !== address) return false;
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

/** Whether a receipt is waiting for `address` — used to say "carrying your sync across"
 * rather than leaving the user watching a bar with no explanation. */
export function haveScanReceipt(address?: string | null): boolean {
  const stash = read();
  return Boolean(stash && address && stash.address === address);
}
