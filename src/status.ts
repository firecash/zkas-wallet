// One place that decides what the wallet is DOING and how to say it.
//
// Before this, the answer was assembled inline in the balance card from half a dozen
// independent booleans — `restoring`, `rebuilding`, `syncing`, `warming`, `finalizing`
// — each with its own wording invented at the call site. That produced states no user
// could interpret ("rebuilding 44%", "speeding up sends"), states that contradicted
// each other in the same frame, and time estimates that existed in one branch and not
// the one users actually sat in.
//
// Three rules, learned from what went wrong live:
//
//  1. NEVER present an unfinished count as a balance. A scan reports what it has found
//     SO FAR, climbing from zero. Rendered as a headline it reads as theft — a user
//     watched "34.75 ZKAS" under a small "syncing 44%" when the real figure was far
//     higher, and a pool wallet showed 29,703 against a true 423,997. `balanceIsFinal`
//     is the single flag that decides this, and it is false whenever we are not sure.
//
//  2. Say how long, or say nothing — never guess. `etaSeconds` comes from a measured
//     rate; absent means "not known yet", and the UI must not invent a number.
//
//  3. No jargon. The user does not have a "commitment tree", they have coins. Words
//     like rebuilding, warming, witness, anchor and 0-conf are ours, not theirs.

export interface StatusInput {
  /// Daemon reachable and answering at all.
  online: boolean;
  synced: boolean;
  scannedBlocks: number;
  chainLen: number;
  /// Daemon is still making this wallet fast to spend from (cold witnesses).
  warming: boolean;
  /// A confirmed balance from a previous completed sync, if we have ever had one.
  haveConfirmedBalance: boolean;
  /// Seconds remaining from a measured scan rate, or null if not yet known.
  etaSeconds: number | null;
  /// How long this wallet has been in the getting-ready state, if known.
  warmingSeconds?: number | null;
}

export type WalletPhase = "offline" | "opening" | "setting-up" | "catching-up" | "almost-ready" | "ready";

export interface WalletStatusView {
  phase: WalletPhase;
  /// Two or three words. The state, as a person would name it.
  label: string;
  /// One plain sentence: what is happening and what it means for them.
  detail: string;
  /// 0..100 when there is real progress to show, else null.
  pct: number | null;
  /// The same progress as a finer figure for display, e.g. "62.4%".
  ///
  /// A whole-number percent is the wrong resolution for this scan. Measured on the
  /// live daemon it advances at ~250–800 blocks/s against a ~1.04 M-block chain, so
  /// one percent takes 13–42 SECONDS. The bar sat motionless for up to forty seconds
  /// at a time and users reported it as "stuck, although it advances" — which was an
  /// exactly correct description of what they could see. One decimal moves every few
  /// seconds, which is the difference between "working" and "hung".
  pctFine: string | null;
  /// Blocks scanned and total, so there is always a number visibly moving even when
  /// the percentage has not ticked.
  progress: { scanned: number; total: number } | null;
  /// Human duration, already formatted, or null when genuinely unknown.
  eta: string | null;
  tone: "ok" | "busy";
  /// May the balance be shown as THE balance? False while any count is partial.
  balanceIsFinal: boolean;
  /// True while the wallet cannot yet spend, so Send can explain rather than fail.
  canSpend: boolean;
}

/// Coarse on purpose. A scan rate wobbles, and a precise figure that keeps changing
/// is trusted less than a rounded one that holds still.
export function formatDuration(secs: number): string {
  if (!Number.isFinite(secs) || secs < 0) return "";
  if (secs < 45) return "less than a minute";
  const m = Math.round(secs / 60);
  if (m < 60) return `about ${m} minute${m === 1 ? "" : "s"}`;
  const h = Math.floor(m / 60);
  const rem = m % 60;
  if (h >= 6) return `several hours`;
  return rem ? `about ${h}h ${rem}m` : `about ${h} hour${h === 1 ? "" : "s"}`;
}

function pctOf(scanned: number, total: number): number | null {
  if (!(total > 0) || !(scanned >= 0)) return null;
  return Math.max(0, Math.min(100, Math.round((scanned / total) * 100)));
}

