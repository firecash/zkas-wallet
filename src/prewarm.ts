// Keep the user's OTHER wallets ready, so switching is instant.
//
// The daemon has always been multi-wallet, but the app only ever spoke to the active
// token. From the daemon's side every other wallet of yours therefore belonged to nobody:
// `sync_loop` only advances wallets touched inside `--active-sync-window`, and
// `evict_idle_wallets` drops them after that. Switch to one and you pay a full cold
// restore — measured on the hosted daemon at a median of 8.8 s and a p90 of 93.6 s,
// because these checkpoints reach 522 MB. That is the "Opening wallet" wait, and it is
// worst exactly when you switch, which is when nothing has touched that wallet for hours.
//
// The daemon cannot fix this on its own: it has no idea which tokens belong to one
// person. Its `--warm-always` maintenance holds the hottest wallets across the WHOLE
// fleet — 32 of 2061 here — so yours are only in that set by luck.
//
// The app knows. One `/api/status` per wallet is enough: on the far side it loads the
// wallet, refreshes `last_touch` so the sync loop keeps it at the tip, and marks it warm.
//
// Deliberately gentle. Each of those calls can cost the daemon a multi-hundred-megabyte
// restore, so they go out ONE AT A TIME with a gap between them — a burst would put a
// cohort of restores through a load gate that only fits 16, which is how everything ends
// up queueing behind everything else. The active wallet is skipped; the app is already
// polling it every second.

import { getBase, touchWallet } from "./api";
import { activeToken, listWallets } from "./wallets";

/** Gap between touches. One restore at a time, not a thundering herd. */
const STAGGER_MS = 4_000;
/** How often to come back round. Comfortably inside a 1800 s sync window. */
const ROUND_MS = 120_000;

let timer: ReturnType<typeof setTimeout> | null = null;
let running = false;

async function round(): Promise<void> {
  if (running) return;
  running = true;
  try {
    // No daemon chosen yet, or the on-device engine is still starting: nothing to warm.
    if (!getBase()) return;
    const active = activeToken();
    const others = listWallets()
      .map((w) => w.token)
      .filter((t) => t && t !== active);
    for (const token of others) {
      await touchWallet(token);
      await new Promise((r) => setTimeout(r, STAGGER_MS));
    }
  } catch {
    /* best effort — the next round tries again */
  } finally {
    running = false;
  }
}

/**
 * Start keeping the inactive wallets warm. Idempotent, so calling it again after a
 * wallet switch or a daemon change simply restarts the cadence.
 */
export function startPrewarm(): void {
  stopPrewarm();
  // Not immediately: let the active wallet's own first load have the gate to itself.
  timer = setTimeout(function again() {
    void round();
    timer = setTimeout(again, ROUND_MS);
  }, 8_000);
}

export function stopPrewarm(): void {
  if (timer) {
    clearTimeout(timer);
    timer = null;
  }
}
