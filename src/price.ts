// Live ZKAS price, for showing holdings value in fiat the way Kaspium does.
// Pulled from the OTC desk (CORS-enabled). Cached in localStorage, refreshed on
// mount and every 60s, and degrades silently to the last cache (or nothing) when
// unreachable — a price is a nicety, never a blocker.
//
// ONE poller, however many consumers. The balance card, History, the detail sheet
// and Send all call useZkasPrice(); when each mount ran its own fetch + 60 s
// interval, an idle wallet polled two to four times a minute and History — which
// remounts on every tab switch — fetched again on every visit. Now the first
// subscriber starts the interval, the last one stops it, a figure younger than
// FRESH_MS is reused instead of refetched, nothing is fetched while the tab is
// hidden, and listeners are only told about a price that actually changed.
import { useEffect, useState } from "react";

const PRICE_URL = "https://mining-pool.zkas.info/api/otc/price";
const CACHE_KEY = "zkas_price_v1";
const POLL_MS = 60_000;
/// A figure younger than this is served from memory: a consumer mounting right
/// after another one (or a tab coming back after a few seconds) does not refetch.
const FRESH_MS = 30_000;

export type ZkasPrice = { usdPerZkas: number; kasPerZkas: number; asOf: number };

let mem: ZkasPrice | null = null;
const listeners = new Set<() => void>();
/// The fetch currently on the wire, so concurrent callers share one request.
let inflight: Promise<ZkasPrice | null> | null = null;
let timer: ReturnType<typeof setInterval> | null = null;

/// "$0.00215" | "0.00215" -> 0.00215 ; NaN if not a number.
function num(s: unknown): number {
  return s == null ? NaN : Number(String(s).replace(/[^0-9.]/g, ""));
}

export function cachedPrice(): ZkasPrice | null {
  if (mem) return mem;
  try {
    const r = localStorage.getItem(CACHE_KEY);
    if (r) mem = JSON.parse(r) as ZkasPrice;
  } catch {
    /* private mode / disabled storage — fall through to a live fetch */
  }
  return mem;
}

export function refreshPrice(): Promise<ZkasPrice | null> {
  if (!inflight) inflight = fetchPrice().finally(() => { inflight = null; });
  return inflight;
}

async function fetchPrice(): Promise<ZkasPrice | null> {
  try {
    const r = await fetch(PRICE_URL, { cache: "no-store" });
    if (!r.ok) return mem;
    const j = (await r.json()) as {
      mid?: { usd?: string; kas?: string };
      last?: { usd?: string; kas?: string };
    };
    // `mid` is the fair market midpoint; `last` is the fallback if mid is absent.
    const usd = num(j?.mid?.usd) || num(j?.last?.usd);
    const kas = num(j?.mid?.kas) || num(j?.last?.kas);
    if (!Number.isFinite(usd) || usd <= 0) return mem;
    const next: ZkasPrice = { usdPerZkas: usd, kasPerZkas: Number.isFinite(kas) ? kas : 0, asOf: Date.now() };
    const changed = !mem || mem.usdPerZkas !== next.usdPerZkas || mem.kasPerZkas !== next.kasPerZkas;
    mem = next;
    try {
      localStorage.setItem(CACHE_KEY, JSON.stringify(mem));
    } catch {
      /* best-effort cache */
    }
    // An unchanged figure is not news: every consumer would re-render for nothing.
    if (changed) listeners.forEach((l) => l());
    return mem;
  } catch {
    return mem;
  }
}

/// Fetch only when the cached figure is stale (or absent).
function refreshIfStale(): void {
  const cur = cachedPrice();
  if (cur && Date.now() - cur.asOf < FRESH_MS) return;
  void refreshPrice();
}

/// The interval tick. A hidden tab fetches nothing; the visibilitychange hook
/// below catches it up the moment it is shown again.
function tick(): void {
  if (document.hidden) return;
  refreshIfStale();
}

function onVisible(): void {
  if (!document.hidden && listeners.size > 0) refreshIfStale();
}

function subscribe(l: () => void): void {
  listeners.add(l);
  if (listeners.size === 1) {
    timer = setInterval(tick, POLL_MS);
    document.addEventListener("visibilitychange", onVisible);
  }
  // Cheap when a fresh figure is already in memory — the common case for a
  // consumer that mounts while another is up.
  if (!document.hidden) refreshIfStale();
}

function unsubscribe(l: () => void): void {
  listeners.delete(l);
  if (listeners.size === 0 && timer !== null) {
    clearInterval(timer);
    timer = null;
    document.removeEventListener("visibilitychange", onVisible);
  }
}

/// The price, refreshed on mount and every 60s. Shared across all mounts so the
/// balance, history rows and detail sheet all read the same figure.
export function useZkasPrice(): ZkasPrice | null {
  const [p, setP] = useState<ZkasPrice | null>(() => cachedPrice());
  useEffect(() => {
    let live = true;
    const on = () => { if (live) setP(cachedPrice()); };
    subscribe(on);
    // A fetch may have landed between the initial state and this subscription.
    on();
    return () => {
      live = false;
      unsubscribe(on);
    };
  }, []);
  return p;
}

/// Fiat string for a ZKAS amount, or null when there's no price yet. Adaptive
/// precision so a sub-cent holding still reads as a real number, not "$0.00".
export function fmtFiat(zkas: number, price: ZkasPrice | null): string | null {
  if (!price || !Number.isFinite(zkas)) return null;
  const v = zkas * price.usdPerZkas;
  if (v === 0) return "$0.00";
  if (v > 0 && v < 0.01) return "<$0.01";
  if (v < 1) return "$" + v.toFixed(3);
  return "$" + v.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}