/// One decimal, floored — never round UP to "100.0%" while work remains, which is
/// the single most frustrating thing a progress display can do.
function pctFineOf(scanned: number, total: number): string | null {
  if (!(total > 0) || !(scanned >= 0)) return null;
  const raw = Math.max(0, Math.min(100, (scanned / total) * 100));
  const floored = Math.floor(raw * 10) / 10;
  return `${(scanned < total ? Math.min(floored, 99.9) : 100).toFixed(1)}%`;
}

export function walletStatus(s: StatusInput): WalletStatusView {
  const pct = pctOf(s.scannedBlocks, s.chainLen);
  const pctFine = pctFineOf(s.scannedBlocks, s.chainLen);
  const progress = s.chainLen > 0 ? { scanned: s.scannedBlocks, total: s.chainLen } : null;
  const eta = s.etaSeconds != null ? `${formatDuration(s.etaSeconds)} left` : null;

  if (!s.online) {
    return {
      phase: "offline",
      label: "Can't reach the network",
      detail: "Your coins are safe on the chain. The wallet will reconnect on its own.",
      pct: null,
      pctFine: null,
      progress: null,
      eta: null,
      tone: "busy",
      balanceIsFinal: false,
      canSpend: false,
    };
  }

  // No progress figure yet: the wallet is being loaded and genuinely knows nothing.
  // The daemon answers zeros here, which is "I don't know yet", never "you have none".
  if (!s.synced && s.scannedBlocks === 0) {
    return {
      phase: "opening",
      label: "Opening your wallet",
      detail: "Loading your wallet. This usually takes a few seconds.",
      pct: null,
      pctFine: null,
      progress: null,
      eta: null,
      tone: "busy",
      balanceIsFinal: false,
      canSpend: false,
    };
  }

  if (!s.synced) {
    // Never scanned to completion: everything on screen is a running count.
    if (!s.haveConfirmedBalance) {
      return {
        phase: "setting-up",
        label: "Setting up your wallet",
        detail:
          "Reading the chain to find the coins that belong to you. The amount below is what it has found so far — it is not your final balance yet.",
        pct,
        pctFine,
        progress,
        eta,
        tone: "busy",
        balanceIsFinal: false,
        canSpend: false,
      };
    }
    // Has a confirmed figure from before, and is checking the chain since then.
    return {
      phase: "catching-up",
      label: "Catching up",
      detail: "Checking the chain for new payments. Your balance is up to date as of the last check.",
      pct,
      pctFine,
      progress,
      eta,
      tone: "busy",
      balanceIsFinal: false,
      canSpend: false,
    };
  }

  if (s.warming) {
    // Elapsed rather than a promise. There is no progress counter behind this state, so
    // any "about N minutes" would be invented — and a wallet that says two minutes and
    // takes six has lied. A number that is simply TRUE ("2m so far") still answers the
    // real question, which is "is this moving or is it stuck".
    const waited = s.warmingSeconds != null && s.warmingSeconds >= 5 ? ` (${formatDuration(s.warmingSeconds)} so far)` : "";
    return {
      phase: "almost-ready",
      label: "Almost ready",
      detail: `Your balance is up to date. The wallet is getting ready to pay${waited} — the first payment is the slow one, later ones take seconds.`,
      pct: null,
      pctFine: null,
      progress: null,
      eta: null,
      tone: "busy",
      balanceIsFinal: true,
      canSpend: true,
    };
  }

  return {
    phase: "ready",
    label: "Ready",
    detail: "Your balance is up to date.",
    pct: null,
    pctFine: null,
    progress: null,
    eta: null,
    tone: "ok",
    balanceIsFinal: true,
    canSpend: true,
  };
}

/// Should a balance change be announced to the user as money ARRIVING?
///
/// Split out of the poll so the rule is testable, because the failure mode is loud: a
/// scan reports what it has found SO FAR, climbing from zero, so comparing two
/// mid-scan readings announces a "payment" for every note the wallet rediscovers about
/// itself. A user restoring a seed would get a burst of fake receive notifications for
/// their own money.
///
/// Hence: only ever compare two FINAL balances, and treat the first final reading as a
/// baseline rather than a gain (otherwise opening the app announces the whole balance).
export function arrivalAmount(prev: number | null, next: number, isFinal: boolean): number | null {
  if (!isFinal) return null;
  if (prev === null) return null; // first final reading — baseline only
  const delta = next - prev;
  // One sompi is 1e-8 ZKAS; below that is float noise, not a payment.
  return delta > 1e-8 ? delta : null;
}
