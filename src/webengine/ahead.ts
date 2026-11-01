// When a payment proven ahead (while the user reviewed it) may be submitted instead of proving
// again: the same recipient, amount and memo, younger than the TTL, and every coin it spends
// still unspent. Anything else proves afresh.
export interface AheadPayment {
  key: string;
  at: number;
  positions: number[];
}

export const AHEAD_TTL_MS = 10 * 60_000;

export const aheadKey = (to: string, amountSompi: string, memo: string) => `${to}|${amountSompi}|${memo}`;

export function aheadUsable(a: AheadPayment | null, key: string, now: number, unspent: (positions: number[]) => boolean): boolean {
  return !!a && a.key === key && now - a.at >= 0 && now - a.at < AHEAD_TTL_MS && a.positions.length > 0 && unspent(a.positions);
}
