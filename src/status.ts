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
  /// The daemon's own answer to "would a spend be accepted right now". Absent on
  /// daemons that predate the field, in which case `synced` is used.
  spendReady?: boolean;
  /// A confirmed balance from a previous completed sync, if we have ever had one.
  haveConfirmedBalance: boolean;
  /// Seconds remaining from a measured scan rate, or null if not yet known.
  etaSeconds: number | null;
  /// How long this wallet has been in the getting-ready state, if known.
  warmingSeconds?: number | null;
  /// The daemon has the wallet on disk but has not opened it yet, so its balance and
  /// scan progress are UNKNOWN — not zero. Absent on daemons that predate the field.
  ///
  /// Without this, a wallet that had been synced and was then re-opened (a daemon
  /// restart) reported `balance 0` while the client's own short "synced" hold kept
  /// `synced` true, and the zero fell through to "Finishing up · your balance is up to
  /// date". It said a balance of 0 was final. It was not a balance at all.
  loading?: boolean;
  /// How far the wallet's view trails the chain tip. Non-zero is normal — a wallet
  /// deliberately never ingests the newest blocks. Shown only as the caveat attached to
  /// paying while behind.
  blocksBehind?: number;
}

export type WalletPhase = "offline" | "opening" | "setting-up" | "catching-up" | "almost-ready" | "ready";

/**
 * The ONE rule for whether a wallet may start a payment. Every spend control must ask
 * this — not `status.synced` directly.
 *
 * The balance card called it "1.27 ZKAS ready to spend" (a statement about note
 * MATURITY) while Send refused with "still catching up" (a statement about SYNC), in
 * the same wallet, seconds apart. Both were individually true and together they read
 * as the app contradicting itself. Two meanings of "ready" and two separate reads of
 * the daemon's flags is how that happens; one predicate is how it stops.
 *
 * A wallet that has not finished scanning does not yet know about all of its own
 * coins, so it must not spend — a partial view can pick an already-spent note.
 */
export function walletCanSpend(s: { online: boolean; synced: boolean; spendReady?: boolean }): boolean {
  if (!s.online) return false;
  // The daemon is the authority on whether it would accept a spend. `synced` only says
  // the scan reached the tip; `/prepare` additionally requires a valid mirror tree, and
  // a wallet can satisfy the first and not the second. Prefer the daemon's own answer
  // and fall back to `synced` for daemons that predate it.
  return s.spendReady ?? s.synced;
}

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

/**
 * What to tell someone who can pay while still behind the tip.
 *
 * Two honest caveats, and only the ones that are true: money that arrived in the lag
 * window is not counted yet, and a spend made from ANOTHER device in that window is
 * invisible here (consensus rejects such a payment rather than mis-settling it, so the
 * cost is a failed send, never lost coins). Both shrink to nothing as the wallet
 * catches up, so this stays a note rather than a warning.
 */
function behindDetail(behind?: number): string {
  const window =
    behind && behind > 0
      ? `the newest ${behind.toLocaleString()} block${behind === 1 ? "" : "s"}`
      : "the newest blocks";
  return `You can send now — everything a payment needs is already in view. The wallet is still reading ${window}, so anything that arrived in them is not counted yet.`;
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
      canSpend: walletCanSpend(s),
    };
  }

  // No progress figure yet: the wallet is being loaded and genuinely knows nothing.
  // The daemon answers zeros here, which is "I don't know yet", never "you have none".
  //
  // `loading` is checked FIRST and on its own, because the other tests infer "not open
  // yet" from zeros, and inference loses to a stale `synced`: a wallet re-opened after a
  // daemon restart kept a held `synced: true` for a few seconds while reporting a zero
  // balance, sailed past this branch, and was announced as finished with 0 ZKAS. When
  // the daemon states outright that it has not opened the wallet, nothing downstream
  // may describe the balance at all.
  if (s.loading || (!s.synced && s.scannedBlocks === 0)) {
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
      canSpend: walletCanSpend(s),
    };
  }

  if (!s.synced) {
    // Behind the tip, but far enough along that the daemon will ACCEPT a payment.
    //
    // A spend proves against an anchor ~630 blocks deep, not against the chain head, so
    // a wallet that trails the tip can still hold every note and witness a payment
    // consumes. Labelling that "Catching up 99.9%" told people to wait for something
    // that had already happened — and on a wallet that hovers behind the tip, it never
    // stops telling them that. Lead with what they can do; keep the caveat, because
    // arrivals inside the lag window genuinely are not counted yet.
    if (walletCanSpend(s)) {
      return {
        phase: "catching-up",
        label: "Ready to pay · still catching up",
        detail: behindDetail(s.blocksBehind),
        pct,
        pctFine,
        progress,
        eta,
        tone: "busy",
        // The balance is NOT final — recent arrivals are still missing — but everything
        // it does show is real and spendable.
        balanceIsFinal: false,
        canSpend: true,
      };
    }
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
        canSpend: walletCanSpend(s),
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
      canSpend: walletCanSpend(s),
    };
  }

  // Scanned to the tip, but the daemon still would not accept a spend. This is the
  // state that produced the contradiction in the header comment: the scan is done, so
  // every progress signal says finished, and the card said "Ready" — then Send refused.
  // It is a real state with a real cause (the wallet's mirror of the chain tree is not
  // valid yet), it resolves on its own in seconds, and the only honest thing to do is
  // name it instead of claiming readiness the daemon will not honour.
  if (!walletCanSpend(s)) {
    return {
      phase: "almost-ready",
      label: "Finishing up",
      detail: "Your balance is up to date. The wallet is doing the last of its bookkeeping before it can pay — a few seconds.",
      pct: null,
      pctFine: null,
      progress: null,
      eta: null,
      tone: "busy",
      balanceIsFinal: true,
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
      canSpend: walletCanSpend(s),
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
    canSpend: walletCanSpend(s),
  };
}

/// `arrivalAmount` lives in `arrivals.ts`.
///
/// Deciding that money ARRIVED needs more than the balance rising: change returning from
/// your own send raises it too, and announcing that as an incoming payment is a claim the
/// user cannot check. The rule now weighs this device's own outgoing history, which does
/// not belong in a module about how a wallet's sync state reads.
