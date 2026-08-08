import type { Status, ChainHistoryRow } from "../api";
import { type LocalTx, loadSnapshot } from "../localtx";
import { CONF_MAX_TRIES, CONF_RECENT_RETRY_MS } from "./constants";

export function sameStatus(a: Status, b: Status): boolean {
  return (
    a.has_wallet === b.has_wallet &&
    a.address === b.address &&
    a.synced === b.synced &&
    a.warming === b.warming &&
    a.node_connected === b.node_connected &&
    a.balance_fc === b.balance_fc &&
    a.spendable_fc === b.spendable_fc &&
    a.maturing_fc === b.maturing_fc &&
    a.pending_in_fc === b.pending_in_fc &&
    a.pending_out_fc === b.pending_out_fc &&
    a.note_count === b.note_count &&
    a.error === b.error &&
    a.missing_history === b.missing_history &&
    a.watch_only === b.watch_only &&
    (a.synced ? true : a.scanned_blocks === b.scanned_blocks && a.chain_len === b.chain_len)
  );
}

export function sameTxs(a: LocalTx[], b: LocalTx[]): boolean {
  if (a.length !== b.length) return false;
  return a.every((x, i) => x.txid === b[i].txid && x.confs === b[i].confs && x.pending === b[i].pending);
}

export function spendableFc(status: Status | null): number {
  if (!status) return 0;
  return status.spendable_fc != null ? parseFloat(status.spendable_fc) : parseFloat(status.balance_fc || "0");
}

export function maturingFc(status: Status | null): number {
  return status?.maturing_fc != null ? parseFloat(status.maturing_fc) : 0;
}

export function reliablePreFc(status: Status | null): number {
  const b = parseFloat(status?.balance_fc || "0");
  return b > 0 ? b : loadSnapshot()?.balanceFc ?? 0;
}

export function pendingInFc(status: Status | null): number {
  return status?.pending_in_fc != null ? parseFloat(status.pending_in_fc) : 0;
}

export function pendingOutFc(status: Status | null): number {
  return status?.pending_out_fc != null ? parseFloat(status.pending_out_fc) : 0;
}

export function confBadge(t: LocalTx): string {
  const confs = t.confs ?? 0;
  if (confs >= 1) {
    return Date.now() - t.ts > CONF_RECENT_RETRY_MS ? "confirmed" : `${confs} conf${confs === 1 ? "" : "s"}`;
  }
  if (t.confs == null && (t.confTries ?? 0) >= CONF_MAX_TRIES) return "not seen on-chain";
  return "sending…";
}

let lastSnapshotKey = "";
export function snapshotDirty(s: Status): boolean {
  const key = `${s.balance_fc}|${s.spendable_fc}|${s.maturing_fc}|${s.note_count}`;
  if (key === lastSnapshotKey) return false;
  lastSnapshotKey = key;
  return true;
}

export function visibleDeviceRows(txs: LocalTx[], chainRows: { txid: string; kind: string }[]): LocalTx[] {
  const sentOnChain = new Set(chainRows.filter((r) => r.kind === "sent").map((r) => r.txid));
  return txs.filter((t) => !sentOnChain.has(t.txid));
}

export function isTransientNote(msg: string): boolean {
  const m = msg.trim();
  return /[….]{1,3}$/.test(m) && m === m.toLowerCase() && m.length < 40;
}

export function localTxToRow(t: LocalTx): ChainHistoryRow & { confs?: number } {
  return {
    kind: "sent",
    txid: t.txid,
    daaScore: 0,
    timestamp: t.ts,
    amountSompi: Math.round(t.amountFc * 1e8),
    amountZkas: t.amountFc,
    feeSompi: Math.round(t.feeFc * 1e8),
    recipient: t.to,
    memo: null,
    confs: t.confs,
  };
}
