// Hide balances: a per-device privacy toggle (the eye) that masks every amount —
// the ZKAS balance, its fiat value, spendable, and history figures — for shoulder
// surfers. Persisted in localStorage and shared across all mounts so one tap of
// the eye hides everything at once.
import { useEffect, useState } from "react";

const KEY = "hide_balances";
export const MASK = "••••••";

let hidden = (() => {
  try { return localStorage.getItem(KEY) === "1"; } catch { return false; }
})();
const subs = new Set<() => void>();

export function balancesHidden(): boolean {
  return hidden;
}
export function setBalancesHidden(v: boolean): void {
  hidden = v;
  try {
    if (v) localStorage.setItem(KEY, "1");
    else localStorage.removeItem(KEY);
  } catch {
    /* private mode — the toggle still works for this session via `hidden` */
  }
  subs.forEach((f) => f());
}
export function toggleBalancesHidden(): void {
  setBalancesHidden(!hidden);
}

/// Current hidden state, re-rendering the caller whenever the eye is toggled
/// anywhere in the app.
export function useHideBalances(): boolean {
  const [h, setH] = useState(hidden);
  useEffect(() => {
    const on = () => setH(hidden);
    subs.add(on);
    on();
    return () => { subs.delete(on); };
  }, []);
  return h;
}
