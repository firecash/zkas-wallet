import { useCallback, useEffect, useRef, useState, lazy, Suspense, useMemo} from "react";
import { createPortal } from "react-dom";
import QRCode from "qrcode";
import jsQR from "jsqr";
import { api, chainTx, findReachableDaemon, getBase, getWalletdBearer, setBase, setToken, setWalletdBearer, normalizeDaemonInput, walletdTransportError, DEFAULT_WALLETD_PORT, isNative, loadStatusCache, saveStatusCache, type ChainHistory, type ChainHistoryRow, type Status } from "./api";
import { parsePairingUri } from "./pairing";
import { attachTapHaptics, successFeedback } from "./haptics";
import { ensureNotificationPermission, notifyOs, useToast } from "./toast";
import {
  loadTxs,
  recordSend,
  reconcile,
  bumpConfTry,
  pendingTotal,
  applyChainStatus,
  saveSnapshot,
  loadSnapshot,
  type LocalTx,
} from "./localtx";
import { ensureSigner, fvkHex, generateWallet, signLocal, verifyLocal, addressFromSeed, type Network } from "./signer";
import { consolidateNonCustodial, FragmentedWalletError, sendNonCustodial, PartialSendError, MAX_CONSOLIDATION_ROUNDS, MAX_NOTES_PER_TX, type SendPart, type SendStage, type SendProgress } from "./noncustodial";
import { walletStatus, walletCanSpend, arrivalAmount } from "./status";
import { useMaintenance } from "./useMaintenance";
import { estimateDuration, recordDuration, remainingLabel } from "./timing";
import { forgetReceipts, loadBaseline, loadReceipts, recordArrival, saveBaseline, type Receipt } from "./receipts";

const WalletTools = lazy(() => import("./pages/WalletTools").then((m) => ({ default: m.WalletTools })));
import { exportFile, exportMessage } from "./exportfile";
import {
  backupWallet,
  initDesktop,
  isDesktop,
  forgetWallet,
  listBackups,
  lockVault,
  openPath,
  readBackupFile,
  setNodeSource,
  vaultStatus,
  writeBackupFile,
  type DesktopConfig,
} from "./desktop";
import { makeBackup, readBackup } from "./backup";
import { MANAGED_ZKAS_RPC, STANDALONE_ZKAS_RPC_EXAMPLE } from "./ports";
import { ACCENTS, currentAccent, currentTheme, setAccent, setTheme, type Accent, type Theme } from "./theme";
import { wipeWalletState } from "./walletstate";
import {
  activeToken,
  addWallet,
  ensureRegistered,
  listWallets,
  renameWallet,
  switchWallet,
  unregisterWallet,
  type WalletRef,
} from "./wallets";
import {
  addContact,
  findContact,
  removeContact,
  displayName,
  sortedContacts,
  updateContact,
  type Contact,
} from "./contacts";
import { disableLock, enableLock, forgetWalletLock, isLockEnabled, lockKind, sealNewSeed, unlock, unlockedDeviceSeed, allUnlockedSeeds } from "./applock";
import { bgSyncAvailable, bgSyncDisable, bgSyncEnable, bgSyncEnabled, bgSyncReconfigure } from "./bgsync";
import { getTxLabel, setTxLabel } from "./txlabels";
import { takePaymentLink } from "./paymentlinks";
import { walletNodeProfiles, walletdProfiles, type EndpointProfile } from "./connection-profiles";
import { desktopServices } from "./desktop-services";
import { ServiceLogsDialog } from "./components/ServiceLogsDialog";
import { ArrowDownLeft, ArrowUpRight, ChevronDown, Server, Settings, ShieldAlert, Trash2, WalletCards } from "lucide-react";

// navigator.clipboard is absent or throws in some native WebViews; fall back to a
// hidden textarea so "copy" never dies with an unhandled rejection on a phone.
export async function copyText(text: string) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    /* fall through */
  }
  try {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.style.position = "fixed";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand("copy");
    document.body.removeChild(ta);
    return ok;
  } catch {
    return false;
  }
}

// A zkas: shielded address is bech32 with an "orchard" version byte; a full
// decode happens on-device at send time, but this catches the obvious typo/paste
// mistakes instantly so the user gets a red/green cue while typing.
function looksLikeAddress(a: string): boolean {
  // A shielded address is a fixed-size Orchard payload → 79 bech32 chars after
  // the HRP (transparent payloads are shorter). The old guard accepted ANY length
  // ≥70 and the full [0-9a-z] range — including 1, b, i, o, which bech32 forbids —
  // so a typo'd address got the green border and only failed at send time with a
  // raw decode error. Restrict to the bech32 charset and a sane length window;
  // this stays a guard, not a second decoder — the real validation is the
  // on-device decode at send time.
  const s = a.trim();
  return /^(zkas|firecash)(test|sim|dev)?:[qpzry9x8gf2tvdw0s3jn54khce6mua7l]{60,80}$/.test(s);
}

// A scanned QR may be a bare address ("zkas:pxvt…") or a payment URI carrying
// an amount ("zkas:pxvt…?amount=1.5"). Split off the address and, if present,
// a numeric amount the caller can prefill.
function parsePaymentUri(text: string): { address: string; amount?: string; memo?: string; label?: string } {
  const s = text.trim();
  const q = s.indexOf("?");
  if (q === -1) return { address: s };
  const address = s.slice(0, q);
  const p = new URLSearchParams(s.slice(q + 1));
  const amount = p.get("amount");
  return {
    address,
    amount: amount && /^\d*\.?\d+$/.test(amount) ? amount : undefined,
    // `memo` rides into the encrypted note; `label` names the payee for the
    // sender's own address book and never leaves this device.
    memo: p.get("memo") || undefined,
    label: p.get("label") || undefined,
  };
}

/// Build the payment URI a payee hands out: address plus whatever they want
/// filled in for the payer. Everything after the address is a request, not a
/// commitment — the payer's wallet shows it and they can change it.
/// Read the clipboard for a paste button (mobile keyboards make long addresses
/// painful to type).
///
/// Programmatic READ is far less available than write: Firefox exposes
/// `readText` only to extensions, Safari gates it behind a permission prompt tied
/// to a user gesture, some WebViews refuse it outright, and on a non-secure origin
/// `navigator.clipboard` is not defined at all. There is no fallback the way
/// `copyText` has one — `execCommand("paste")` is blocked everywhere on purpose,
/// because a page that could silently read your clipboard would be a menace.
///
/// This used to return "" on every one of those, so the button did NOTHING: no
/// text, no error, no clue. Reported as "paste doesn't work on some platforms",
/// which is exactly right and exactly invisible. Now the caller can tell "the
/// clipboard was empty" from "this browser won't let me" and say so.
type PasteResult = { ok: true; text: string } | { ok: false; reason: "unavailable" | "denied" | "empty" };

async function pasteText(): Promise<PasteResult> {
  if (!navigator.clipboard?.readText) return { ok: false, reason: "unavailable" };
  let text: string;
  try {
    text = (await navigator.clipboard.readText()).trim();
  } catch {
    // Denied, dismissed, or unsupported at runtime — indistinguishable by design.
    return { ok: false, reason: "denied" };
  }
  return text ? { ok: true, text } : { ok: false, reason: "empty" };
}

/// Keep a money field to something that can actually be a number: digits, one
/// decimal point, at most 8 places (a sompi is 1e-8 ZKAS — more digits are not
/// representable and silently round). Stripping only non-[0-9.] let "1.2.3"
/// through, which parses as NaN and left the user staring at a disabled button
/// with no explanation.
function sanitizeAmountInput(raw: string): string {
  let v = raw.replace(/[^0-9.]/g, "");
  const first = v.indexOf(".");
  if (first !== -1) v = v.slice(0, first + 1) + v.slice(first + 1).replace(/\./g, "");
  const dot = v.indexOf(".");
  if (dot !== -1) v = v.slice(0, dot + 1 + 8);
  return v;
}

// "12.34500000" or "12.345" -> 12.345 (number); NaN if not a clean amount.
function parseAmount(s: string): number {
  if (!/^\d*\.?\d*$/.test(s.trim()) || s.trim() === "" || s.trim() === ".") return NaN;
  return parseFloat(s);
}

const EXPLORER = "https://explorer.zkas.info";
type Tab = "receive" | "send" | "history" | "signatures" | "tools" | "settings";

function walletTabFromHash(): Tab | null {
  if (typeof location === "undefined") return null;
  const query = location.hash.split("?", 2)[1];
  const requested = query ? new URLSearchParams(query).get("tab") : null;
  return requested && ["receive", "send", "history", "signatures", "tools", "settings"].includes(requested)
    ? requested as Tab
    : null;
}
const TAB_LABEL: Record<Tab, string> = {
  receive: "Receive",
  send: "Send",
  history: "History",
  // Signing and verifying are two halves of one idea — proving control of an
  // address — and split across two tabs they each looked like a whole feature
  // while together they crowded out the three that matter.
  signatures: "Signatures",
  // Batch payouts and manual note merging. It used to be a top-level destination
  // beside Wallet, Node and Mine, which put occasional self-hosted tooling on the
  // same footing as the whole wallet; it belongs among the wallet's own sections.
  tools: "Pay",
  settings: "Settings",
};

/// Desktop has a window; a phone has a thumb's width. Sign and Verify are real
/// capabilities that deserve to be one click away where there is room, and would
/// crowd out the three that matter where there isn't — on narrow screens they
/// live in Settings → Tools instead.
const ROOMY = () => isDesktop() || (typeof window !== "undefined" && window.innerWidth >= 900);
// Three verbs and a gear.
//
// This used to be five pills (Sign and Verify sat beside Receive/Send/History)
// AND every settings card — contacts, app lock, node source, backup, daemon —
// rendered permanently below the wallet on every single tab. The result was that
// a user's entire configuration surface sat under their money at all times, which
// reads like a debug console rather than a wallet. Everything that is not
// receiving, sending, or looking at history now lives behind the gear.
/// Receive and Send are NOT here: they are the two primary buttons under the balance.
///
/// Listing them again in the tab row put the same action on screen twice, two sizes and
/// two styles apart, which reads as two different features rather than one. The tab row
/// is now what it should always have been — where you go to LOOK at things — and the
/// buttons are what you press to DO things.
// "Pay" only where there is room for it: it is a desktop-sized tool (multi-line
// batch entry) and was never offered on Android.
const TABS: Tab[] = ROOMY() ? ["history", "signatures", "tools", "settings"] : ["history", "settings"];

/// Do two status snapshots differ in anything the UI renders?
///
/// Deliberately field-by-field rather than a deep compare: the daemon's answer
/// carries liveness fields (`updated_unix`, and scan counters that tick even when
/// the view is identical) which change every second and mean nothing on screen.
/// Comparing those would defeat the purpose.
function sameStatus(a: Status, b: Status): boolean {
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
    // Warnings/badges: a lower-bound balance (pruned node) or watch-only state
    // must appear and clear reactively, not on the next unrelated change.
    a.missing_history === b.missing_history &&
    a.watch_only === b.watch_only &&
    // Scan progress only matters while it is being shown as progress.
    (a.synced ? true : a.scanned_blocks === b.scanned_blocks && a.chain_len === b.chain_len)
  );
}

/// Same idea for the on-device send list: identity, confirmations and pending
/// state are what the History rows show.
function sameTxs(a: LocalTx[], b: LocalTx[]): boolean {
  if (a.length !== b.length) return false;
  return a.every((x, i) => x.txid === b[i].txid && x.confs === b[i].confs && x.pending === b[i].pending);
}

/// Animate a balance from its previous value to the new one.
///
/// A balance that snaps is a balance you can miss. Counting it up draws the eye to
/// exactly the thing the user opened the wallet for, and makes an arriving payment
/// feel like it lands rather than like a re-render. Short and eased-out, so it
/// reads as motion rather than as a delay: the true figure is on screen in 600ms.
///
/// The FIRST value is never animated — the wallet opening should show your balance,
/// not count up to it from zero — and anything under a tenth of a coin snaps, so
/// dust and rounding do not jitter the hero all day.
function useCountUp(value: number): number {
  const [shown, setShown] = useState(value);
  const from = useRef(value);
  const first = useRef(true);
  useEffect(() => {
    if (first.current) {
      first.current = false;
      from.current = value;
      setShown(value);
      return;
    }
    const start = from.current;
    const delta = value - start;
    if (Math.abs(delta) < 0.1 || prefersReducedMotion()) {
      from.current = value;
      setShown(value);
      return;
    }
    const t0 = performance.now();
    const DUR = 600;
    let raf = 0;
    const step = (now: number) => {
      const p = Math.min(1, (now - t0) / DUR);
      // easeOutCubic: fast to begin, settling gently onto the real number.
      const eased = 1 - Math.pow(1 - p, 3);
      setShown(start + delta * eased);
      if (p < 1) raf = requestAnimationFrame(step);
      else from.current = value;
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [value]);
  return shown;
}

function prefersReducedMotion(): boolean {
  return typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;
}

/// How many recent device-recorded sends one poll will look up confirmations for.
/// A payment split across many transactions produces a row each, and the poll runs
/// once a second — this keeps that bounded without starving a normal wallet.
const CONF_LOOKUP_LIMIT = 12;
/// Give up asking the chain about a row after this many unanswered lookups
/// (~2 min of polling) unless it is still `pending`. The chain answers about a
/// real transaction within a few seconds of it being mined; a hundred empty
/// answers means this txid will never resolve (dropped send, record from a
/// previous chain), and retrying it forever starves rows that can.
const CONF_MAX_TRIES = 120;
/// A temporary explorer/API outage must not permanently freeze a real recent send
/// at `0-conf` after CONF_MAX_TRIES. Keep retrying recent rows; the cap remains for
/// old/dead records so they cannot starve current payments.
const CONF_RECENT_RETRY_MS = 60 * 60 * 1000;

function nextConfirmationPoll(tx: LocalTx, confirmations: number | null): number {
  const age = Date.now() - tx.ts;
  if (confirmations != null && confirmations > 0) {
    if (age < 2 * 60_000) return 5_000;
    if (age < 10 * 60_000) return 15_000;
    return 60_000;
  }
  if (age < 30_000) return 1_000;
  if (age < 2 * 60_000) return 2_000;
  if (age < 10 * 60_000) return 5_000;
  return 30_000;
}

/// Which device-recorded sends History must still show as its own 0-conf rows.
///
/// A device row is suppressed ONLY when the chain reports the same transaction as
/// a SEND. Matching on txid alone was wrong: our own payment also produces change
/// coming back, and a wallet that has not yet attributed the spend records that as
/// a `received` row under the same txid. The device row was then dropped in favour
/// of a chain row that says "+ received" — the send appeared to vanish, and the
/// same payment showed up under the Received filter.
///
/// Exported for the tests: this merge is where the History tab has broken twice.
export function visibleDeviceRows(txs: LocalTx[], chainRows: { txid: string; kind: string }[]): LocalTx[] {
  const sentOnChain = new Set(chainRows.filter((r) => r.kind === "sent").map((r) => r.txid));
  return txs.filter((t) => !sentOnChain.has(t.txid));
}

/// Confirmation badge for a device-recorded send. Lookups stop ~1h after
/// broadcast (CONF_RECENT_RETRY_MS): a live count frozen mid-life would read
/// "7 confs" months later, so it settles to "confirmed". A txid the chain never
/// answered for after CONF_MAX_TRIES is not "0-conf" — it was never seen, and
/// saying otherwise claims a dead send is still live.
function confBadge(t: LocalTx): string {
  const confs = t.confs ?? 0;
  if (confs >= 1) {
    return Date.now() - t.ts > CONF_RECENT_RETRY_MS ? "confirmed" : `${confs} conf${confs === 1 ? "" : "s"}`;
  }
  if (t.confs == null && (t.confTries ?? 0) >= CONF_MAX_TRIES) return "not seen on-chain";
  // "0-conf" is exchange jargon. What the user needs to know is that the payment has
  // left and is waiting to be included in a block.
  return "sending…";
}

/// History renders windowed: a miner wallet accrues thousands of chain rows and
/// a multi-thousand-button list makes the tab unusable (and the phone hot).
const HISTORY_PAGE = 50;

/// Last snapshot written, so an unchanged balance does not rewrite localStorage
/// once a second for the lifetime of the app.
let lastSnapshotKey = "";
function snapshotDirty(s: Status): boolean {
  const key = `${s.balance_fc}|${s.spendable_fc}|${s.maturing_fc}|${s.note_count}`;
  if (key === lastSnapshotKey) return false;
  lastSnapshotKey = key;
  return true;
}

/// How many consecutive "no wallet" answers to ride out before believing them.
/// ~10s at the 1s poll: long enough to cover a daemon restart, short enough that
/// a real removal takes effect while the user is still looking at the screen.
const MISSING_TOLERANCE = 10;

/// Scroll the active tab pane to sit just under the sticky tab bar, so whatever
/// the user is here to do (type an address, read tx details) is immediately in
/// view — never the header/balance they'd have to scroll past.
///
/// **Mobile only.** On a phone the pane genuinely starts below the fold, so this
/// saves a scroll. On a desktop window the whole card is already visible, so the
/// same call just yanks the page under the user for no reason — the view jumping
/// on every tab click. Gated on viewport rather than build target so a narrow
/// desktop window (and the mobile PWA, which is not `isNative()`) still benefits.
const MOBILE_SCROLL_MAX_WIDTH = 720;

// `force` scrolls on every width, not just mobile: the post-send jump to History
// must land on the "Sent" banner at the top of the pane even on a wide desktop
// window, which the mobile-only gate would otherwise leave scrolled to wherever
// the tall Send form left it (reported live: send lands at the bottom of History).
function scrollToPane(force = false) {
  if (typeof window === "undefined") return;
  if (!force && window.innerWidth > MOBILE_SCROLL_MAX_WIDTH) return;
  requestAnimationFrame(() => {
    document.querySelector(".pane")?.scrollIntoView({ behavior: "smooth", block: "start" });
  });
}

export default function App() {
  // Boot from the cached last-known status: the whole UI (balance, address, QR)
  // renders in the first frame instead of trickling in as network calls land —
  // the 1s poll then corrects anything stale within a second.
  const [status, setStatus] = useState<Status | null>(() => loadStatusCache());
  const [showConsolidate, setShowConsolidate] = useState(false);
  const [reachable, setReachable] = useState<boolean | null>(() => (loadStatusCache() ? true : null));
  const [reachError, setReachError] = useState<string | null>(null);
  // Opens on History, not Receive. "Receive" is now a button, and landing inside it
  // meant every launch started with a QR code nobody asked for; what a person wants on
  // opening a wallet is to see that their money is there and what happened to it.
  const [tab, setTab] = useState<Tab>(() => walletTabFromHash() ?? "history");
  useEffect(() => {
    const applyWalletRoute = () => {
      const routed = walletTabFromHash();
      if (!routed) return;
      setTab(routed);
      // Consume the one-shot quick-action parameter. Normal tab changes remain
      // local UI state and Back cannot unexpectedly reopen Receive later.
      history.replaceState(null, "", `${location.pathname}${location.search}#/`);
    };
    applyWalletRoute();
    window.addEventListener("hashchange", applyWalletRoute);
    return () => window.removeEventListener("hashchange", applyWalletRoute);
  }, []);
  // Switching tabs aligns the new pane under the tab bar so its form/content is
  // instantly usable — e.g. tapping Send lands you on the address field, not on
  // the balance hero with the form below the fold. Skipped on first render so
  // opening the wallet still starts at the top with the balance visible.
  const firstTab = useRef(true);
  useEffect(() => {
    if (firstTab.current) {
      firstTab.current = false;
      return;
    }
    // The "just sent" banner/highlight lives only for the History visit right
    // after the send — navigating away retires it.
    if (tab !== "history") setJustSent(null);
    scrollToPane();
  }, [tab]);
  // A freshly created seed, held at the top level so the 4-second status poll
  // (which flips has_wallet true) can never unmount the backup screen mid-copy.
  const [freshSeed, setFreshSeed] = useState<{ seed: string; address: string } | null>(null);
  // The daemon lost this wallet's registration AND this device holds no key to
  // auto-repair with: show a recovery screen, never a bare "create a new wallet"
  // over someone's existing wallet.
  const [walletLost, setWalletLost] = useState(false);
  const recoveryNeeded = useRef(false);
  // On-device send history; drives the optimistic (0-conf) balance and History tab.
  const [txs, setTxs] = useState<LocalTx[]>(() => loadTxs());
  const [receipts, setReceipts] = useState<Receipt[]>(() => loadReceipts());
  // Consecutive polls answering "no wallet"; see the guard in `refresh`.
  const missingPolls = useRef(0);
  // Auto-repair state: when the daemon has genuinely forgotten this token's
  // wallet (server-side GC, a wiped wallet dir, a fresh hosted instance) but
  // this device holds the seed, we re-register the viewing key ourselves
  // instead of dumping the user into onboarding. Capped attempts so a real
  // removal (which wipes the device seed — so it never reaches this path) and
  // a permanently-refusing daemon both still end at onboarding.
  const repairAttempts = useRef(0);
  const lastRepairAt = useRef(0);
  const repairNeeded = useRef(false);
  // A status poll can overlap the previous one while a cold wallet is loading.
  // Keep one repair operation in flight; otherwise several polls can all call
  // `/watch` and start duplicate reloads for the same wallet.
  const repairInFlight = useRef(false);
  // Consecutive FAILED status calls. One network blip must not flip the app to
  // the "can't reach the wallet service" screen — that unmounts the whole wallet
  // (a half-filled Send form included) and oscillates on a flaky connection.
  const failedPolls = useRef(0);
  // Notification permission is requested only once a wallet actually exists —
  // a prompt before that is noise users refuse, and a refusal is sticky.
  const notifAsked = useRef(false);
  /// Last balance seen while the wallet was FULLY synced, so an arrival is a real
  /// arrival and not the scan still finding notes. null until the first final reading.
  // Seeded from storage, NOT null. A baseline that resets on every launch cannot
  // notice anything that happened between launches — which is precisely when the
  // Android worker is doing its job and notifying about incoming payments.
  const lastFinalBalance = useRef<number | null>(loadBaseline());
  /// True until the first final reading of this session, so an arrival found by
  /// comparing against the STORED baseline can be told apart from one watched live.
  const firstFinalRead = useRef(true);
  const toast = useToast();
  const refreshInFlight = useRef(false);
  const confirmationNextAt = useRef(new Map<string, number>());
  const confirmationInFlight = useRef(new Set<string>());

  const pollConfirmations = useCallback(async (list: LocalTx[]) => {
    const now = Date.now();
    const eligible = list
      .filter(
        (tx) =>
          tx.pending ||
          now - tx.ts < CONF_RECENT_RETRY_MS ||
          (tx.confs == null && (tx.confTries ?? 0) < CONF_MAX_TRIES),
      )
      .filter(
        (tx) =>
          !confirmationInFlight.current.has(tx.txid) &&
          (confirmationNextAt.current.get(tx.txid) ?? 0) <= now,
      )
      .slice(0, CONF_LOOKUP_LIMIT);
    if (!eligible.length) return;

    for (const tx of eligible) {
      confirmationInFlight.current.add(tx.txid);
      // Reserve before awaiting: another status tick cannot launch the same fetch.
      confirmationNextAt.current.set(tx.txid, now + nextConfirmationPoll(tx, tx.confs ?? null));
    }
    const answers = await Promise.all(eligible.map(async (tx) => [tx, await chainTx(tx.txid)] as const));
    let updated = loadTxs();
    for (const [tx, answer] of answers) {
      confirmationInFlight.current.delete(tx.txid);
      confirmationNextAt.current.set(tx.txid, Date.now() + nextConfirmationPoll(tx, answer?.confirmations ?? null));
      updated = answer?.confirmations != null ? applyChainStatus(tx.txid, answer.confirmations) : bumpConfTry(tx.txid);
    }
    setTxs((previous) => (sameTxs(previous, updated) ? previous : updated));
  }, []);

  // Hysteresis timers: the 1s poll can flip `synced` and `warming` for a beat
  // (a block lands, the background warm re-runs) and rendering every flip made the
  // hero text flap "synced" ↔ "syncing" ↔ "speeding up" — unsettling to watch.
  // A state change is only shown once it has held for a few seconds; brief dips
  // keep displaying the previous steady state.
  const unsyncedSince = useRef<number | null>(null);
  const warmingSince = useRef<number | null>(null);

  const refresh = useCallback(async () => {
    if (refreshInFlight.current) return;
    refreshInFlight.current = true;
    try {
      const s = await api.status();
      // Never let a transient poll un-render the wallet. While the daemon is reloading a
      // wallet (or a status call races a sync pass) it can answer has_wallet:false /
      // address:null for a beat. Rendering that verbatim unmounted the whole tab block —
      // the address and QR blinked out and the layout jumped on every such poll. Once we
      // have seen a wallet, keep showing it and just take the fresh numbers.
      setStatus((prev) => {
        const now = Date.now();
        // synced: hold a displayed "synced" through dips shorter than 6s.
        if (s.synced) unsyncedSince.current = null;
        else if (unsyncedSince.current == null) unsyncedSince.current = now;
        const syncedStable = s.synced || (!!prev?.synced && now - (unsyncedSince.current ?? now) < 6000);
        // warming: only show the warm-up notice once it has held for 8s — the
        // steady-state background catch-up flips it on for a moment after every
        // new block, and that must not flash the notice.
        if (!s.warming) warmingSince.current = null;
        else if (warmingSince.current == null) warmingSince.current = now;
        const warmingStable = !!s.warming && now - (warmingSince.current ?? now) >= 8000;
        const stable = { ...s, synced: syncedStable, warming: warmingStable };
        // Hold a known wallet through a TRANSIENT "no wallet" answer (the daemon
        // reloading, or a status racing a sync pass) — but only transiently. This
        // guard used to be unconditional, so a wallet the user had deliberately
        // removed was resurrected on every poll and the app looked like it had
        // ignored them. After MISSING_TOLERANCE consecutive denials we believe it.
        if (s.has_wallet && s.address) {
          missingPolls.current = 0;
          repairAttempts.current = 0;
        } else missingPolls.current += 1;
        const transient = missingPolls.current <= MISSING_TOLERANCE;
        const denied = !!prev?.has_wallet && (!s.has_wallet || !s.address);
        // Out of grace with a wallet on record: if this device holds the seed,
        // the daemon has LOST the registration — re-register the viewing key
        // (fired just below the setStatus, never inside it) and hold the wallet
        // UI while the repair is in flight. The server is disposable; the
        // device is the wallet.
        // Out of grace with a wallet on record: the daemon has LOST the
        // registration. Arm a SILENT repair — the direct device seed, or the
        // orphan scan (the key can sit under a stale token; see
        // findOrphanedSeed). The user must never see a recovery prompt for a
        // key this device already holds.
        const registeredAddress = listWallets().find((w) => w.token === activeToken())?.address ?? null;
        // Evidence THIS TOKEN has ever had a wallet, from token-scoped storage only.
        //
        // `prev` is the previous poll's status. Every path that changes wallet reloads
        // the page, so today it always belongs to the active token — but nothing
        // enforces that, and if a future switch ever skips the reload, `prev` becomes a
        // previous WALLET's address. That address then feeds `missingKnownWallet` below,
        // which forces `has_wallet: true` and displays it: a brand-new wallet showing
        // the old one's address, and a repair that re-registers the old seed under the
        // new token. Reported as "I create a new wallet and see the old one copied".
        //
        // So the DECISION uses only per-token evidence. `prev` is still allowed to fill
        // the address in for display continuity below, but it can no longer be the
        // reason we believe a wallet exists.
        const tokenScopedAddress = loadStatusCache()?.address ?? registeredAddress;
        const cachedAddress = tokenScopedAddress;
        const hasLocalKey = !!(getDeviceSeed() || cachedAddress);
        // A cold boot can answer `has_wallet:false` before the first successful
        // status, so `denied` is false even though the cached wallet is known.
        // Treat that as the same recoverable server-side registration loss once
        // the normal transient grace has elapsed.
        const missingKnownWallet = (!s.has_wallet || !s.address) && !!cachedAddress;
        if ((denied || missingKnownWallet) && !transient && repairAttempts.current < 3 && hasLocalKey && !repairInFlight.current)
          repairNeeded.current = true;
        const holdForRepair =
          (denied || missingKnownWallet) &&
          hasLocalKey &&
          (repairInFlight.current || (repairAttempts.current > 0 && now - lastRepairAt.current < 20_000));
        // The hold is ending and no repair can run (this device holds no key for
        // the wallet under ANY token): do NOT drop to "create a new wallet" —
        // surface the recovery screen instead. A user watching their wallet
        // vanish into onboarding panic-creates over the existing one.
        if ((denied || missingKnownWallet) && !transient && !holdForRepair && !(repairAttempts.current < 3 && hasLocalKey))
          recoveryNeeded.current = true;
        const next =
          (denied || missingKnownWallet) && (transient || holdForRepair)
            ? { ...stable, has_wallet: true, address: s.address ?? prev?.address ?? cachedAddress }
            : stable;
        // Return the PREVIOUS object when nothing meaningful moved, so React
        // bails out instead of re-rendering.
        //
        // This poll runs every second and used to hand back a fresh object every
        // time, re-rendering the entire tree 60×/minute for a wallet that had not
        // changed. On Android that dismisses the native paste bubble before the
        // user can tap it (reported: "I can't paste my seed, the Paste button
        // disappears") and interrupts momentum scrolling. `updated_unix` and other
        // liveness fields tick constantly and are deliberately not compared —
        // only what is actually displayed.
        return prev && sameStatus(prev, next) ? prev : next;
      });
      // Fire the armed auto-repair OUTSIDE the state updater (updaters must be
      // pure): re-register this wallet's viewing key from the device seed, with
      // the remembered birthday so the rescan starts at the wallet's birth, not
      // genesis. The poll's own hold keeps the wallet UI up meanwhile.
      // Fire the armed repair OUTSIDE the state updater (updaters must be
      // pure). Silent order: the active token's seed, then an orphan scan by
      // the last-known address (stale-token misfiles) — the user is only ever
      // asked for a seed when this device genuinely holds none.
      if (repairNeeded.current) {
        repairNeeded.current = false;
        repairAttempts.current += 1;
        lastRepairAt.current = Date.now();
        repairInFlight.current = true;
        void (async () => {
          try {
            let seed = getDeviceSeed();
            if (!seed) {
              const addr = loadStatusCache()?.address;
              if (addr) seed = await findOrphanedSeed(addr);
            }
            if (seed) await api.watch(await fvkHex(seed), walletBirthday());
          } catch {
            /* a later poll re-arms while attempts remain */
          } finally {
            repairInFlight.current = false;
          }
        })();
      }
      // The wallet is back on the daemon (repair succeeded or never lost) — any
      // recovery screen must go. And the inverse: the updater flagged that the
      // hold expired with no repair possible → show recovery, not onboarding.
      if (s.has_wallet && s.address) setWalletLost(false);
      if (recoveryNeeded.current) {
        recoveryNeeded.current = false;
        setWalletLost(true);
      }
      saveStatusCache(s);
      failedPolls.current = 0;
      setReachError(null);
      setReachable(true);
      // Ask for notification permission only once a wallet actually exists —
      // before that the prompt is noise users refuse, and a refusal is sticky.
      if (s.has_wallet && !notifAsked.current) {
        notifAsked.current = true;
        void ensureNotificationPermission();
      }
      // Announce money ARRIVING. The wallet knew — the number changed — but it never
      // said so, and a payment you have to notice yourself is a payment you distrust.
      //
      // Only ever compares two FINAL balances. A scan reports what it has found so far,
      // climbing from zero, so comparing mid-scan would announce a "payment" for every
      // note the wallet rediscovers about itself. `synced && !warming` is the same
      // condition `balanceIsFinal` uses; the first final reading only sets the baseline.
      if (s.synced && !s.warming && s.has_wallet) {
        const now = parseFloat(s.balance_fc || "0");
        const gained = arrivalAmount(lastFinalBalance.current, now, true);
        const whileAway = firstFinalRead.current;
        firstFinalRead.current = false;
        if (gained !== null) {
          const amount = trimFc(gained.toFixed(8));
          // Write it down before announcing it. With chain history off, History holds
          // only sends from this device, so a receive had nowhere to live at all —
          // the phone said "+11 ZKAS arrived" and the app, opened seconds later,
          // showed nothing. A notification you cannot corroborate is worse than none.
          setReceipts(recordArrival(gained, whileAway));
          // An arrival found on opening was almost certainly already announced by the
          // background worker that woke for it. Saying it twice is noise; the record
          // above is the part that was missing.
          if (!whileAway) notifyOs("ZKAS received", `+${amount} ZKAS arrived in your wallet.`);
          toast.show("good", `Received ${amount} ZKAS`);
          successFeedback();
        }
        lastFinalBalance.current = now;
        saveBaseline(now);
      }
      let list = reconcile(parseFloat(s.balance_fc || "0"), !!s.synced);
      // Ask the chain about every send that has no confirmation count yet — NOT
      // just the ones still flagged `pending`.
      //
      // `pending` means "the daemon's balance has not dropped yet", and `reconcile`
      // clears it as soon as it does (~3 min) or after the 20-minute age-out. That
      // is routinely BEFORE the chain has answered about the transaction, and the
      // old filter then stopped asking forever, leaving `confs` undefined and the
      // row rendering "0-conf" for the rest of its life. The two states are
      // unrelated: one drives the optimistic balance, the other is display.
      //
      // Three rules keep this loop from being the thing that makes confirmations
      // LATE (as it briefly was): lookups run in PARALLEL, not one awaited fetch
      // after another (12 sequential cross-network requests turned a "1-second"
      // poll into ~10+ seconds, so a fresh send's count crawled); a row the chain
      // has repeatedly not answered for stops being asked after CONF_MAX_TRIES
      // (dead txids — dropped sends, pre-relaunch records — were eating the whole
      // budget forever); and each fetch carries its own 4s timeout (in chainTx)
      // so one hung request cannot stall the poll.
      // A poll has no authority to DELETE this device's own send record — it only
      // ever updates confirmations and the pending flag. `reconcile` re-reads
      // localStorage under `wallet_token`, so if that key is momentarily absent or
      // has just been rotated (wallet switch, restore, desktop shell handing back a
      // new token), it answers [] for a wallet that really does have rows, and this
      // line used to write that emptiness straight into the UI: the History tab
      // painted the row from the initial `useState(loadTxs)` snapshot and the first
      // 1-second poll wiped it. Rows are removed only by an explicit wallet wipe.
      setTxs((prev) => (sameTxs(prev, list) ? prev : list.length === 0 && prev.length > 0 ? prev : list));
      // Confirmation lookups have their own schedule and never hold the one-second
      // balance/sync poll hostage to a slow explorer request.
      void pollConfirmations(list);
      // Remember a balance the daemon actually knows, so a later reload/restart — when
      // it answers with zeros while rebuilding — has something honest to show instead.
      // Keep the wallet registry in step: a wallet that existed before the
      // switcher (or one just created) must appear in the list, with an address
      // recognisable enough to pick from.
      if (s.has_wallet && s.address) {
        const t = localStorage.getItem("wallet_token");
        if (t) ensureRegistered(t, s.address);
      }
      // ONLY snapshot a SYNCED wallet. A mid-scan balance is a partial count that
      // climbs from zero, so saving it overwrote the last known good figure with a
      // fraction of it — the safety net eating itself. A pool wallet rescanning at
      // 5% saved "29,703" over the true "423,997", and from then on even the
      // fallback was wrong.
      if (s.has_wallet && s.synced && s.scanned_blocks > 0 && snapshotDirty(s)) {
        saveSnapshot({
          balanceFc: parseFloat(s.balance_fc || "0"),
          spendableFc: spendableFc(s),
          maturingFc: maturingFc(s),
          noteCount: s.note_count,
          ts: Date.now(),
        });
      }
    } catch (error) {
      // One failed poll (a flaky mobile hop, a proxy 502, a slow cold load) used
      // to flip the whole app to the "can't reach the wallet service" screen
      // INSTANTLY — unmounting the wallet (and a half-filled Send form) and
      // oscillating every second on a bad connection. Ride out a few failures;
      // the last-known UI stays up meanwhile, and a real outage still surfaces.
      failedPolls.current += 1;
      if (failedPolls.current >= 5) {
        setReachError((error as Error)?.message || String(error));
        setReachable(false);
      }
    } finally {
      refreshInFlight.current = false;
    }
  }, [pollConfirmations]);


  // Called by Send the instant a tx is broadcast: record it, jump straight to
  // History (highlighting the new row) so the confirmations can be watched
  // arriving live, and answer with a success haptic on the phone.
  const [justSent, setJustSent] = useState<string | null>(null);
  // "Send again" from a transaction carries the recipient across to the form.
  const [sendPrefill, setSendPrefill] = useState<string | null>(null);

  // Keep the wallet payable. A payment can spend at most ~38 notes, so a wallet
  // that accumulates more cannot pay its own balance in one transaction — and the
  // daemon's own merger cannot fix that for a non-custodial wallet, because
  // merging is a spend and it holds no spend key (measured on the hosted daemon:
  // zero merges ever, every over-ceiling wallet skipped as watch-only). Doing it
  // here, where the key is, means the count stays low and ordinary payments remain
  // single-transaction — which is what makes them all-or-nothing for free.
  useMaintenance({
    status,
    token: activeToken() ?? "default",
    network: networkOf(status),
    // Never compete with something the user is waiting on.
    busy: showConsolidate || tab === "send" || justSent !== null,
    getSeed: () => resolveDeviceSeed(status?.address ?? undefined),
    onMerged: () => void refresh(),
  });
  useEffect(() => {
    const open = () => {
      const request = takePaymentLink();
      if (!request) return;
      setJustSent(null);
      setSendPrefill(request);
      setTab("send");
      scrollToPane(true);
    };
    open();
    window.addEventListener("zkas-payment-link", open);
    return () => window.removeEventListener("zkas-payment-link", open);
  }, []);
  // A payment arrives here as one row per transaction it took — usually one, but
  // several when the amount needed more notes than a single transaction can spend.
  // `opts.stay` records the rows WITHOUT the jump to History: a partially-sent
  // payment must keep the Send screen mounted so its error stays visible.
  const onSent = useCallback(
    (sent: Omit<LocalTx, "pending">[], opts?: { stay?: boolean }) => {
      let list = loadTxs();
      for (const tx of sent) list = recordSend(tx);
      setTxs(list);
      // Highlight the first transaction of the payment: it is the one the History
      // tab scrolls to, and the parts are recorded newest-first above it.
      setJustSent(sent[0]?.txid ?? null);
      if (opts?.stay) return;
      setTab("history");
      successFeedback();
      refresh();
      // Land at the top of History (the "Sent" banner) on every width — the tab
      // effect's scrollToPane is mobile-only and would leave a desktop window
      // scrolled to the bottom where the Send form's send button sat.
      scrollToPane(true);
    },
    [refresh],
  );

  // Native app: every tap on a control answers with a soft haptic tick.
  useEffect(() => attachTapHaptics(), []);

  // Warm the signer WASM in the background right after first paint, so the first
  // send/sign never waits on its (lazily-chunked) download + compile.
  useEffect(() => {
    const t = setTimeout(() => void ensureSigner().catch(() => {}), 800);
    return () => clearTimeout(t);
  }, []);

  useEffect(() => {
    refresh();
    // Keep Android's background-sync worker pointed at the ACTIVE wallet and
    // current daemon URL — wallet switches and daemon changes reload the app,
    // so this one boot-time call covers every rotation.
    void bgSyncReconfigure();
    // Notification permission is NOT requested here: it fires from `refresh` once
    // a wallet actually exists — a prompt before that is noise users refuse, and
    // a refusal is sticky.
    // 1s, not 4s: the daemon now sees a payment in the mempool within a second of it
    // being broadcast, so a slow poll here would be the only thing left making a payment
    // feel sluggish. The call is a cheap read of in-memory state.
    const t = setInterval(refresh, 1000);
    return () => clearInterval(t);
  }, [refresh]);

  return (
    <div className={`wrap wallet-wrap${status?.has_wallet ? " has-wallet" : ""}`}>
      <div className="wallet-topline">
        <WalletBar />
        <ConnectionButton />
        <HostedNotice />
      </div>
      {/* First-ever open (nothing cached yet): a designed connecting state while the
          first status call is in flight, never a stretch of empty page. A shield
          drawing itself, over the wallet's two promises. */}
      {reachable === null && !status && (
        <div className="card connecting">
          <div className="connect-shield" aria-hidden="true">
            <svg viewBox="0 0 48 56" width="52" height="60">
              <path
                className="connect-shield-path"
                d="M24 2 L44 10 V26 C44 40 35 50 24 54 C13 50 4 40 4 26 V10 Z"
                fill="none"
                stroke="var(--ember)"
                strokeWidth="2.5"
                strokeLinejoin="round"
              />
              <path
                className="connect-shield-check"
                d="M16 27 L22 34 L33 20"
                fill="none"
                stroke="var(--ember)"
                strokeWidth="2.5"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
          </div>
          <div className="connect-title">Opening your private wallet</div>
          <div className="connect-sub">
            <span className="connect-pill">Zero-knowledge</span>
            <span className="connect-pill">Seconds to sync</span>
          </div>
        </div>
      )}
      {reachable === false && <Setup error={reachError} />}
      {/* Seed backup takes priority and stays until dismissed — independent of has_wallet. */}
      {reachable && freshSeed && (
        <SeedBackup seed={freshSeed.seed} address={freshSeed.address} onDone={() => setFreshSeed(null)} />
      )}
      {reachable && !freshSeed && walletLost && (
        <RecoverWallet onRecovered={refresh} onStartOver={() => setWalletLost(false)} />
      )}
      {reachable && !freshSeed && !walletLost && status && !status.has_wallet && (
        <Onboard status={status} onCreated={(seed, address) => setFreshSeed({ seed, address })} onImported={refresh} />
      )}
      {reachable && !freshSeed && status && status.has_wallet && (
        <div className="wallet-dashboard">
          <section className="wallet-overview" aria-label="Wallet balance and actions">
            <BalanceHero status={status} txs={txs} />
          {/* The two things people open a wallet to DO, as the two biggest targets on
              the screen.
              Before this they were tabs — 13px text in a 9px-padded pill, the same
              weight as "History" and the settings gear, and well under the ~44px a
              thumb needs. Sending and receiving are not navigation; every wallet people
              rate highly (Kaspium, Cake, Phantom) puts them here, directly under the
              balance, and leaves the tabs for browsing.
              Send explains itself rather than failing: while the wallet cannot spend yet
              it is disabled and says why, instead of accepting a tap and erroring. */}
            <div className="quick-actions">
              <button
                className="qa qa-receive"
                onClick={() => setTab("receive")}
                aria-label="Receive ZKAS"
              >
                <ArrowDownLeft className="qa-icon" aria-hidden="true" size={19} strokeWidth={2.2} />
                <span className="qa-label">Receive</span>
              </button>
              <button
                className="qa qa-send"
                onClick={() => setTab("send")}
                // The single spend predicate — see `walletCanSpend`. A synced wallet
                // may spend, including while it is still warming up. An unsynced one
                // may not: it does not yet know about all of its own notes.
                disabled={!walletCanSpend({ online: true, synced: status.synced, spendReady: status.spend_ready })}
                aria-label="Send ZKAS"
              >
                <ArrowUpRight className="qa-icon" aria-hidden="true" size={19} strokeWidth={2.2} />
                <span className="qa-label">Send</span>
              </button>
              <button
                className="qa qa-consolidate"
                onClick={() => setShowConsolidate(true)}
                disabled={!walletCanSpend({ online: true, synced: status.synced, spendReady: status.spend_ready }) || (status.note_count ?? 0) < 3}
                aria-label="Consolidate wallet notes"
              >
                <span className="qa-label">Consolidate</span>
                <span className="qa-detail">{status.note_count ?? 0} notes</span>
              </button>
            </div>
            {showConsolidate && (
              <ConsolidateDialog
                status={status}
                onClose={() => setShowConsolidate(false)}
                onDone={() => {
                  setShowConsolidate(false);
                  void refresh();
                }}
              />
            )}
          </section>
          <section className="wallet-workspace" aria-label="Wallet activity">
            <div className="tabs" role="tablist" aria-label="Wallet sections">
            {TABS.map((t) => (
              <button
                key={t}
                role="tab"
                aria-selected={tab === t}
                aria-label={t === "settings" ? "Settings" : TAB_LABEL[t]}
                className={`${tab === t ? "active" : ""}${t === "settings" ? " gear" : ""}`}
                onClick={() => setTab(t)}
                onKeyDown={(e) => {
                  // Arrow keys move between tabs, as a tablist is expected to.
                  if (e.key !== "ArrowRight" && e.key !== "ArrowLeft") return;
                  e.preventDefault();
                  const i = TABS.indexOf(t);
                  setTab(TABS[(i + (e.key === "ArrowRight" ? 1 : TABS.length - 1)) % TABS.length]);
                }}
              >
                {t === "settings" ? <Settings aria-hidden="true" size={20} strokeWidth={2.4} /> : TAB_LABEL[t]}
              </button>
            ))}
            </div>
          {/* Receive and Send are reached by the buttons above, so no tab is lit while
              one is open. That needs its own way out — without it the only escape is a
              tab that changes the subject. */}
          {(tab === "receive" || tab === "send") && (
            <button className="pane-back" onClick={() => setTab("history")} aria-label="Close">
              ← Back
            </button>
          )}
          {/* key remounts the pane on tab switch so the entrance transition plays. */}
            <div className="pane appear" key={tab}>
            {tab === "receive" && <Receive status={status} />}
            {tab === "send" && (
              <Send
                status={status}
                onSent={onSent}
                prefillTo={sendPrefill}
                onPrefillConsumed={() => setSendPrefill(null)}
                outflow={pendingTotal(txs)}
              />
            )}
            {tab === "history" && (
              <History
                txs={txs}
                receipts={receipts}
                justSent={justSent}
                synced={!!status?.synced}
                onSendAnother={(prefill) => {
                  setJustSent(null);
                  setSendPrefill(prefill ?? null);
                  setTab("send");
                }}
              />
            )}
            {tab === "signatures" && <Signatures status={status} />}
            {tab === "tools" && (
              <Suspense fallback={<div className="card"><div className="muted small">Loading…</div></div>}>
                <WalletTools />
              </Suspense>
            )}
            {tab === "settings" && <SettingsPane status={status} />}
            </div>
          </section>
        </div>
      )}
    </div>
  );
}

/// The signing seed kept on THIS device (localStorage, scoped to the wallet
/// token). Stored at create/import so sends sign silently on-device — the user
/// is never asked to re-type it. Clearing site data forgets it; Send then asks
/// once and re-remembers.
function deviceSeedKey(): string {
  return `device_seed_${localStorage.getItem("wallet_token") || "default"}`;
}
export function getDeviceSeed(): string {
  // With the app lock on, the seed exists only in memory for the current
  // session — nothing readable is left in storage to fall back to. One
  // exception: the `seed_unsealed_` fallback, written when sealing a new
  // wallet's key FAILED (an auto-lock raced its creation). That copy is the
  // difference between a flagged-but-saved key and a lost wallet, so it is
  // readable even while locked.
  const unlocked = unlockedDeviceSeed();
  if (unlocked) return unlocked;
  if (isLockEnabled()) {
    const token = localStorage.getItem("wallet_token") || "default";
    if (localStorage.getItem(`seed_unsealed_${token}`)) return localStorage.getItem(deviceSeedKey()) || "";
    return "";
  }
  return localStorage.getItem(deviceSeedKey()) || "";
}
export function setDeviceSeed(seed: string) {
  if (!seed) return;
  // With the lock on, keep the seed SEALED rather than in the clear — and
  // never simply drop it. This used to `return` early, so creating, importing
  // or restoring a wallet while locked stored nothing at all: a wallet that
  // could not spend and whose key was gone on reload. Losing a key is a worse
  // outcome than any it was protecting against.
  if (isLockEnabled()) {
    const token = localStorage.getItem("wallet_token") || "default";
    void sealNewSeed(token, seed).then((ok) => {
      if (!ok) {
        // Sealing failed (an auto-lock raced this creation/import). NEVER drop a
        // key silently again: fall back to plaintext storage and flag it, so the
        // key survives and the state is discoverable. Losing the key is worse
        // than storing it unsealed — that is the principle this path exists on.
        localStorage.setItem(deviceSeedKey(), seed);
        localStorage.setItem(`seed_unsealed_${token}`, "1");
      }
    });
    return;
  }
  localStorage.setItem(deviceSeedKey(), seed);
}

/// The wallet's scan birthday (DAA height) remembered per token. Backup files
/// must carry it — a backup written with birthday 0 makes every restore rescan
/// from genesis (minutes to an hour) even for a wallet born yesterday. Written
/// at watch/restore time, swept with the rest of the wallet's state.
function birthdayKey(): string {
  return `birthday_${localStorage.getItem("wallet_token") || "default"}`;
}
function rememberBirthday(daa: number): void {
  if (!(daa > 0)) return;
  try {
    localStorage.setItem(birthdayKey(), String(Math.floor(daa)));
  } catch {
    /* best-effort — a missing birthday just means a longer rescan on restore */
  }
}
function walletBirthday(): number {
  const v = Number(localStorage.getItem(birthdayKey()) || "0");
  return Number.isFinite(v) && v > 0 ? Math.floor(v) : 0;
}

/// A seed stored under a STALE token. Token rotations and the registry/switcher
/// era could orphan `device_seed_<oldToken>` while the active token holds
/// nothing — the wallet then claims "this device doesn't hold the key" while
/// the key is RIGHT HERE under another key name, and without this scan the
/// coins are stuck forever. Match every on-device seed by derived address and
/// reattach the match to the active token.
async function findOrphanedSeed(expectedAddress: string): Promise<string> {
  const candidates = new Set<string>();
  for (let i = 0; i < localStorage.length; i++) {
    const k = localStorage.key(i);
    if (k?.startsWith("device_seed_")) {
      const v = localStorage.getItem(k);
      if (v && /^[0-9a-fA-F]{64}$/.test(v)) candidates.add(v.trim());
    }
  }
  // Unsealed lock-record seeds too (a locked device's seeds live only in memory).
  for (const v of Object.values(allUnlockedSeeds() ?? {})) candidates.add(v.trim());
  if (candidates.size === 0) return "";
  const net: Network = expectedAddress.startsWith("zkastest:") ? "testnet" : "mainnet";
  for (const seed of candidates) {
    try {
      if ((await addressFromSeed(seed, net)) === expectedAddress) return seed;
    } catch {
      /* not a usable seed — keep looking */
    }
  }
  return "";
}

/// Thrown when this device has no key for the wallet and the daemon has none to
/// give (a watch-only wallet opened on a new device) — the caller then asks the
/// user to restore it from their seed.
export const SEED_REQUIRED = "SEED_REQUIRED";

/// The seed to sign with. From this device's storage first; then a stale-token
/// orphan scan (the key may be present under another token — that is the
/// difference between "lost" and "misfiled"); then, for wallets created under
/// the old hosted model, the daemon's custodial copy; a watch-only wallet on a
/// fresh device has none of these — the user must restore from their backup.
export async function resolveDeviceSeed(expectedAddress?: string): Promise<string> {
  const stored = getDeviceSeed();
  if (stored) return stored;
  if (expectedAddress) {
    const orphan = await findOrphanedSeed(expectedAddress);
    if (orphan) {
      setDeviceSeed(orphan); // reattach under the active token
      return orphan;
    }
  }
  try {
    const r = await api.reveal();
    setDeviceSeed(r.seed_hex);
    return r.seed_hex;
  } catch {
    throw new Error(SEED_REQUIRED);
  }
}

function HostedNotice() {
  // Installed builds already are the safer recommendation. Repeating that fact on
  // every screen spends scarce phone space and made the Tauri app look like a web
  // wallet, so only the actual browser gets this note.
  if (isDesktop() || isNative()) return null;
  // Web: one calm line, one recommendation. Whatever goes here is parked permanently
  // above the balance, so anything beyond a single sentence pushes the actual wallet
  // below the fold — which is what a multi-line version of this used to do.
  return (
    <div className="warnbar" role="note">
      <ShieldAlert className="warnbar-icon" aria-hidden="true" size={17} strokeWidth={2.2} />
      <div>
        {/* Say which is safer, and WHY — the difference is real and specific, and stating
            it plainly is worth more than a vague "strongest setup".

            A browser re-downloads the code that touches your seed on EVERY visit, so this
            page can only ever be as trustworthy as the server that served it and the
            connection that carried it. An installed app ships that code once, signed. Same
            keys, same protocol; different amount of trust required per use.

            Not alarmist, because the seed genuinely never leaves the device either way —
            but a user choosing where to keep real money deserves to know the difference
            rather than discover it. */}
        {/* One recommendation, not a menu.
            This had grown into a list — app, paper wallet, self-host — and a banner that
            offers three options gives none of them any weight. Self-hosting is for a
            handful of people and its links already live in the Daemon card; a paper
            wallet answers a different question entirely. The one thing worth saying to
            somebody holding real money in a browser tab is: the app is safer, go get it. */}
        {/* Deliberately does NOT claim the seed never leaves this device.
            It said that until a user pointed out the sentence contradicted itself: if the
            page re-downloads the code that touches the seed from a server on every visit,
            then a compromised server can make that promise false. It is a guarantee only
            the signed app can make, so only the app makes it. Saying it here would be
            exactly the kind of assurance somebody relies on and later regrets. */}
        Browser wallet. {" "}
        <b>
          <a href="https://github.com/firecash/zkas-wallet/releases" target="_blank" rel="noreferrer">
            Get the safer app
          </a>
        </b>
        .
      </div>
    </div>
  );
}

/// Which wallet you are looking at — on the main screen, not buried in settings.
///
/// Switching wallets is a thing people do constantly (spending vs savings, work
/// vs personal); settings is where you go once. So the active wallet is named in
/// the open, directly above the balance it belongs to, and one tap swaps it. This
/// is also the honest place for it: a balance with no visible owner invites
/// exactly the "wait, which wallet is this?" mistake that ends in a payment from
/// the wrong one.
function WalletBar() {
  const [open, setOpen] = useState(false);
  const [, bump] = useState(0);
  useEffect(() => {
    const h = () => bump((n) => n + 1);
    window.addEventListener("wallets-changed", h);
    return () => window.removeEventListener("wallets-changed", h);
  }, []);

  const active = activeToken();
  const wallets = listWallets();
  const current = wallets.find((w) => w.token === active);

  return (
    <>
      <button className="walletbar" onClick={() => setOpen(true)} aria-label="Switch wallet">
        <WalletCards aria-hidden="true" size={18} strokeWidth={2.2} />
        <span className="walletbar-name">{current?.label ?? "Wallet 1"}</span>
        <span className="walletbar-chev" aria-hidden="true">
          <ChevronDown size={16} strokeWidth={2.2} />
        </span>
      </button>
      {open && <WalletSwitcher onClose={() => setOpen(false)} />}
    </>
  );
}

/**
 * The connection is daily-use state, not a buried preference. On desktop this
 * selects the ZKAS node read by the embedded wallet engine. On web/mobile it
 * selects a hosted or self-run walletd. The two are deliberately separate:
 * pointing the desktop webview at an arbitrary walletd would bypass the
 * embedded, locally-held wallet and weaken the desktop custody model.
 */
function ConnectionButton() {
  const desktop = isDesktop();
  const [open, setOpen] = useState(false);
  const [cfg, setCfg] = useState<DesktopConfig | null>(null);
  const [profiles, setProfiles] = useState<EndpointProfile[]>([]);
  const [name, setName] = useState("");
  const [address, setAddress] = useState("");
  const [bearer, setBearer] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [scanning, setScanning] = useState(false);

  const refresh = useCallback(async () => {
    if (desktop) {
      setProfiles(walletNodeProfiles.load());
      setCfg(await initDesktop());
    } else {
      setProfiles(walletdProfiles.load());
    }
  }, [desktop]);

  useEffect(() => {
    void refresh().catch(() => undefined);
  }, [refresh]);

  const currentBase = getBase();
  const hosted = !desktop && (currentBase.includes("wallet.zkas.info") || currentBase.endsWith("/daemon"));
  const currentProfile = profiles.find((profile) => {
    const current = desktop ? cfg?.node_addr : currentBase;
    return current?.replace(/\/$/, "").toLowerCase() === profile.address.replace(/\/$/, "").toLowerCase();
  });
  const label = desktop
    ? cfg?.mode === "local" ? "Local history" : cfg?.mode === "custom" ? currentProfile?.name ?? "My history node" : "Public history"
    : hosted ? "Hosted" : currentProfile?.name ?? "My walletd";

  const switchDesktop = async (mode: "remote" | "local" | "custom", profile?: EndpointProfile) => {
    setBusy(profile?.id ?? mode);
    setError("");
    try {
      const next = await setNodeSource(mode, profile?.address);
      setCfg(next);
      setOpen(false);
      location.reload();
    } catch (e) {
      setError((e as Error).message || String(e));
    } finally {
      setBusy(null);
    }
  };

  const switchWalletd = async (
    raw: string,
    busyKey = "walletd",
    accessToken = "",
    onConnected?: (url: string) => void,
  ) => {
    setBusy(busyKey);
    setError("");
    try {
      // A pairing string carries the address AND both secrets, so scanning or pasting
      // one connects to the right wallet with nothing typed. Typing them by hand means
      // transcribing two long hex strings on a phone; getting the second one wrong does
      // not fail loudly, it opens a different, empty wallet.
      const paired = parsePairingUri(raw);
      const target = paired ? paired.url : raw;
      const secret = paired ? paired.accessToken : accessToken;
      const url = target.trim() ? await findReachableDaemon(target, secret) : "";
      // Adopt the paired wallet BEFORE the reload, or the next poll asks for this
      // device's own wallet on the far end and finds nothing.
      if (url && paired?.walletToken) {
        setToken(paired.walletToken);
        ensureRegistered(paired.walletToken);
      }
      setBase(url);
      setWalletdBearer(url ? secret : "");
      onConnected?.(url);
      setOpen(false);
      location.reload();
    } catch (e) {
      setError((e as Error).name === "AbortError" ? "Connection timed out after 5 seconds." : (e as Error).message);
    } finally {
      setBusy(null);
    }
  };

  const add = async () => {
    if (!address.trim()) return;
    if (desktop) {
      setBusy("add");
      setError("");
      try {
        const next = await setNodeSource("custom", address);
        walletNodeProfiles.save(name, next.node_addr);
        setCfg(next);
        setOpen(false);
        location.reload();
      } catch (e) {
        setError((e as Error).message || String(e));
        setBusy(null);
      }
      return;
    }
    await switchWalletd(address, "add", bearer, (connected) => walletdProfiles.save(name, connected, bearer));
  };

  return (
    <>
      <button className="connection-button" onClick={() => { setOpen(true); void refresh(); }} aria-label={`Connection: ${label}`}>
        <Server aria-hidden="true" size={17} strokeWidth={2.2} />
        <span><small>{desktop ? "Wallet source" : "Wallet service"}</small><b>{label}</b></span>
        <ChevronDown aria-hidden="true" size={15} />
      </button>
      {open && createPortal(
        <div className="modalwrap" onClick={() => setOpen(false)}>
          <div className="card modalcard connection-modal" onClick={(event) => event.stopPropagation()}>
            <div className="connection-modal-head">
              <div><span className="eyebrow">Connection</span><h2>{desktop ? "Choose wallet data source" : "Choose a wallet service"}</h2></div>
              <span className="status-pill good">{label}</span>
            </div>
            <p className="muted small">
              {desktop
                ? "Embedded walletd and your keys stay private inside this app. Choose the ZKAS node it reads for complete wallet history; a mining-only node is refused."
                : `Hosted is easiest. A walletd you run yourself keeps your viewing key and wallet scan on your own machine. ${isNative() ? "This installed app accepts HTTPS or plain HTTP on your LAN." : "In a browser, your walletd must use HTTPS; install the app to use plain HTTP on a LAN."}`}
            </p>

            <div className="connection-list">
              <button className={`connection-option ${(desktop ? cfg?.mode === "remote" : hosted) ? "active" : ""}`} disabled={busy !== null} onClick={() => desktop ? void switchDesktop("remote") : void switchWalletd("", "hosted", "")}>
                <span><b>{desktop ? "Public wallet-history node" : "Hosted wallet service"}</b><small>Works immediately</small></span><span>{busy === (desktop ? "remote" : "hosted") ? "Checking…" : (desktop ? cfg?.mode === "remote" : hosted) ? "Connected" : "Use"}</span>
              </button>
              {desktop && (
                <button className={`connection-option ${cfg?.mode === "local" ? "active" : ""}`} disabled={busy !== null} onClick={() => {
                  if (!cfg?.node_running) {
                    setOpen(false);
                    location.hash = "#/node";
                    return;
                  }
                  void switchDesktop("local");
                }}>
                  <span><b>Local wallet-history node</b><small>Managed here · gRPC {MANAGED_ZKAS_RPC}</small></span><span>{busy === "local" ? "Checking…" : cfg?.mode === "local" ? "Connected" : cfg?.node_running ? "Use" : "Set up"}</span>
                </button>
              )}
              {profiles.map((profile) => {
                const active = desktop ? cfg?.mode === "custom" && currentProfile?.id === profile.id : currentProfile?.id === profile.id;
                return <div className={`connection-option saved ${active ? "active" : ""}`} key={profile.id}>
                  <button disabled={busy !== null} onClick={() => desktop ? void switchDesktop("custom", profile) : void switchWalletd(profile.address, profile.id, profile.bearer ?? "")}>
                    <span><b>{profile.name}</b><small className="mono">{profile.address}</small></span><span>{busy === profile.id ? "Checking…" : active ? "Connected" : "Use"}</span>
                  </button>
                  <button className="connection-remove" aria-label={`Remove ${profile.name}`} disabled={busy !== null || active} onClick={() => {
                    (desktop ? walletNodeProfiles : walletdProfiles).remove(profile.id);
                    setProfiles(desktop ? walletNodeProfiles.load() : walletdProfiles.load());
                  }}><Trash2 size={16} /></button>
                </div>;
              })}
            </div>

            <div className="connection-add">
              <h3>Add {desktop ? "wallet-history node" : "walletd"}</h3>
              {/* The pairing path, first and by itself. Scanning fills in the address and
                  BOTH secrets at once; typing them means transcribing two long hex strings,
                  and getting the wallet one wrong opens a different, empty wallet rather
                  than failing. The manual fields stay below for anyone who needs them. */}
              {!desktop && (
                <div className="connection-pair">
                  <button className="btn small" disabled={busy !== null} onClick={() => setScanning(true)}>
                    Scan pairing code
                  </button>
                  <span className="muted small">
                    From the computer running the wallet service: <b>Host → Network access → Pair a phone</b>.
                  </span>
                </div>
              )}
              <div className={`connection-add-grid ${desktop ? "" : "walletd"}`}>
                <input value={name} onChange={(event) => setName(event.target.value)} placeholder="Name · Home node" />
                <input className="mono" value={address} onChange={(event) => setAddress(event.target.value)} placeholder={desktop ? STANDALONE_ZKAS_RPC_EXAMPLE : isNative() ? `192.168.1.20:${DEFAULT_WALLETD_PORT}` : "https://wallet.example.com"} />
                {!desktop && <input type="password" className="mono" value={bearer} onChange={(event) => setBearer(event.target.value)} placeholder="Access token · if required" autoCapitalize="none" autoCorrect="off" spellCheck={false} />}
                <button className="btn small" disabled={busy !== null || !address.trim()} onClick={() => void add()}>{busy === "add" ? "Checking…" : "Save & connect"}</button>
              </div>
            </div>
            {scanning && (
              <QrScanner
                onClose={() => setScanning(false)}
                onResult={(text) => {
                  setScanning(false);
                  const paired = parsePairingUri(text);
                  if (!paired) {
                    // A QR that is not a pairing code is far more likely to be a wallet
                    // address than a wallet service, so say what was scanned instead of
                    // dropping it into the address box and failing to connect to it.
                    setError("That code is not a wallet-service pairing code. On the computer serving the wallet, open Host → Network access → Pair a phone.");
                    return;
                  }
                  setAddress(paired.url);
                  setBearer(paired.accessToken);
                  void switchWalletd(text, "add", paired.accessToken, (connected) =>
                    walletdProfiles.save(name.trim() || "Paired wallet", connected, paired.accessToken),
                  );
                }}
              />
            )}
            {desktop && !cfg?.node_binary && <p className="muted small">Managed local node is not installed yet. The Mine and Node screens can install the verified release automatically.</p>}
            {error && <div className="msg err">{error}</div>}
            <button className="btn ghost small" onClick={() => setOpen(false)}>Close</button>
          </div>
        </div>,
        document.body,
      )}
    </>
  );
}

function WalletSwitcher({ onClose }: { onClose: () => void }) {
  const active = activeToken();
  const registered = listWallets();
  // The first status poll registers legacy wallets. If the switcher is opened
  // before that sub-second repair completes, still show the active wallet.
  const wallets = registered.length || !active ? registered : [{ token: active, label: "Wallet 1" }];
  return createPortal(
    <div className="modalwrap" onClick={onClose}>
      <div className="card modalcard" onClick={(e) => e.stopPropagation()}>
        <h2 style={{ marginTop: 0 }}>Your wallets</h2>
        {wallets.map((w) => (
          <div
            key={w.token}
            className="contact-row"
            style={{ cursor: w.token === active ? "default" : "pointer" }}
            onClick={() => {
              if (w.token === active) return;
              switchWallet(w.token);
              location.reload();
            }}
          >
            <div className="avatar" style={w.token === active ? undefined : { opacity: 0.45 }}>
              {(w.label.match(/\d+/)?.[0] ?? w.label.slice(0, 1)).toString()}
            </div>
            <div className="contact-main">
              <div className="contact-name">
                {w.label} {w.token === active && <span className="muted small">· active</span>}
              </div>
              {w.address && <div className="contact-addr">{w.address}</div>}
            </div>
          </div>
        ))}
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginTop: 12 }}>
          <button
            className="btn"
            onClick={() => {
              addWallet();
              location.reload();
            }}
          >
            Add another wallet
          </button>
          <button className="btn ghost" onClick={onClose}>
            Close
          </button>
        </div>
        <p className="muted small" style={{ marginTop: 10 }}>
          Every wallet stays on this device with its own key, history and contacts. Rename or remove them under
          Settings.
        </p>
      </div>
    </div>,
    document.body,
  );
}
function spendableFc(status: Status | null): number {
  if (!status) return 0;
  return status.spendable_fc != null ? parseFloat(status.spendable_fc) : parseFloat(status.balance_fc || "0");
}
function maturingFc(status: Status | null): number {
  return status?.maturing_fc != null ? parseFloat(status.maturing_fc) : 0;
}
// The balance to remember when recording a send, so `reconcile` can later tell the spend
// has landed by watching the daemon balance fall to `preFc - spentFc`. `balance_fc` can
// momentarily read 0 while the daemon reloads/evicts the wallet, and a 0 here would make
// that drop test meaningless (it requires preFc > 0) — leaving the send subtracted until
// the 20-min age-out. Fall back to the last-known-good snapshot, which is never spuriously 0.
function reliablePreFc(status: Status | null): number {
  const b = parseFloat(status?.balance_fc || "0");
  return b > 0 ? b : loadSnapshot()?.balanceFc ?? 0;
}
// 0-conf value the chain has already confirmed but the wallet's own tree has not
// ingested yet (it holds back SYNC_TIP_MARGIN blocks from the tip). Showing these is
// what makes a payment appear seconds after it is mined rather than ~3 minutes later.
function pendingInFc(status: Status | null): number {
  return status?.pending_in_fc != null ? parseFloat(status.pending_in_fc) : 0;
}
function pendingOutFc(status: Status | null): number {
  return status?.pending_out_fc != null ? parseFloat(status.pending_out_fc) : 0;
}

/// Hold a transient flag ON for at least `minMs` once it shows.
///
/// The status poll runs every second and the daemon legitimately flips these
/// states on and off as blocks land, so a notice could appear and vanish inside
/// one frame — the balance line visibly flickering between "synced", "syncing"
/// and "updating…" several times in a few seconds. The upstream hysteresis only
/// delays *entry* (don't show a blip); this guarantees *dwell* (once shown, stay
/// long enough to read). Together: a state must persist to appear, and must
/// linger to disappear, so the line changes at most every few seconds.
function useMinDwell(on: boolean, minMs = 4000) {
  const [shown, setShown] = useState(on);
  const shownAt = useRef(0);
  useEffect(() => {
    if (on) {
      if (!shown) {
        shownAt.current = Date.now();
        setShown(true);
      }
      return;
    }
    if (!shown) return;
    const held = Date.now() - shownAt.current;
    if (held >= minMs) {
      setShown(false);
      return;
    }
    const t = setTimeout(() => setShown(false), minMs - held);
    return () => clearTimeout(t);
  }, [on, shown, minMs]);
  return shown;
}

/// In-app confirmation dialog.
///
/// NOT `window.confirm`: inside the desktop shell's macOS WKWebView the native
/// JS dialogs do not behave like a browser's — `confirm()` comes back false
/// without ever showing a panel, so every action guarded by it silently did
/// nothing (reported live: "I clicked turn history off and nothing happens").
/// Rendering our own dialog also keeps these prompts styled like the rest of the
/// wallet instead of an OS alert.
function ConfirmDialog({
  title,
  body,
  confirmLabel,
  danger,
  onConfirm,
  onCancel,
}: {
  title: string;
  body: string;
  confirmLabel: string;
  danger?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  // Rendered through a portal on <body>: a `position: fixed` overlay inside an
  // ancestor that has a transform (the pane's entrance animation) would be
  // positioned against that ancestor instead of the viewport — the classic
  // "modal opened but you cannot see it" bug. A portal is immune to it.
  return createPortal(
    <div className="modalwrap" onClick={onCancel}>
      <div className="card modalcard" onClick={(e) => e.stopPropagation()}>
        <h2 style={{ marginTop: 0 }}>{title}</h2>
        <p className="muted small">{body}</p>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginTop: 4 }}>
          <button className="btn" onClick={onConfirm}>
            {confirmLabel}
          </button>
          <button className="btn ghost" onClick={onCancel}>
            Cancel
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}

/// Compact clock for an operation measured in seconds to minutes: "48s", "3m 20s".
/// Deliberately not `formatDuration`, whose coarse "about 3 minutes" is right for an
/// estimate but wrong for a running timer — a timer that does not visibly move is the
/// thing that makes people think a slow operation has hung.
function formatElapsed(secs: number): string {
  if (!Number.isFinite(secs) || secs < 0) return "0s";
  if (secs < 60) return `${secs}s`;
  const m = Math.floor(secs / 60);
  const s = secs % 60;
  return s ? `${m}m ${s}s` : `${m}m`;
}

/// Asks WHEN this wallet started before replaying the chain for it.
///
/// Recovery used to be a yes/no confirmation that always rescanned from genesis —
/// millions of leaves, minutes of work, most of it over blocks the wallet did not
/// exist for. Nobody knows their block height, but everybody knows roughly when
/// they made the wallet, and this chain runs at one block per second, so a calendar
/// date converts straight into one. Same question the importer asks, same
/// conversion, and the same two days of margin: scanning a little too far back
/// costs seconds, starting too late costs notes.
function RecoverHistoryDialog({
  daaScore,
  onConfirm,
  onCancel,
}: {
  daaScore: number;
  onConfirm: (birthday?: number) => void;
  onCancel: () => void;
}) {
  const [when, setWhen] = useState<"unknown" | "date">("unknown");
  const [createdDate, setCreatedDate] = useState("");
  const [height, setHeight] = useState("");

  const birthday = (): number | undefined => {
    if (height.trim()) return Math.max(0, Math.floor(Number(height.trim()))) || undefined;
    if (when === "date" && createdDate && daaScore) {
      const ageSec = Math.floor((Date.now() - new Date(createdDate + "T00:00:00").getTime()) / 1000);
      if (ageSec > 0) return Math.max(0, Math.floor(daaScore - ageSec - 2 * 86400));
    }
    return undefined;
  };
  const from = birthday();
  const days = from && daaScore > from ? Math.round((daaScore - from) / 86400) : null;

  return createPortal(
    <div className="modalwrap" onClick={onCancel}>
      <div className="card modalcard" onClick={(event) => event.stopPropagation()}>
        <h2 style={{ marginTop: 0 }}>Recover full history</h2>
        <p className="muted small">
          Payment details are rebuilt from the chain and saved with this wallet, so anyone with access to
          its wallet data can read them. Payments stay private on-chain either way.
        </p>
        <div className="choice-grid">
          <button className={`choice-button ${when === "date" ? "selected" : ""}`} onClick={() => setWhen("date")}>
            <strong>I know roughly when</strong>
            <span>Scan from that date. Much faster.</span>
          </button>
          <button className={`choice-button ${when === "unknown" ? "selected" : ""}`} onClick={() => setWhen("unknown")}>
            <strong>Not sure</strong>
            <span>Scan everything from the beginning.</span>
          </button>
        </div>
        {when === "date" && (
          <>
            <label>Wallet created around</label>
            <input type="date" className="control-input" value={createdDate} max={new Date().toISOString().slice(0, 10)} onChange={(event) => setCreatedDate(event.target.value)} />
            <details style={{ marginTop: 8 }}>
              <summary className="muted small">Know the exact block height?</summary>
              <input className="control-input mono" value={height} onChange={(event) => setHeight(event.target.value.replace(/[^0-9]/g, ""))} placeholder="DAA height" inputMode="numeric" />
            </details>
          </>
        )}
        <p className="subtle">
          {from
            ? `Scanning from DAA ${from.toLocaleString()}${days ? ` — about ${days} day${days === 1 ? "" : "s"} of chain.` : "."}`
            : "Scanning the whole chain. This finds everything, and takes the longest."}
        </p>
        <div className="row">
          <button className="btn ghost" onClick={onCancel}>Cancel</button>
          <button className="btn" disabled={when === "date" && !from} onClick={() => onConfirm(from)}>
            Agree &amp; recover
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}

/** Device-signed one-pass note consolidation. It uses the same noncustodial
 * prepare/verify/submit path as Send; the seed never goes to walletd. */
function ConsolidateDialog({
  status,
  onClose,
  onDone,
}: {
  status: Status;
  onClose: () => void;
  onDone: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [stage, setStage] = useState<SendStage | null>(null);
  const [error, setError] = useState("");
  const [needSeed, setNeedSeed] = useState(false);
  const [seedInput, setSeedInput] = useState("");
  const [result, setResult] = useState<{ inputs: number; txid: string; fee: number; rounds: number; more: boolean } | null>(null);
  // Live count of merged notes. A fragmented wallet needs several transactions,
  // which takes minutes — without this the dialog looks hung.
  const [merged, setMerged] = useState<{ round: number; notes: number } | null>(null);
  // Consolidation runs one Halo 2 proof per pass and a fragmented wallet needs many,
  // so this legitimately runs for minutes. A spinner alone is indistinguishable from a
  // hang. Time is MEASURED here, never guessed: elapsed always, and a remaining figure
  // only once a completed pass has given us a real per-pass rate.
  const [startedAt, setStartedAt] = useState(0);
  const [tick, setTick] = useState(0);
  const [passEndedAt, setPassEndedAt] = useState<number[]>([]);
  useEffect(() => {
    if (!busy) return;
    const timer = window.setInterval(() => setTick(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [busy]);

  const expectedPasses = Math.min(
    MAX_CONSOLIDATION_ROUNDS,
    Math.max(1, Math.ceil((status.note_count ?? 0) / MAX_NOTES_PER_TX)),
  );
  // A whole-run estimate: one pass' measured cost times the passes still to go.
  // Counting down the entire run rather than the current pass is the honest scope —
  // what the user is waiting for is a merged wallet, not a particular proof.
  const passEstimateMs = useMemo(() => {
    const per = estimateDuration("consolidate-pass", activeToken() ?? "default", MAX_NOTES_PER_TX);
    if (per === null) return null;
    const done = passEndedAt.length;
    return per * Math.max(1, expectedPasses - done);
  }, [expectedPasses, passEndedAt.length]);
  const elapsed = busy && startedAt ? Math.max(0, Math.round((Math.max(tick, Date.now()) - startedAt) / 1000)) : 0;
  // Average a COMPLETED pass, so the estimate is this machine's real proving rate on
  // this wallet rather than a constant that would be wrong on half the hardware.
  const remainingSecs =
    passEndedAt.length > 0 && passEndedAt.length < expectedPasses
      ? Math.round(((passEndedAt[passEndedAt.length - 1] - startedAt) / passEndedAt.length / 1000) * (expectedPasses - passEndedAt.length))
      : null;

  const run = async () => {
    const runStartedAt = Date.now();
    setBusy(true);
    setError("");
    setStartedAt(Date.now());
    setPassEndedAt([]);
    try {
      let seed: string;
      try {
        seed = await resolveDeviceSeed(status.address ?? undefined);
      } catch (cause) {
        if ((cause as Error).message !== SEED_REQUIRED) throw cause;
        if (!/^[0-9a-fA-F]{64}$/.test(seedInput.trim())) {
          setNeedSeed(true);
          throw new Error("Enter this wallet's 64-character recovery seed to sign on this device.");
        }
        seed = seedInput.trim();
        if (status.address && await addressFromSeed(seed, networkOf(status)) !== status.address) {
          throw new Error("That seed belongs to a different wallet.");
        }
        setDeviceSeed(seed);
        setNeedSeed(false);
        setSeedInput("");
      }
      if (!status.address) throw new Error("This wallet has no address yet.");
      const spendable = BigInt(
        status.spendable_sompi ?? Math.max(0, Math.round(spendableFc(status) * 100_000_000)).toString(),
      );
      const consolidated = await consolidateNonCustodial(
        seed,
        networkOf(status),
        status.address,
        spendable,
        setStage,
        undefined,
        (round, notes) => {
          setMerged({ round, notes });
          setPassEndedAt((done) => [...done, Date.now()]);
        },
      );
      // Each pass is one proof of a known shape (~38 notes), so a single completed
      // run predicts the next one well. Divide by rounds: what we want to learn is
      // the cost of a PASS, not of however many happened to run this time.
      if (consolidated.rounds > 0 && consolidated.inputs > 0) {
        recordDuration(
          "consolidate-pass",
          activeToken() ?? "default",
          Math.max(1, Math.round(consolidated.inputs / consolidated.rounds)),
          Math.round((Date.now() - runStartedAt) / consolidated.rounds),
        );
      }
      setResult({
        inputs: consolidated.inputs,
        txid: consolidated.txid,
        fee: consolidated.fee_sompi / 100_000_000,
        rounds: consolidated.rounds,
        more: consolidated.more,
      });
      successFeedback();
    } catch (cause) {
      setError((cause as Error).message || String(cause));
    } finally {
      setBusy(false);
      setStage(null);
      setMerged(null);
    }
  };

  return createPortal(
    <div className="modalwrap" onClick={() => !busy && onClose()}>
      <div className="card modalcard consolidate-dialog" onClick={(event) => event.stopPropagation()}>
        <h2 style={{ marginTop: 0 }}>{result ? "Notes consolidated" : "Consolidate notes"}</h2>
        {result ? (
          <>
            <div className="msg ok">
              Combined {result.inputs} spendable notes in {result.rounds === 1 ? "one device-signed transaction" : `${result.rounds} device-signed transactions`}.
            </div>
            <p className="muted small">
              The merged value becomes spendable after normal maturity (about 10 minutes). Total fee:{" "}
              {trimFc(result.fee.toFixed(8))} ZKAS.
            </p>
            {/* Saying "done" while the wallet is still too fragmented to pay is how
                a user ends up repeating this by hand and never being told why. */}
            {result.more && (
              <div className="msg warn small">
                This wallet held more small notes than one pass can merge. Run Consolidate again once the merged note
                matures to reduce it further.
              </div>
            )}
            <div className="addr">{result.txid}</div>
            <button className="btn" onClick={onDone}>Done</button>
          </>
        ) : (
          <>
            <p className="muted small">
              Merge your small notes back into your own wallet, so a payment can reach your whole balance in one
              transaction. Each pass costs one network fee and briefly makes the merged value unavailable while it
              matures. Nothing leaves your wallet.
            </p>
            <div className="confirm-row"><span className="muted">Current notes</span><b>{status.note_count}</b></div>
            {typeof status.note_count === "number" && status.note_count > MAX_NOTES_PER_TX && (
              <div className="confirm-row">
                <span className="muted">Passes needed</span>
                <b>about {Math.min(MAX_CONSOLIDATION_ROUNDS, Math.ceil(status.note_count / MAX_NOTES_PER_TX))}</b>
              </div>
            )}
            {needSeed && (
              <>
                <label>Recovery seed · stays on this device</label>
                <textarea value={seedInput} onChange={(event) => setSeedInput(event.target.value)} placeholder="64 hex characters" />
              </>
            )}
            {busy && <SendScene stage={stage ?? undefined} estimateMs={passEstimateMs} />}
            {/* Each pass is its own proof, so this runs for minutes on a very
                fragmented wallet. Report the work already banked — those
                transactions are broadcast and survive closing this dialog. */}
            {busy && (
              <p className="muted small" style={{ marginTop: 8 }}>
                {merged
                  ? `Merged ${merged.notes} notes in ${merged.round} of about ${expectedPasses} ${expectedPasses === 1 ? "pass" : "passes"}`
                  : `Pass 1 of about ${expectedPasses}`}
                {" · "}
                {formatElapsed(elapsed)} elapsed
                {/* No estimate until a pass has finished: a number invented before we
                    have measured anything is exactly the kind of promise that makes a
                    slow operation feel broken when it overruns. */}
                {remainingSecs != null && ` · about ${formatElapsed(remainingSecs)} left`}
              </p>
            )}
            {error && <div className="msg err">{error}</div>}
            <div className="row">
              <button className="btn ghost" disabled={busy} onClick={onClose}>Cancel</button>
              <button className="btn" disabled={busy} onClick={() => void run()}>
                {busy ? stage === "signing" ? "Signing…" : stage === "broadcasting" ? "Broadcasting…" : "Building proof…" : "Consolidate"}
              </button>
            </div>
          </>
        )}
      </div>
    </div>,
    document.body,
  );
}

/// Show a flag only once it has held for `delayMs` — the mirror of
/// [`useMinDwell`]. Used for whole-view switches, where reacting to a single
/// poll would swap the entire card out and back.
/// Latch a flag ON until the caller resets it.
///
/// Used for "this send is confirmed": the daemon's view of a pending spend can
/// waver between polls (the nullifier is seen, then a status races a sync pass),
/// but a confirmation is not something that un-happens. Without the latch the
/// message under the outflow line alternated between "confirmed on-chain,
/// updating your balance shortly" and "broadcast (0-conf)" once a second, which
/// is what made "updating…" appear to strobe even after the line itself was
/// given a dwell.
function useLatch(on: boolean, reset: boolean) {
  const [latched, setLatched] = useState(false);
  useEffect(() => {
    if (reset) setLatched(false);
    else if (on) setLatched(true);
  }, [on, reset]);
  return latched && !reset;
}

/// [`useMinDwell`] for a money figure: while the notice is held open past the
/// value going to zero, keep showing the last real amount — otherwise the dwell
/// would render "0 ZKAS incoming" for its final seconds.
function useHeldAmount(amount: number, minMs = 4000) {
  const on = amount > 0.00000001;
  const shown = useMinDwell(on, minMs);
  const last = useRef(amount);
  useEffect(() => {
    if (on) last.current = amount;
  }, [on, amount]);
  return { shown, amount: on ? amount : last.current };
}

/// Seconds left in a chain scan, from the rate actually observed on this device.
/// The old copy promised "a few minutes"; a note-heavy wallet rescanning from
/// genesis takes over an hour, and being told "a few minutes" for an hour is how
/// a slow-but-healthy rebuild reads as a hang. Measure, don't guess. Returns null
/// until there is enough movement to quote honestly.
function useScanEta(scanned: number, total: number, active: boolean): number | null {
  const samples = useRef<{ t: number; n: number }[]>([]);
  const [eta, setEta] = useState<number | null>(null);
  useEffect(() => {
    if (!active || total <= 0) {
      samples.current = [];
      setEta(null);
      return;
    }
    const now = Date.now();
    const s = samples.current;
    // A fresh rescan walks the counter backwards — the old rate says nothing
    // about the new scan, so start over rather than blend them.
    if (s.length && scanned < s[s.length - 1].n) s.length = 0;
    if (!s.length || scanned !== s[s.length - 1].n) s.push({ t: now, n: scanned });
    // Rolling ~2-minute window, so the estimate tracks the rate right now rather
    // than an average dragged down by a slow start.
    while (s.length > 3 && now - s[0].t > 120_000) s.shift();

    // MEDIAN of the per-interval rates, not the endpoint average.
    //
    // The endpoint average is wrong here, and wrong in the direction that makes the
    // wallet lie. A scan does not advance evenly: resuming a checkpoint, skipping to a
    // birthday, or the first few cached pages all move the counter a long way in one
    // poll. Averaged end to end, that single burst sets the rate for the whole window —
    // reported live as "44.8% · about 1 minute left" when ~580,000 blocks remained and
    // the real answer was closer to nine minutes.
    //
    // A median is unmoved by one outlier interval, so a burst is ignored and the figure
    // reflects the rate the scan is ACTUALLY sustaining. Needs a few intervals to mean
    // anything, hence the sample floor — and saying nothing is always allowed.
    if (s.length < 4) return;
    const spanSecs = (now - s[0].t) / 1000;
    if (spanSecs < 20) return;
    const rates: number[] = [];
    for (let i = 1; i < s.length; i++) {
      const dt = (s[i].t - s[i - 1].t) / 1000;
      const dn = s[i].n - s[i - 1].n;
      if (dt > 0.5 && dn > 0) rates.push(dn / dt);
    }
    if (rates.length < 3) return;
    rates.sort((a, b) => a - b);
    const rate = rates[Math.floor(rates.length / 2)];
    if (!(rate > 0)) return;
    setEta(Math.round(Math.max(0, total - scanned) / rate));
  }, [scanned, total, active]);
  return eta;
}

/// Coarse on purpose — a scan rate wobbles, and a precise-looking figure that
/// keeps changing is less trustworthy than a rounded one that holds.
function fmtEta(secs: number): string {
  if (secs < 45) return "under a minute left";
  const m = Math.round(secs / 60);
  if (m < 60) return `~${m} min left`;
  const h = Math.floor(m / 60);
  const rem = m % 60;
  return rem ? `~${h}h ${rem}m left` : `~${h}h left`;
}

/// Seconds elapsed since `on` became true; null while it is false. For states the
/// daemon reports no progress for, where the only honest figure is how long it has been.
function useElapsedWhile(on: boolean): number | null {
  const [secs, setSecs] = useState<number | null>(null);
  const since = useRef<number | null>(null);
  useEffect(() => {
    if (!on) {
      since.current = null;
      setSecs(null);
      return;
    }
    if (since.current == null) since.current = Date.now();
    const tick = () => setSecs(Math.floor((Date.now() - (since.current ?? Date.now())) / 1000));
    tick();
    const t = setInterval(tick, 1000);
    return () => clearInterval(t);
  }, [on]);
  return secs;
}

/// A daemon message that describes work in progress rather than a fault. Such a
/// message must never be rendered as an error — see the call site.
function isTransientNote(msg: string): boolean {
  const m = msg.trim();
  return /[….]{1,3}$/.test(m) && m === m.toLowerCase() && m.length < 40;
}

function BalanceHero({ status, txs }: { status: Status; txs: LocalTx[] }) {
  // NB: every hook here runs BEFORE the `restoring` early return below. That
  // return comes and goes with the daemon's scan state, so a hook placed after
  // it would change hook order between renders — React's "rendered fewer hooks
  // than expected" crash, on exactly the path a user hits after a restart.
  const syncing = useMinDwell(!status.synced, 5000);
  const warming = useMinDwell(!!status.warming, 6000);
  // How long this wallet has been getting ready. The daemon publishes no progress for
  // it, so the honest thing to show is elapsed time — see `status.ts`.
  const warmingSeconds = useElapsedWhile(warming);
  // The displayed balance folds in what the CHAIN has already confirmed but the
  // wallet's tree has not ingested yet (the daemon's 0-conf preview of the
  // unsettled window), so a received payment lands here seconds after it is mined.
  const pendingIn = pendingInFc(status);
  const pendingOut = pendingOutFc(status);
  // Outflow is known two ways: this device's own record of a just-broadcast send,
  // and the daemon seeing our nullifier on-chain. Take the larger rather than the
  // sum — they describe the same spend, and adding them would debit it twice.
  const localOut = pendingTotal(txs);
  const outflow = Math.max(pendingOut, localOut);
  // Both money notices dwell, so a value that blinks to zero between polls does
  // not blink the whole line out of the layout under the user's eyes.
  // 10s: long enough that a notice reads as a state, not a blink.
  const inNotice = useHeldAmount(pendingIn, 10_000);
  const outNotice = useHeldAmount(outflow, 10_000);
  // Whether the outgoing send has been seen on-chain. Latched for as long as the
  // notice is up, so the wording cannot oscillate under the user.
  const outConfirmed = useLatch(
    pendingOut > 0 || txs.some((t) => t.pending && (t.confs ?? 0) >= 1),
    !outNotice.shown,
  );
  const pct =
    status.chain_len > 0 ? Math.min(100, Math.round((status.scanned_blocks / status.chain_len) * 100)) : 0;
  // The daemon has not rebuilt this wallet's state yet — it reports zeros because it
  // does not KNOW the balance, not because the balance is zero. Never render those
  // zeros as a balance; fall back to the last figure it gave us.
  // IMMEDIATE, deliberately. I briefly delayed this by 2s to stop the card
  // flapping — which opened a two-second window where the daemon's "I don't know
  // yet" zeros rendered as the user's balance. Telling somebody their coins are
  // gone, even for two seconds, is far worse than a card that changes twice; the
  // whole point of the snapshot below is that this state NEVER shows a zero.
  const restoring = status.scanned_blocks === 0 && !status.synced;
  const snap = loadSnapshot();
  // A scan in progress reports the value found SO FAR, climbing from zero to the
  // real total. Rendering that as the balance is how a healthy rescan reads as a
  // theft: a pool wallet mid-rebuild showed "29,703 ZKAS" under a small "syncing
  // 5%" while the true figure was 423,997. So while the running count is still
  // below the last confirmed figure, the confirmed figure stays the headline and
  // the partial is labelled as progress.
  const partialFc = parseFloat(status.balance_fc || "0");
  // A wallet that has never finished a scan has no snapshot — `saveSnapshot` runs
  // only for a SYNCED wallet, and rightly so. But that left the first scan, which is
  // the longest and most anxious one a user ever sits through, as the ONE case with
  // no protection: with no snapshot to compare against, this fell through to the
  // settled card below and rendered the climbing partial as the headline balance
  // under a small "syncing 44%". That is the exact failure the comment above
  // describes — a healthy scan reading as a theft — just reached by the other door.
  // Reported live 2026-08-07: "34.75 ZKAS · 2 shielded notes · syncing 44%", where
  // 34.75 was a fraction of the real figure.
  //
  // So: while a scan is genuinely incomplete and we have nothing confirmed to show,
  // present it as progress, never as a balance.
  const firstScan = !snap;
  const rebuilding = !status.synced && (restoring || firstScan || (!!snap && partialFc < snap.balanceFc * 0.995));
  const eta = useScanEta(status.scanned_blocks, status.chain_len, !status.synced);
  // One model decides what state this wallet is in and how to name it — see
  // `status.ts`. The booleans above still drive WHICH card renders (they encode
  // hard-won detail about partial counts); `view` supplies every word the user
  // reads, so the wording cannot drift between branches again.
  const view = walletStatus({
    online: true, // this card only renders once a poll has produced a status
    synced: status.synced,
    spendReady: status.spend_ready,
    scannedBlocks: status.scanned_blocks,
    chainLen: status.chain_len,
    warming: !!status.warming,
    haveConfirmedBalance: !!snap,
    etaSeconds: eta,
    warmingSeconds,
  });
  const pendingCount = txs.filter((t) => t.pending).length;
  const shownBal = Math.max(0, parseFloat(status.balance_fc || "0") + pendingIn - outflow);
  // Spendable now vs still-maturing (shielded anchor depth ~10 min). Incoming 0-conf
  // value is NOT spendable yet, so it only counts toward maturing.
  const maturing = maturingFc(status) + pendingIn;
  const spendable = spendableFc(status) - outflow;
  // MUST be called before the `restoring` early return: a hook below it renders
  // only on some renders, and the moment "restoring" flips off React throws
  // #310 (more hooks than the previous render) and takes the whole UI down.
  const animBal = useCountUp(shownBal);
  if (rebuilding) {
    return (
      <div className="card balance">
        <div className="balance-glow" aria-hidden="true" />
        <div className="balance-label">
          <span className="shield-badge" aria-hidden="true" />
          Shielded balance
        </div>
        <div className="amt">
          {snap ? trimFc(snap.balanceFc.toFixed(8)) : "—"}
          <span className="unit"> ZKAS</span>
        </div>
        <div className="sub">
          {snap ? "last confirmed balance · " : ""}
          <span className="spin" style={{ width: 11, height: 11 }} />{" "}
          {/* "rebuilding" is the wrong word for a wallet that has never scanned —
              nothing is being re-done, and it implies something was lost. */}
          {view.label}
          {view.pctFine ? ` · ${view.pctFine}` : ""}
        </div>
        <div
          className="syncbar"
          role="progressbar"
          aria-valuenow={pct}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-label={firstScan ? "Scanning the chain for this wallet's notes" : "Rebuilding this wallet's view of the chain"}
        >
          <div className="syncbar-fill" style={{ width: `${Math.max(2, pct)}%` }} />
        </div>
        <div className="sub" style={{ marginTop: 8, fontSize: 12 }}>
          Found {trimFc(partialFc.toFixed(8))} ZKAS so far
          {view.eta ? ` · ${view.eta}` : ""}
          {/* A block count that moves on EVERY poll. Even at one decimal the percent
              can hold still for seconds on a million-block chain, and a figure that
              does not move is read as a hang no matter what the words say. */}
          {view.progress && (
            <>
              <br />
              <span style={{ fontVariantNumeric: "tabular-nums", opacity: 0.8 }}>
                block {view.progress.scanned.toLocaleString()} of {view.progress.total.toLocaleString()}
              </span>
            </>
          )}
        </div>
        <div className="sub" style={{ marginTop: 6, fontSize: 12 }}>
          {view.detail} You can close this and come back — it keeps going.
        </div>
        {status.missing_history && (
          <div className="msg warn">
            This node has pruned old history, so the rebuilt balance may come out a <b>lower bound</b>. Your coins are
            on-chain — rescan from a node that serves full history to see everything.
          </div>
        )}
      </div>
    );
  }
  return (
    <div className="card balance">
      <div className="balance-glow" aria-hidden="true" />
      <div className="balance-label">
        <span className="shield-badge" aria-hidden="true" />
        Shielded balance
      </div>
      <div className="amt">
        {trimFc(animBal.toFixed(8))}
        <span className="unit"> ZKAS</span>
      </div>
      {/* Fixed height, deliberately. This line's content changes as the wallet
          works — "Ready" one second, "Setting up 44% · about 5 minutes left" the
          next — and with height driven by content the whole card grew and shrank
          under the user's eyes, shoving everything below it up and down. Reserving
          the space costs a few pixels and stops the page moving. */}
      <div className="sub balance-status">
        {/* Note count is OUR unit, not the user's — they have an amount, not
            "notes". It stays only where it explains something (fees, why a big
            payment needs splitting), not in the headline. */}
        {view.tone === "busy" ? (
          <>
            <span className="spin" style={{ width: 11, height: 11 }} /> {view.label}
            {view.pctFine ? ` ${view.pctFine}` : ""}
            {view.eta ? ` · ${view.eta}` : ""}
          </>
        ) : (
          // Settled: a calm dot, not a bare word.
          //
          // "Ready" alone sat directly under the balance in the same grey as every
          // other line, so the most reassuring state the wallet has looked identical
          // to a warning. A green dot is read before any word is, and it costs one
          // glance instead of one read — which is the whole job of this line when
          // nothing is wrong.
          <span className="status-ok">
            <span className="status-dot" aria-hidden="true" />
            {view.label}
          </span>
        )}
      </div>
      {/* The wording lives in `status.ts` with every other state, so this can no
          longer drift from what the headline says. It used to promise "~1–2 min";
          measured live, the first send after a cold open spent 122s locating coins
          on top of a ~5 min background pass — a wallet that promises two minutes and
          takes six has lied, which is worse than quoting nothing. */}
      <div className="sub warmnote notice-slot">{view.phase === "almost-ready" ? `⚡ ${view.detail}` : ""}</div>
      <div className="sub notice-slot" style={{ color: "var(--ember)" }}>
        {inNotice.shown
          ? `+${trimFc(inNotice.amount.toFixed(8))} ZKAS arriving — confirmed, settling into your wallet`
          : ""}
      </div>
      <div className="sub notice-slot" style={{ color: "var(--ember)" }}>
        {outNotice.shown
          ? `${trimFc(outNotice.amount.toFixed(8))} ZKAS ` +
            // "updating your balance shortly" said nothing a user needed and was the
            // longest string in the card, so it wrapped to a second line and was the
            // thing that made the box change size. "Confirmed" is the whole message.
            (outConfirmed ? "sent — confirmed" : `sent — on its way${pendingCount > 1 ? ` · ${pendingCount} payments` : ""}`)
          : ""}
      </div>
      <div className="sub notice-slot">
        {maturing > 0.00000001 ? (
          view.canSpend ? (
            <span>
              {trimFc(Math.max(0, spendable).toFixed(8))} ready to spend ·{" "}
              <span style={{ color: "var(--ember)" }}>{trimFc(maturing.toFixed(8))} arriving</span> — coins become
              spendable about 10 minutes after they land.
            </span>
          ) : (
            // "Ready to spend" here means a note has MATURED. It is not a claim that
            // the wallet can pay — while it is still scanning it cannot, and saying
            // both at once is what made the app look like it was contradicting
            // itself: this line offered a figure, and Send then refused it.
            <span>
              <span style={{ color: "var(--ember)" }}>{trimFc(maturing.toFixed(8))} arriving</span> — you can pay once
              the wallet finishes checking the chain.
            </span>
          )
        ) : (
          ""
        )}
      </div>
      {syncing && (
        <>
          <div
            className="syncbar"
            role="progressbar"
            aria-valuenow={pct}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-label="Wallet sync progress"
          >
            <div className="syncbar-fill" style={{ width: `${Math.max(2, pct)}%` }} />
          </div>
          <div className="sub" style={{ marginTop: 8, fontSize: 12 }}>
            Balances appear as the wallet scans the chain — your funds are safe.
            {/* The estimate was computed for every syncing wallet but only ever
                rendered in the rebuild card, so the plain sync — where a user sits
                watching a percentage that barely moves — was the one case with no
                idea how long. `useScanEta` says nothing until it has 20s of real
                rate, so an absent value here means "not known yet", not "instant". */}
            {eta ? ` ${fmtEta(eta)}.` : ""}
          </div>
        </>
      )}
      {status.missing_history && (
        <div className="msg warn">
          This balance is a <b>lower bound</b>: the wallet's view was rebuilt through a node that has pruned old
          history, so notes created long ago may be missing from it. Your coins are safe on-chain — rescan only from
          a node that serves full history (rebuilding through this one would come out just as blind).
        </div>
      )}
      {/* Only real faults get the red box.
          The daemon used to put transient states here — "updating…", "loading…" —
          which are set whenever its sync loop happens to hold the wallet lock. That
          flickered on and off with the lock, so a perfectly healthy wallet strobed a
          red error under its balance. Fixed in the daemon, but a client must not be
          one version away from doing that to somebody again: a lower-case message
          ending in an ellipsis is a progress note, not a failure, and the status line
          above already says what the wallet is doing. */}
      {status.error && !isTransientNote(status.error) && <div className="msg err">{status.error}</div>}
    </div>
  );
}

// One-time seed backup, shown right after creation. Rendered at the App level so
// the periodic status poll can't unmount it — it stays until the user dismisses it.
function SeedBackup({ seed, address, onDone }: { seed: string; address: string; onDone: () => void }) {
  const [copied, setCopied] = useState(false);
  const [showSeed, setShowSeed] = useState(false);
  const copy = async () => {
    try {
      await copyText(seed);
    } catch {
      /* clipboard may be blocked; the seed is shown to copy by hand */
    }
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <div className="card">
      <h2>Save your wallet</h2>
      <div className="msg warn">
        This wallet exists only on this device. If you lose it with no backup, the coins are gone — nobody, including
        us, can restore them.
      </div>

      {/* An encrypted backup file is the primary path, deliberately.
          The alternative is 64 hex characters, which nobody transcribes by hand
          and which is trivially mistyped when they try — an earlier version of
          this screen displayed it in numbered groups and then quizzed the user
          on two of them, which is a lot of ceremony to make a bad artifact
          slightly less bad. A file with its own passphrase is the thing people
          will actually keep, on a USB stick or in a password manager. */}
      <DeviceSeedBackup />

      <label style={{ marginTop: 16 }}>Your shielded address</label>
      <div className="addr">{address}</div>

      {showSeed ? (
        <>
          <label style={{ marginTop: 16 }}>Recovery seed</label>
          <div className="addr">{seed}</div>
          <button className="btn ghost small" style={{ marginTop: 10 }} onClick={copy}>
            {copied ? "Copied ✓" : "Copy seed"}
          </button>
          <p className="muted small">
            Anyone who has this controls the funds. Keep it in a password manager rather than a screenshot or a note.
          </p>
        </>
      ) : (
        <button className="btn ghost small" style={{ marginTop: 16 }} onClick={() => setShowSeed(true)}>
          Show recovery seed instead
        </button>
      )}

      <button className="btn" style={{ marginTop: 18 }} onClick={onDone}>
        Open wallet
      </button>
      <p className="muted small" style={{ marginTop: 10 }}>
        You can make a backup or view the seed at any time under Settings.
      </p>
    </div>
  );
}
/// Prove the backup was actually written down.
///
/// This used to be a checkbox. A checkbox costs one click and verifies nothing,
/// which on a chain with no recovery path means the wallet's most destructive
/// failure — a seed that was never really saved — stays invisible until the day
/// it matters. Asking for two random groups catches a bad transcription while
/// the seed is still on screen, and cannot be satisfied by clicking through.
/// The signer's network name for the daemon's chain (only mainnet/testnet exist
/// for address encoding; anything else is a devnet using the testnet HRP).
function networkOf(status: Status | null): Network {
  // Default MAINNET on anything unexpected: the on-device signer only signs
  // mainnet, so a missing/odd network string must fail toward the chain
  // everything actually runs on, not toward a testnet that cannot sign.
  return status?.network === "testnet" ? "testnet" : "mainnet";
}

/// The daemon lost this wallet's registration and this device holds no key to
/// auto-repair with. The worst possible answer is a bare "create a new wallet"
/// — the user panic-creates over their existing wallet. Show the cached address,
/// take the seed, VERIFY it matches the address, re-register, rebuild.
function RecoverWallet({ onRecovered, onStartOver }: { onRecovered: () => void; onStartOver: () => void }) {
  const cached = loadStatusCache();
  const [seed, setSeed] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const recover = async () => {
    setErr("");
    const s = seed.trim();
    if (!/^[0-9a-fA-F]{64}$/.test(s)) return setErr("That doesn't look like a recovery seed (64 hex characters).");
    setBusy(true);
    try {
      // Never re-register the WRONG wallet over this token: the seed must derive
      // the address this device was showing.
      if (cached?.address) {
        const net: Network = cached.address.startsWith("zkastest:") ? "testnet" : "mainnet";
        const addr = await addressFromSeed(s, net);
        if (addr !== cached.address) {
          setErr(`That seed belongs to a different wallet (${shortAddr(addr)}). Check it and try again.`);
          return;
        }
      }
      await api.watch(await fvkHex(s), walletBirthday());
      setDeviceSeed(s);
      onRecovered();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="card">
      <h2>Reconnect your wallet</h2>
      <div className="msg ok">
        <b>Nothing is lost.</b> Your coins are on-chain and only your seed can ever move them. The wallet service
        restarted and forgot this wallet's registration — reconnecting takes a moment, then your balance rebuilds
        itself automatically.
      </div>
      {cached?.address && (
        <>
          <label>This wallet's address</label>
          <div className="addr" style={{ fontSize: 12 }}>
            {cached.address}
          </div>
        </>
      )}
      <label>Recovery seed (64 hex characters)</label>
      <textarea
        value={seed}
        onChange={(e) => setSeed(e.target.value)}
        placeholder="The seed saved when this wallet was created"
        autoCapitalize="off"
        autoCorrect="off"
        spellCheck={false}
      />
      {err && <div className="msg err">{err}</div>}
      <button className="btn" disabled={busy || !seed.trim()} onClick={recover}>
        {busy ? "Reconnecting…" : "Reconnect wallet"}
      </button>
      <p className="muted small">
        The seed is checked on this device against the address above and never sent anywhere. After reconnecting, the
        wallet rebuilds its view from the chain — the balance climbs back over the next minutes.
      </p>
      <button className="linkbtn" onClick={onStartOver}>
        Not your wallet? Create or import a different one
      </button>
    </div>
  );
}

function Onboard({
  status,
  onCreated,
  onImported,
}: {
  status: Status | null;
  onCreated: (seed: string, address: string) => void;
  onImported: () => void;
}) {
  const [mode, setMode] = useState<"choose" | "import" | "backup" | "restorefile">("choose");
  const [importHex, setImportHex] = useState("");
  const [restoreJson, setRestoreJson] = useState("");
  const [restoreName, setRestoreName] = useState("");
  const [restorePass, setRestorePass] = useState("");
  const [birthday, setBirthday] = useState("");
  const [createdDate, setCreatedDate] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  // The seed is generated HERE, in WebAssembly on this device, and never sent
  // anywhere. The daemon only gets the 96-byte full viewing key, which lets it
  // sync the wallet and build spend proofs but carries no spend authority — so it
  // cannot move the funds even if it is compromised. Spends are authorized by a
  // signature this device makes (see Send → sendNonCustodial).
  const create = async () => {
    setBusy(true);
    setError("");
    try {
      // Never create over a key this device still holds: creating registers a NEW
      // wallet under the SAME token and would replace the old seed in storage.
      // The switcher's "Add another wallet" mints a fresh token instead.
      if (getDeviceSeed()) {
        setError(
          "This device already holds a wallet key. Restore that wallet instead — or use the wallet switcher's 'Add another wallet' so nothing is overwritten.",
        );
        return;
      }
      const w = await generateWallet(networkOf(status));
      // Born now: the daemon fast-syncs from the current tip instead of scanning
      // the whole chain for history this wallet cannot have.
      const birthday = status?.daa_score ?? 0;
      await api.watch(await fvkHex(w.seedHex), birthday);
      rememberBirthday(birthday);
      setDeviceSeed(w.seedHex);
      onCreated(w.seedHex, w.address);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  // Import is the same deal: the seed stays here, only the viewing key is
  // registered. Birthday 0 (the default) makes the daemon scan the full chain so
  // an old wallet's historical notes are all recovered.
  //
  // The chain runs at 1 block per second, so a DAA height is (almost exactly) a
  // number of seconds — which means a plain calendar date converts straight into a
  // wallet birthday. Nobody knows their block height; everybody knows roughly when
  // they made the wallet. Two days of margin absorb timezones and fuzzy memory —
  // scanning a couple of days too much costs seconds, skipping a day too much
  // costs notes.
  const birthdayFromInputs = (): number => {
    if (birthday.trim()) return Number(birthday.trim()); // exact height wins
    if (createdDate && status?.daa_score) {
      const ageSec = Math.floor((Date.now() - new Date(createdDate + "T00:00:00").getTime()) / 1000);
      if (ageSec > 0) return Math.max(0, Math.floor(status.daa_score - ageSec - 2 * 86400));
    }
    return 0;
  };
  const doImport = async () => {
    setBusy(true);
    setError("");
    try {
      const seed = importHex.trim();
      const b = birthdayFromInputs();
      await api.watch(await fvkHex(seed), b);
      rememberBirthday(b);
      setDeviceSeed(seed);
      onImported();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  // Web restore: the encrypted backup .json is decrypted here with the passphrase
  // (readBackup), yielding the real 64-hex seed + the wallet's birthday. This is the
  // path a web user needs after clearing browser data — the desktop app has its own
  // folder-based restore, but the web app had none, so users wrongly pasted the
  // file's base64 ciphertext into the seed box.
  const doRestoreFile = async () => {
    setBusy(true);
    setError("");
    try {
      if (!restoreJson.trim()) throw new Error("Choose your backup .json file, or paste the backup text.");
      const { seedHex, birthday } = await readBackup(restoreJson, restorePass);
      await api.watch(await fvkHex(seedHex), birthday);
      rememberBirthday(birthday);
      setDeviceSeed(seedHex);
      onImported();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  if (mode === "restorefile") {
    return (
      <div className="card">
        <h2>Restore from backup file</h2>
        <p className="muted" style={{ marginTop: 0 }}>
          Select the encrypted <code>.json</code> backup you saved, then enter its passphrase. The seed is
          decrypted on this device — the file and passphrase never leave your browser.
        </p>
        {error && <div className="msg err">{error}</div>}
        <label>Backup file (.json)</label>
        <input
          type="file"
          accept="application/json,.json"
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (!f) return;
            setRestoreName(f.name);
            f.text().then(setRestoreJson).catch(() => setError("Could not read that file."));
          }}
        />
        {restoreName && <div className="muted" style={{ fontSize: "0.85em" }}>Selected: {restoreName}</div>}
        {/* Restore must accept the backup in the shape it LEFT in.
            A backup taken on a phone can leave as clipboard text — that is the fallback
            when no share sheet is available — and this screen used to accept a file and
            nothing else. Backing up on mobile and then being unable to restore is the
            worst possible outcome for a feature whose entire job is not losing a wallet. */}
        <div className="row" style={{ gap: 8, marginTop: 10, alignItems: "center" }}>
          <button
            className="btn ghost small"
            onClick={async () => {
              try {
                const text = await navigator.clipboard.readText();
                if (!text.trim()) {
                  setError("Your clipboard is empty.");
                  return;
                }
                setRestoreJson(text);
                setRestoreName("pasted from clipboard");
                setError("");
              } catch {
                setError("Couldn't read the clipboard — paste the backup into the box below instead.");
              }
            }}
          >
            Paste backup
          </button>
          <span className="muted small">if you saved it as text</span>
        </div>
        <textarea
          value={restoreJson}
          onChange={(e) => {
            setRestoreJson(e.target.value);
            if (e.target.value.trim()) setRestoreName("pasted");
          }}
          placeholder='or paste the backup here — it starts with {"version"...'
          rows={3}
          style={{ marginTop: 8, fontFamily: "var(--mono, monospace)", fontSize: 12 }}
        />
        <label>Backup passphrase</label>
        <input type="password" value={restorePass} onChange={(e) => setRestorePass(e.target.value)} placeholder="the passphrase you set when backing up" />
        <div className="row" style={{ gap: 8, marginTop: 12 }}>
          <button className="btn ghost" onClick={() => setMode("choose")}>
            Back
          </button>
          <button className="btn" disabled={busy || !restoreJson.trim() || !restorePass} onClick={doRestoreFile}>
            {busy ? <span className="spin" /> : "Restore wallet"}
          </button>
        </div>
      </div>
    );
  }

  if (mode === "backup") {
    return (
      <div className="card">
        <h2>Restore from backup</h2>
        <RestoreSeedBackup onBack={() => setMode("choose")} />
      </div>
    );
  }

  if (mode === "import") {
    return (
      <div className="card">
        <h2>Import wallet</h2>
        <label>Recovery seed (64 hex characters)</label>
        <textarea value={importHex} onChange={(e) => setImportHex(e.target.value)} placeholder="e.g. 0a1b2c…" />
        <label>When was this wallet created? (optional — makes sync much faster)</label>
        <input type="date" value={createdDate} max={new Date().toISOString().slice(0, 10)} onChange={(e) => setCreatedDate(e.target.value)} />
        <label>Advanced — exact block height (overrides the date)</label>
        <input
          value={birthday}
          onChange={(e) => setBirthday(e.target.value.replace(/[^0-9]/g, ""))}
          placeholder="0 = scan whole chain for old funds"
          inputMode="numeric"
        />
        <div className="msg small" style={{ background: "transparent", border: "1px solid var(--border)", color: "var(--muted)" }}>
          The scan starts a safe margin before the date you pick, so nothing is missed — leave both blank to scan the
          whole chain. If this wallet has been used on this service before (any device), sync resumes instantly
          regardless.
        </div>
        {error && <div className="msg err">{error}</div>}
        <div className="row">
          <button className="btn ghost" onClick={() => setMode("choose")}>
            Back
          </button>
          <button className="btn" disabled={busy || importHex.trim().length !== 64} onClick={doImport}>
            {busy ? <span className="spin" /> : "Import"}
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="card center">
      <h2>Welcome</h2>
      <p className="muted" style={{ marginTop: 0 }}>
        Create a new wallet or restore yours. Every ZKAS payment is private.
      </p>
      {error && <div className="msg err">{error}</div>}
      {/* Creating before the first status answer means birthday 0 — a brand-new
          wallet would then scan ALL 850k+ blocks for history it cannot have.
          Wait for the chain tip so the birthday anchors at "now". */}
      <button className="btn" disabled={busy || !status?.daa_score} onClick={create}>
        {busy ? <span className="spin" /> : status?.daa_score ? "Create new wallet" : "Connecting…"}
      </button>
      {/* Desktop keeps backups in a known folder, so restoring is a pick from a
          list rather than hunting for a file — the reason to write backups at all. */}
      {isDesktop() && (
        <button className="btn ghost" onClick={() => setMode("backup")}>
          Restore from backup file
        </button>
      )}
      {!isDesktop() && (
        <button className="btn ghost" onClick={() => setMode("restorefile")}>
          Restore from backup file
        </button>
      )}
      <button className="btn ghost" onClick={() => setMode("import")}>
        Import from seed
      </button>
    </div>
  );
}

/// One transaction, in full.
///
/// History rows used to be dead ends whose only action was opening a block
/// explorer — which, on a shielded chain, can tell the user nothing about their
/// own payment. Everything knowable lives in this wallet, so this is where it
/// belongs: amount, fee, when, the memo, the counterparty (nameable on the
/// spot), and the txid.
/// The send animation. A coin of value is drawn into a shield that seals shut
/// (privacy), then fires off along a fast light-trail (speed) — the two things
/// that make a ZKas payment worth making, shown while the proof builds so the
/// wait reads as "sealing your payment", not "hanging". The stage drives which
/// beat is emphasised; the scene loops so a long multi-note send stays alive.
function SendScene({ stage, estimateMs }: { stage?: SendStage; estimateMs?: number | null }) {
  const s = stage ?? "proving";
  // Elapsed seconds on the long step. "Proving" is named for the Halo 2 proof, but
  // the proof is the FAST part (~2s): most of the wait is the daemon locating each
  // spent note's position in the chain, which on a wallet whose witnesses are cold
  // takes a minute or two. Measured live 2026-08-07: 122.0s witnessing, 2.4s proof.
  //
  // With no elapsed time and no explanation, a two-minute wait under the words
  // "Building your zero-knowledge proof" reads as a hang, and the user starts
  // wondering whether their money is stuck. It is not — nothing has been sent and
  // nothing can be lost at this stage — so say so, and keep a number moving.
  const [secs, setSecs] = useState(0);
  useEffect(() => {
    setSecs(0);
    const t = setInterval(() => setSecs((n) => n + 1), 1000);
    return () => clearInterval(t);
  }, [s]);
  // Counts down against what THIS device measured last time, and only then. Until a
  // run has been watched to completion there is no honest number, so the elapsed
  // clock carries it alone — the first send of a wallet's life is genuinely
  // unpredictable, and inventing a figure teaches people to disbelieve the real ones
  // later. `remainingLabel` also stops predicting once it overruns, rather than
  // sitting at zero, which is the other way a countdown loses trust.
  const remaining = remainingLabel(estimateMs ?? null, secs * 1000);
  const slow = s === "proving" && secs >= 15;
  const caption =
    s === "signing"
      ? "Signing on your device — your key never leaves it"
      : s === "broadcasting"
        ? "Sealed and shielded — broadcasting to the network"
        : slow
          ? "Locating your coins in the chain — this can take a minute or two"
          : "Building your zero-knowledge proof — nobody will see amount or recipient";
  return (
    <div className={"sendscene s-" + s} role="status" aria-live="polite">
      <div className="sendscene-stage" aria-hidden="true">
        <div className="ss-track" />
        <div className="ss-streak" />
        <div className="ss-spark ss-spark-1" />
        <div className="ss-spark ss-spark-2" />
        <div className="ss-spark ss-spark-3" />
        <div className="ss-payload">
          <div className="ss-coin">
            <span className="ss-coin-z">Z</span>
          </div>
          <div className="ss-shield">
            <svg viewBox="0 0 40 46" width="48" height="54">
              <path
                className="ss-shield-body"
                d="M20 2 L37 9 V23 C37 34 29 42 20 45 C11 42 3 34 3 23 V9 Z"
                fill="var(--ember-soft)"
                stroke="var(--ember)"
                strokeWidth="2"
                strokeLinejoin="round"
              />
              <path
                className="ss-shield-check"
                d="M13 23 L18 29 L28 16"
                fill="none"
                stroke="var(--ember)"
                strokeWidth="2.4"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
          </div>
        </div>
      </div>
      <div className="sendscene-steps" aria-hidden="true">
        <span className={"ss-step" + (s === "proving" ? " on" : " done")}>Prove</span>
        <span className={"ss-step" + (s === "signing" ? " on" : s === "broadcasting" ? " done" : "")}>Sign</span>
        <span className={"ss-step" + (s === "broadcasting" ? " on" : "")}>Send</span>
      </div>
      <div className="sendscene-cap">{caption}</div>
      {/* aria-hidden: the container is an aria-live region, and a counter ticking
          once a second would have a screen reader read the whole scene every
          second. The caption above changes rarely and carries the meaning. */}
      {secs >= 5 && (
        <div className="sendscene-cap sendscene-elapsed" aria-hidden="true">
          {secs < 60 ? `${secs}s` : `${Math.floor(secs / 60)}m ${secs % 60}s`}
          {remaining && <span className="sendscene-remaining"> · {remaining}</span>}
        </div>
      )}
      {slow && (
        <div className="sendscene-cap sendscene-reassure" aria-hidden="true">
          Nothing has been sent yet and nothing can be lost — keep this open.
        </div>
      )}
    </div>
  );
}

/// Adapt a device-recorded send into the shape the detail modal reads. Device rows
/// are always our own sends; `confs` carries the live confirmation count so the
/// same modal can show "0-conf" or "12 confirmations" for a send the chain history
/// hasn't attributed yet. The wallet's optimistic 0-conf list is the ONLY record
/// of a send made with chain history off, so it must open real details, not bounce
/// straight to the explorer.
function localTxToRow(t: LocalTx): ChainHistoryRow & { confs?: number } {
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

function TxDetail({
  row,
  onClose,
  onSendAgain,
  onLabelSaved,
}: {
  row: ChainHistoryRow & { confs?: number };
  onClose: () => void;
  onSendAgain?: (addr: string) => void;
  onLabelSaved?: () => void;
}) {
  const [saving, setSaving] = useState(false);
  const [copied, setCopied] = useState("");
  const [label, setLabel] = useState(() => getTxLabel(row.txid));
  const [labelState, setLabelState] = useState("");
  const contact = findContact(row.recipient);
  const kind = row.kind === "coinbase" ? "Mined" : row.kind === "received" ? "Received" : "Sent";
  const sign = row.kind === "sent" ? "−" : "+";
  const copy = async (what: string, value: string) => {
    await copyText(value);
    setCopied(what);
    setTimeout(() => setCopied(""), 1500);
  };
  return createPortal(
    <div className="modalwrap" onClick={onClose}>
      <div className="card modalcard wide" onClick={(e) => e.stopPropagation()}>
        <h2 style={{ marginTop: 0 }}>{kind}</h2>
        <div className="amt" style={{ fontSize: 30, marginBottom: 10 }}>
          {sign} {trimFc(row.amountZkas.toFixed(8))}
          <span className="unit"> ZKAS</span>
        </div>

        {row.memo && (
          <div className="msg small" style={{ background: "transparent", border: "1px solid var(--border)" }}>
            “{row.memo}”
          </div>
        )}

        <div className="detail-row">
          <span className="k">Status</span>
          <span className="v">
            {row.confs != null ? (
              row.confs >= 1 ? (
                <span className="conf-pill done">{row.confs} confirmation{row.confs === 1 ? "" : "s"}</span>
              ) : (
                <span className="conf-pill wait">Broadcast · awaiting confirmation</span>
              )
            ) : (
              <span className="conf-pill done">Confirmed on-chain</span>
            )}
          </span>
        </div>
        <div className="detail-row tx-label-row">
          <label className="k" htmlFor="tx-label">Private label</label>
          <span className="v tx-label-editor">
            <input id="tx-label" value={label} maxLength={160} placeholder="Order, customer, purpose…" onChange={(event) => { setLabel(event.target.value); setLabelState(""); }} />
            <button className="btn ghost small" onClick={() => {
              try {
                setTxLabel(row.txid, label);
                setLabelState("Saved on this device");
                onLabelSaved?.();
              } catch (error) {
                setLabelState((error as Error).message);
              }
            }}>Save</button>
            {labelState && <small>{labelState}</small>}
          </span>
        </div>
        <div className="detail-row">
          <span className="k">When</span>
          <span className="v">{row.timestamp > 0 ? fmtTime(row.timestamp) : `DAA ${row.daaScore}`}</span>
        </div>
        {row.feeSompi > 0 && (
          <div className="detail-row">
            <span className="k">Network fee</span>
            <span className="v mono">{trimFc((row.feeSompi / 1e8).toFixed(8))} ZKAS</span>
          </div>
        )}
        {row.recipient && (
          <div className="detail-row">
            <span className="k">{row.kind === "sent" ? "To" : "Received at"}</span>
            <span className="v mono" style={{ fontSize: 12 }}>
              {contact ? <b>{contact.name}</b> : shortAddr(row.recipient)}
            </span>
          </div>
        )}
        <div className="detail-row">
          <span className="k">Transaction</span>
          <span className="v mono" style={{ fontSize: 12 }}>
            {shortAddr(row.txid)}
          </span>
        </div>

        <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginTop: 14 }}>
          <button className="btn ghost small" onClick={() => copy("txid", row.txid)}>
            {copied === "txid" ? "Copied ✓" : "Copy transaction id"}
          </button>
          {row.recipient && (
            <button className="btn ghost small" onClick={() => copy("addr", row.recipient!)}>
              {copied === "addr" ? "Copied ✓" : "Copy address"}
            </button>
          )}
          {row.recipient && !contact && (
            <button className="btn ghost small" onClick={() => setSaving(true)}>
              Save as contact
            </button>
          )}
          {row.recipient && row.kind === "sent" && onSendAgain && (
            <button className="btn ghost small" onClick={() => onSendAgain(row.recipient!)}>
              Send again
            </button>
          )}
          <a className="btn ghost small" href={`#/explore/tx/${row.txid}`}>
            View on explorer
          </a>
        </div>
        <p className="muted small" style={{ marginTop: 12 }}>
          The explorer shows that a shielded transaction happened — never its amount, sender, recipient or note. This
          screen is the only place those exist, and only for you.
        </p>
        <button className="btn ghost" onClick={onClose}>
          Close
        </button>
        {saving && row.recipient && <SaveContactDialog address={row.recipient} onClose={() => setSaving(false)} />}
      </div>
    </div>,
    document.body,
  );
}

/// History as a spreadsheet, for accounting and taxes. Generated on-device from
/// data the wallet already holds — nothing is uploaded to produce it.
function historyCsv(rows: ChainHistoryRow[]): string {
  const esc = (v: string) => `"${v.replace(/"/g, '""')}"`;
  const head = ["kind", "amount_zkas", "fee_zkas", "time_utc", "daa_score", "counterparty", "memo", "private_label", "txid"];
  const lines = rows.map((r) =>
    [
      r.kind,
      r.amountZkas.toFixed(8),
      (r.feeSompi / 1e8).toFixed(8),
      r.timestamp > 0 ? new Date(r.timestamp).toISOString() : "",
      String(r.daaScore),
      displayName(r.recipient, r.recipient ?? ""),
      r.memo ?? "",
      getTxLabel(r.txid),
      r.txid,
    ]
      .map(esc)
      .join(","),
  );
  return [head.join(","), ...lines].join("\n");
}

/// Everything that is not receiving, sending, or reading history.
///
/// Grouped and ordered by how often a person actually needs it: who you pay,
/// what protects the key, how you get the wallet back, what it talks to, and
/// the power tools last. Each section is a card so the pane reads as a list of
/// concerns rather than one wall of controls.
function SettingsPane({ status }: { status: Status }) {
  return (
    <>
      <ContactsCard />
      <AppLockSetting />
      <BackgroundSyncCard />
      <RevealSeedCard expectedAddress={status.address ?? undefined} />
      {isDesktop() ? (
        <>
          <VaultSetting />
          <NodeSourceSetting />
        </>
      ) : (
        <DaemonSetting />
      )}
      <AppearanceCard />
      {!ROOMY() && <Signatures status={status} />}
      <SwitchWallet />
      <AboutCard />
    </>
  );
}

/// Light/dark. Defaults to following the system, which is what most people
/// expect and nobody has to discover.
function AppearanceCard() {
  const [t, setT] = useState<Theme>(currentTheme());
  const [a, setA] = useState<Accent>(currentAccent());
  const choose = (next: Theme) => {
    setTheme(next);
    setT(next);
  };
  const chooseAccent = (next: Accent) => {
    setAccent(next);
    setA(next);
  };
  return (
    <div className="card">
      <h2>Appearance</h2>
      <p className="muted small" style={{ marginTop: 0 }}>
        ZKas is dark by default. Light is here if you want it — it does not follow your system, so nothing changes
        under you unexpectedly.
      </p>
      <div className="filterbar" style={{ marginBottom: 18 }}>
        {(["dark", "light"] as Theme[]).map((opt) => (
          <button key={opt} className={"chip" + (t === opt ? " on" : "")} onClick={() => choose(opt)}>
            {opt === "dark" ? "Dark" : "Light"}
          </button>
        ))}
      </div>
      <h3 style={{ marginTop: 0 }}>Accent</h3>
      <p className="muted small" style={{ marginTop: 0, marginBottom: 12 }}>
        The color your balance, buttons and highlights glow with. Teal is the ZKas signature.
      </p>
      <div className="swatches">
        {(Object.keys(ACCENTS) as Accent[]).map((opt) => (
          <button
            key={opt}
            className={"swatch" + (a === opt ? " on" : "")}
            style={{ ["--sw" as string]: ACCENTS[opt].base }}
            onClick={() => chooseAccent(opt)}
            aria-label={ACCENTS[opt].label}
            aria-pressed={a === opt}
            title={ACCENTS[opt].label}
          >
            <span className="swatch-dot" />
          </button>
        ))}
      </div>
    </div>
  );
}

/// Signing and verifying, together.
///
/// They are one subject — proving that whoever controls an address said
/// something — and a person arrives wanting one side or the other, never both at
/// once. Two tabs made each look like a separate feature and cost a slot the
/// wallet needed for money.
function Signatures({ status }: { status: Status | null }) {
  const [mode, setMode] = useState<"sign" | "verify">("sign");
  return (
    <div className="card">
      <h2>Signatures</h2>
      <p className="muted small" style={{ marginTop: 0 }}>
        Prove you control your address without spending from it, or check somebody else's proof.
      </p>
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 16 }}>
        <button className={"chip" + (mode === "sign" ? " on" : "")} onClick={() => setMode("sign")}>
          Sign a message
        </button>
        <button className={"chip" + (mode === "verify" ? " on" : "")} onClick={() => setMode("verify")}>
          Verify a signature
        </button>
      </div>
      {mode === "sign" ? <Sign status={status} embedded /> : <Verify embedded />}
    </div>
  );
}

/// Message signing and verification: real capabilities, but ones a person needs
/// a handful of times ever. They used to occupy two of five primary tabs.
function AboutCard() {
  return (
    <div className="card">
      <h2>About</h2>
      <p className="muted small" style={{ marginTop: 0 }}>
        ZKas Wallet — every balance and payment shielded by Orchard zero-knowledge proofs. Your spending key is held on
        this device and never sent anywhere.
      </p>
      <a href="https://github.com/firecash/zkas-wallet" target="_blank" rel="noreferrer">
        Source code
      </a>
      {" · "}
      <a href={EXPLORER} target="_blank" rel="noreferrer">
        Explorer
      </a>
    </div>
  );
}

/// Initials for a contact avatar — a face for a 79-character address.
function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "?";
  return (parts[0][0] + (parts[1]?.[0] ?? "")).toUpperCase();
}

/// Pick someone to pay from the address book.
function ContactPicker({ onPick, onClose }: { onPick: (c: Contact) => void; onClose: () => void }) {
  const [q, setQ] = useState("");
  const list = sortedContacts().filter(
    (c) => !q.trim() || c.name.toLowerCase().includes(q.toLowerCase()) || c.address.toLowerCase().includes(q.toLowerCase()),
  );
  return createPortal(
    <div className="modalwrap" onClick={onClose}>
      <div className="card modalcard" onClick={(e) => e.stopPropagation()}>
        <h2 style={{ marginTop: 0 }}>Choose a contact</h2>
        {sortedContacts().length === 0 ? (
          <p className="muted small">
            No contacts yet. Save one after a payment, or from a received address — on a shielded chain the wallet is
            the only place an address can have a name.
          </p>
        ) : (
          <>
            <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search name or address" autoFocus />
            <div style={{ maxHeight: "46vh", overflowY: "auto", marginTop: 6 }}>
              {list.map((c) => (
                <div key={c.id} className="contact-row" style={{ cursor: "pointer" }} onClick={() => onPick(c)}>
                  <div className="avatar">{initials(c.name)}</div>
                  <div className="contact-main">
                    <div className="contact-name">{c.name}</div>
                    <div className="contact-addr">{c.address}</div>
                  </div>
                </div>
              ))}
              {list.length === 0 && <p className="muted small">Nobody matches that.</p>}
            </div>
          </>
        )}
        <button className="btn ghost" onClick={onClose}>
          Close
        </button>
      </div>
    </div>,
    document.body,
  );
}

/// Name an address, from wherever the user just met it. `initialName` prefills a
/// SUGGESTED name (e.g. a QR's `label`) — a claim by the payee, never auto-saved:
/// the user confirms it here explicitly.
function SaveContactDialog({ address, initialName, onClose }: { address: string; initialName?: string; onClose: () => void }) {
  const [name, setName] = useState(findContact(address)?.name ?? initialName ?? "");
  const [note, setNote] = useState(findContact(address)?.note ?? "");
  const toast = useToast();
  return createPortal(
    <div className="modalwrap" onClick={onClose}>
      <div className="card modalcard" onClick={(e) => e.stopPropagation()}>
        <h2 style={{ marginTop: 0 }}>Save contact</h2>
        <label>Name</label>
        <input value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Alice" autoFocus />
        <label>Note (optional)</label>
        <input value={note} onChange={(e) => setNote(e.target.value)} placeholder="What this address is for" />
        <label>Address</label>
        <div className="addr" style={{ fontSize: 12 }}>
          {address}
        </div>
        <p className="muted small">Stored only on this device — a list of who you pay is exactly the metadata ZKas exists to protect.</p>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          <button
            className="btn"
            disabled={!name.trim()}
            onClick={() => {
              addContact(name, address, note);
              toast.show("good", `Saved ${name.trim()}`);
              onClose();
            }}
          >
            Save
          </button>
          <button className="btn ghost" onClick={onClose}>
            Cancel
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}

/// The address book as a settings card: rename, re-address, remove.
function ContactsCard() {
  const [, bump] = useState(0);
  const [editing, setEditing] = useState<Contact | null>(null);
  const [adding, setAdding] = useState(false);
  const [newAddr, setNewAddr] = useState("");
  useEffect(() => {
    const h = () => bump((n) => n + 1);
    window.addEventListener("contacts-changed", h);
    return () => window.removeEventListener("contacts-changed", h);
  }, []);
  const list = sortedContacts();
  return (
    <div className="card">
      <h2>Contacts</h2>
      {list.length === 0 ? (
        <p className="muted small" style={{ marginTop: 0 }}>
          Nobody saved yet. Naming an address here is the only way it will ever read as a person — the chain itself
          knows nothing about who anyone is.
        </p>
      ) : (
        <div style={{ marginBottom: 10 }}>
          {list.map((c) => (
            <div key={c.id} className="contact-row">
              <div className="avatar">{initials(c.name)}</div>
              <div className="contact-main">
                <div className="contact-name">{c.name}</div>
                <div className="contact-addr">{c.address}</div>
                {c.note && <div className="muted small">{c.note}</div>}
              </div>
              <button className="linkbtn" onClick={() => setEditing(c)}>
                Edit
              </button>
            </div>
          ))}
        </div>
      )}
      {adding ? (
        <>
          <label>Address</label>
          <input
            value={newAddr}
            onChange={(e) => setNewAddr(e.target.value)}
            placeholder="zkas:…"
            className="mono"
            autoCapitalize="off"
            spellCheck={false}
          />
          <div style={{ display: "flex", gap: 8 }}>
            <button
              className="btn"
              disabled={!looksLikeAddress(newAddr)}
              onClick={() => {
                setEditing({ id: "", name: "", address: newAddr.trim(), createdUnix: 0 });
                setAdding(false);
                setNewAddr("");
              }}
            >
              Next
            </button>
            <button className="btn ghost" onClick={() => setAdding(false)}>
              Cancel
            </button>
          </div>
        </>
      ) : (
        <button className="btn ghost" onClick={() => setAdding(true)}>
          Add a contact
        </button>
      )}
      {editing && <EditContact contact={editing} onClose={() => setEditing(null)} />}
    </div>
  );
}

function EditContact({ contact, onClose }: { contact: Contact; onClose: () => void }) {
  const [name, setName] = useState(contact.name);
  const [note, setNote] = useState(contact.note ?? "");
  const [confirmDel, setConfirmDel] = useState(false);
  const isNew = !contact.id;
  return createPortal(
    <div className="modalwrap" onClick={onClose}>
      <div className="card modalcard" onClick={(e) => e.stopPropagation()}>
        <h2 style={{ marginTop: 0 }}>{isNew ? "New contact" : "Edit contact"}</h2>
        <label>Name</label>
        <input value={name} onChange={(e) => setName(e.target.value)} autoFocus />
        <label>Note (optional)</label>
        <input value={note} onChange={(e) => setNote(e.target.value)} />
        <label>Address</label>
        <div className="addr" style={{ fontSize: 12 }}>
          {contact.address}
        </div>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          <button
            className="btn"
            disabled={!name.trim()}
            onClick={() => {
              if (isNew) addContact(name, contact.address, note);
              else updateContact(contact.id, { name, note });
              onClose();
            }}
          >
            Save
          </button>
          <button className="btn ghost" onClick={onClose}>
            Cancel
          </button>
          {!isNew && (
            <button className="btn ghost" style={{ color: "var(--bad)" }} onClick={() => setConfirmDel(true)}>
              Remove
            </button>
          )}
        </div>
        {confirmDel && (
          <ConfirmDialog
            title={`Remove ${contact.name}?`}
            body="Only the name is forgotten — any payments you made are untouched, and the address itself stays in your history."
            confirmLabel="Remove"
            danger
            onConfirm={() => {
              removeContact(contact.id);
              setConfirmDel(false);
              onClose();
            }}
            onCancel={() => setConfirmDel(false)}
          />
        )}
      </div>
    </div>,
    document.body,
  );
}

/// Re-derive the wallet from the chain. Prominent on both Receive and History
/// because it is the answer to the two things a user panics about: "my payment
/// hasn't shown up" and "my balance/history is missing something".
function RescanButton({ label, hint }: { label: string; hint: string }) {
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  // Whether history recording is on decides what a rescan can actually give
  // back. With it off, a rescan still recovers notes and balance — the funds —
  // but writes no transaction rows, so the button must not promise a list.
  const [historyOn, setHistoryOn] = useState<boolean | null>(null);
  useEffect(() => {
    let live = true;
    api
      .history()
      .then((h) => live && setHistoryOn(h.recoverableHistory))
      .catch(() => {});
    return () => {
      live = false;
    };
  }, []);

  // `ask` holds the pending action (its value = "also enable history") until the
  // user confirms in-app.
  const [ask, setAsk] = useState<boolean | null>(null);
  const [err, setErr] = useState("");

  const run = async (alsoEnableHistory: boolean) => {
    setAsk(null);
    setErr("");
    setBusy(true);
    try {
      if (alsoEnableHistory) {
        await api.setHistoryEnabled(true);
        setHistoryOn(true);
      }
      await api.rescan();
      setDone(true);
      setTimeout(() => setDone(false), 6000);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const scopeText = (alsoEnableHistory: boolean) =>
    (alsoEnableHistory
      ? "Rescan will re-read the chain from your wallet's birthday, recovering your balance AND rebuilding your transaction history from here on."
      : historyOn === false
        ? "Rescan will re-read the chain from your wallet's birthday and recover your balance. History is off, so no transaction list is produced."
        : "Rescan will re-read the chain from your wallet's birthday to rebuild history and recover anything missing.") +
    " Takes a minute or two — the balance shows as syncing meanwhile.";

  const offHint = "Recovers your balance from the chain. History is off, so this rebuilds funds — not a transaction list.";
  return (
    <div className="rescanbox">
      <div>
        <b>{label}</b>
        <div className="muted small">
          {done ? "Rescanning — this tab updates as it catches up." : historyOn === false ? offHint : hint}
        </div>
      </div>
      <div className="rescanbox-actions">
        <button className="btn ghost" onClick={() => setAsk(false)} disabled={busy}>
          {busy ? "Starting…" : "↻ Rescan"}
        </button>
        {historyOn === false && (
          <button className="btn ghost small" onClick={() => setAsk(true)} disabled={busy}>
            Enable history & recover
          </button>
        )}
      </div>
      {err && <div className="msg err">{err}</div>}
      {ask !== null && (
        <ConfirmDialog
          title={ask ? "Enable history & recover" : "Rescan wallet"}
          body={scopeText(ask)}
          confirmLabel={ask ? "Enable & rescan" : "Rescan"}
          onConfirm={() => run(ask)}
          onCancel={() => setAsk(null)}
        />
      )}
    </div>
  );
}

function Receive({ status }: { status: Status }) {
  const addr = status.address || "";
  // The address QR never changes, so it's cached after the first render and shows
  // instantly on every later open — no beat where the card has a QR-shaped hole.
  const [qr, setQr] = useState(() => (addr && localStorage.getItem("qr_" + addr)) || "");
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!addr) return; // never blank an already-rendered QR on a transient empty poll
    const cached = localStorage.getItem("qr_" + addr);
    if (cached) {
      setQr(cached);
      return;
    }
    QRCode.toDataURL(addr, { margin: 1, width: 440 })
      .then((url) => {
        setQr(url);
        try {
          localStorage.setItem("qr_" + addr, url);
        } catch {
          /* best-effort cache */
        }
      })
      .catch(() => {});
  }, [addr]);
  const copy = async () => {
    await copyText(addr);
    setCopied(true);
    setTimeout(() => setCopied(false), 1600);
  };
  return (
    <div className="card">
      <h2>Receive</h2>
      <p className="muted small" style={{ marginTop: 0 }}>
        Share this address or QR to receive ZKAS. Every payment to it is private.
      </p>
      <div className="qr qr-shield">
        {qr && <img src={qr} alt="address QR" onClick={copy} style={{ cursor: "pointer" }} />}
      </div>
      <label>Your shielded address</label>
      <div className="addr" onClick={copy} style={{ cursor: "pointer" }} title="Tap to copy">
        {addr}
      </div>
      <button className={"btn ghost small copybtn" + (copied ? " copied" : "")} style={{ marginTop: 12 }} onClick={copy}>
        {copied ? "Copied ✓" : "Copy address"}
      </button>

      <div className="privacy-note">
        <span className="privacy-note-mark" aria-hidden="true" />
        <span>
          <b>Nobody can see this coming.</b> Amounts, sender and recipient are sealed by zero-knowledge proofs — the
          chain records that a valid payment happened, never who paid what to whom.
        </span>
      </div>

      <RescanButton label="Payment not showing up?" hint="Re-read the chain for this wallet — recovers anything the local view is missing." />

      <p className="muted small" style={{ marginTop: 18 }}>
        Looking for your recovery seed? It moved to <b>Settings → Recovery seed</b>, behind your app lock.
      </p>
    </div>
  );
}

/// Settings card that reveals the recovery seed — deliberately, never by one
/// stray tap. It used to be a single button inside Receive; "reveal" pressed in
/// a public place put the spending key on screen for anyone behind you. Now:
/// with an app lock set, the seed shows only after re-entering the PIN /
/// passphrase (even though the app is already unlocked — this is exactly the
/// moment to re-prove it's the owner holding the phone); without one, an
/// explicit are-you-somewhere-private confirmation stands in the way instead.
function RevealSeedCard({ expectedAddress }: { expectedAddress?: string }) {
  const [step, setStep] = useState<"idle" | "gate" | "shown">("idle");
  const [pass, setPass] = useState("");
  const [seed, setSeed] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [copied, setCopied] = useState(false);
  const locked = isLockEnabled();
  const pin = lockKind() === "pin";

  const reveal = async () => {
    setBusy(true);
    setError("");
    try {
      if (locked) {
        // Verify against the SAME sealed record the app lock uses; a wrong
        // entry reveals nothing.
        if (!(await unlock(pass))) {
          setError(pin ? "Wrong PIN." : "Wrong passphrase.");
          return;
        }
      }
      // The seed lives on this device, not on the server. The address lets a
      // seed orphaned under a stale token be found and reattached (see
      // resolveDeviceSeed) instead of wrongly claiming the key is gone.
      setSeed(await resolveDeviceSeed(expectedAddress));
      setStep("shown");
      setPass("");
    } catch (e) {
      setError(
        (e as Error).message === SEED_REQUIRED
          ? "This device doesn't hold this wallet's seed — it was never sent to the server. Restore it from the backup you saved when you created the wallet."
          : (e as Error).message,
      );
    } finally {
      setBusy(false);
    }
  };

  const copy = async () => {
    try {
      await copyText(seed);
    } catch {
      /* clipboard may be blocked; seed is shown to copy by hand */
    }
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <div className="card">
      <h2>Recovery seed</h2>
      <p className="muted small" style={{ marginTop: 4 }}>
        Your seed is the only way to restore this wallet. Anyone who sees it can spend your funds — reveal it only
        somewhere private.
      </p>
      {error && <div className="msg err">{error}</div>}
      {step === "idle" && (
        <button
          className="btn ghost small"
          onClick={() => {
            setError("");
            setStep("gate");
          }}
        >
          Reveal recovery seed…
        </button>
      )}
      {step === "gate" &&
        (locked ? (
          <>
            <label>{pin ? "Enter your PIN to reveal" : "Enter your passphrase to reveal"}</label>
            <div className="row">
              <input
                type="password"
                inputMode={pin ? "numeric" : undefined}
                autoComplete="off"
                value={pass}
                onChange={(e) => setPass(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && !busy && pass && reveal()}
              />
              <button className="btn small" style={{ flex: "0 0 auto" }} disabled={busy || !pass} onClick={reveal}>
                {busy ? <span className="spin" /> : "Reveal"}
              </button>
            </div>
            <button className="btn ghost small" style={{ marginTop: 10 }} onClick={() => setStep("idle")}>
              Cancel
            </button>
          </>
        ) : (
          <>
            <div className="msg warn small">
              Make sure nobody can see your screen. The next tap puts your spending key on it.
            </div>
            <div className="row" style={{ marginTop: 10 }}>
              <button className="btn small" disabled={busy} onClick={reveal}>
                {busy ? <span className="spin" /> : "I'm somewhere private — reveal"}
              </button>
              <button className="btn ghost small" onClick={() => setStep("idle")}>
                Cancel
              </button>
            </div>
          </>
        ))}
      {step === "shown" && (
        <>
          <div className="msg warn small">Keep this private. Anyone with it controls your funds.</div>
          <div className="addr">{seed}</div>
          <div className="row" style={{ marginTop: 12 }}>
            <button className="btn ghost small" onClick={copy}>
              {copied ? "Copied ✓" : "Copy seed"}
            </button>
            <button
              className="btn ghost small"
              onClick={() => {
                setSeed("");
                setStep("idle");
              }}
            >
              Hide
            </button>
          </div>
        </>
      )}
    </div>
  );
}

// Network fee bounds. The daemon computes the EXACT fee per payment — the node's
// minimum is byte-proportional, so it grows with how many shielded notes the
// payment has to spend (1–2 notes ≈ 0.03, up to ~0.044 for a full 6-note tx).
// The UI validates and reserves against the worst case; the true fee comes back
// with the send result and is what gets recorded.
const FEE_FC = 0.03; // typical (1–2 note) fee — shown as the "from" figure
const FEE_MAX_FC = 0.045; // worst-case single-tx fee — used for Max & validation

// Full-screen camera QR scanner. Decodes frames in-page with jsQR — the video
// never leaves the device. Works on the web (getUserMedia) and inside the native
// WebView (the app declares CAMERA; Capacitor grants the WebView on first use).
// Fires `onResult` once with the decoded text, then the parent unmounts us and
// our cleanup stops the camera.
function QrScanner({ onResult, onClose }: { onResult: (text: string) => void; onClose: () => void }) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const [err, setErr] = useState("");

  useEffect(() => {
    let stream: MediaStream | null = null;
    let raf = 0;
    let done = false;
    const canvas = document.createElement("canvas");
    const ctx = canvas.getContext("2d", { willReadFrequently: true });

    const stop = () => {
      done = true;
      cancelAnimationFrame(raf);
      stream?.getTracks().forEach((t) => t.stop());
    };

    const tick = () => {
      const v = videoRef.current;
      if (done || !v || !ctx) return;
      if (v.readyState === v.HAVE_ENOUGH_DATA && v.videoWidth) {
        canvas.width = v.videoWidth;
        canvas.height = v.videoHeight;
        ctx.drawImage(v, 0, 0, canvas.width, canvas.height);
        const { data, width, height } = ctx.getImageData(0, 0, canvas.width, canvas.height);
        const code = jsQR(data, width, height, { inversionAttempts: "dontInvert" });
        if (code?.data) {
          stop();
          onResult(code.data);
          return;
        }
      }
      raf = requestAnimationFrame(tick);
    };

    (async () => {
      try {
        if (!navigator.mediaDevices?.getUserMedia) throw new Error("no-camera-api");
        stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: "environment" }, audio: false });
        if (done) { stream.getTracks().forEach((t) => t.stop()); return; }
        const v = videoRef.current;
        if (!v) return;
        v.srcObject = stream;
        v.setAttribute("playsinline", "true");
        await v.play();
        raf = requestAnimationFrame(tick);
      } catch (e) {
        const name = (e as Error).name || (e as Error).message;
        setErr(
          name === "NotAllowedError" || name === "SecurityError"
            ? "Camera permission was denied. Allow camera access, or paste the address instead."
            : name === "NotFoundError"
              ? "No camera found on this device — paste the address instead."
              : "Couldn't start the camera. Paste the address instead.",
        );
      }
    })();

    return stop;
  }, [onResult]);

  return (
    <div className="scan-overlay" role="dialog" aria-modal="true" aria-label="Scan address QR code">
      {/* Full-bleed camera, with the dimming and the frame drawn OVER it. The old
          layout put a 320px square of video in the middle of a black screen: the
          feed was cropped to a narrow slice of a 16:9 sensor so it was hard to aim,
          and the reticle's dim-everything-outside shadow was clipped away entirely
          by the frame's `overflow: hidden`, so none of it did what it looked like
          it was meant to do. */}
      <video ref={videoRef} className="scan-video" muted playsInline />
      <div className="scan-mask" aria-hidden="true">
        <div className="scan-window">
          <span className="scan-corner tl" />
          <span className="scan-corner tr" />
          <span className="scan-corner bl" />
          <span className="scan-corner br" />
          <span className="scan-laser" />
        </div>
      </div>
      <div className="scan-ui">
        <p className="scan-hint">{err || "Point the camera at the recipient's address QR code"}</p>
        <button type="button" className="btn ghost scan-cancel" onClick={onClose}>
          {err ? "Close" : "Cancel"}
        </button>
      </div>
    </div>
  );
}

function Send({
  status,
  onSent,
  prefillTo,
  onPrefillConsumed,
  outflow,
}: {
  status: Status | null;
  onSent: (sent: Omit<LocalTx, "pending">[], opts?: { stay?: boolean }) => void;
  prefillTo?: string | null;
  onPrefillConsumed?: () => void;
  // Still-pending outgoing value the hero already subtracts from the balance —
  // the Send form must validate against the same figure, or Max/overspend allow
  // an amount the daemon will reject (two balances on one screen).
  outflow: number;
}) {
  const toast = useToast();
  const initialRequest = prefillTo ? parsePaymentUri(prefillTo) : null;
  const [to, setTo] = useState(initialRequest?.address ?? "");
  const [amount, setAmount] = useState(initialRequest?.amount ?? "");
  // Private note to the recipient, sealed inside their encrypted note. Supported
  // by the daemon since day one; the UI simply never offered it.
  const [memo, setMemo] = useState(initialRequest?.memo ?? "");
  const [pickContact, setPickContact] = useState(false);
  // Offered after a successful send to an unknown address — the moment the user
  // actually knows who it was.
  const [saveAddr, setSaveAddr] = useState<string | null>(null);
  // A name SUGGESTED by a scanned QR's `label` — the payee's claim, not a contact.
  // Only ever prefills the save dialog; never auto-saved (that made the wallet
  // vouch for a stranger's address with its own anti-phishing cue).
  const [suggestedName, setSuggestedName] = useState<string | null>(initialRequest?.label ?? null);
  // Consume a "Send again" prefill exactly once — otherwise every later visit to
  // this tab silently resurrects the old recipient (a mis-send waiting to happen).
  useEffect(() => {
    if (prefillTo) onPrefillConsumed?.();
    // Mount-only by design.
  }, []);
  const contact = findContact(to);
  // Paying yourself is valid (it merges notes) but is nearly always a paste
  // mistake, and silently burning a fee for it is the kind of thing a wallet
  // should mention before it happens rather than after.
  const isSelf = !!status?.address && to.trim().toLowerCase() === status.address.toLowerCase();
  const [busy, setBusy] = useState(false);
  const [stage, setStage] = useState<SendStage | null>(null);
  // Chunk progress for a payment that spans several transactions (see SendProgress).
  const [sendProgress, setSendProgress] = useState<SendProgress | null>(null);
  const onStage = useCallback((s: SendStage, p?: SendProgress) => {
    setStage(s);
    if (p) setSendProgress(p);
  }, []);
  const [error, setError] = useState("");
  const [unlock, setUnlock] = useState("");
  const [needSeed, setNeedSeed] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [fragmented, setFragmented] = useState(false);
  const [showConsolidate, setShowConsolidate] = useState(false);
  // What the last comparable send on this device took. `null` until one has
  // finished, which is exactly when a countdown would be a guess.
  const sendEstimateMs = useMemo(
    () => estimateDuration("prepare", activeToken() ?? "default", Math.max(1, Math.min(status?.note_count ?? 1, MAX_NOTES_PER_TX))),
    [status?.note_count],
  );
  const [scanning, setScanning] = useState(false);
  // Advanced: a manual fee (ZKAS). Empty = automatic. The daemon treats it as a
  // floor and still raises anything below the network's byte-proportional
  // minimum — so this can only speed a send up, never break it.
  const [showFeeCfg, setShowFeeCfg] = useState(false);
  const [customFee, setCustomFee] = useState("");

  // The confirm step is a fresh screen — align it under the tab bar so the
  // details are what the user sees, not the page header.
  useEffect(() => {
    if (confirming) scrollToPane();
  }, [confirming]);

  // Desktop: put the cursor straight into the recipient field — the first thing a
  // send needs. Not on touch devices, where autofocus pops the keyboard over the
  // form before the user has even read it.
  const toRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (!confirming && window.matchMedia("(pointer: fine)").matches) toRef.current?.focus();
  }, [confirming]);

  /// Apply a scanned/pasted payment request: address plus whatever the payee
  /// asked for. Their `label` is only a SUGGESTION for this device's address
  /// book — auto-saving it made the wallet vouch for a stranger's address with
  /// its own "from your contacts" trust cue, forgeable by whoever printed the QR.
  const applyRequest = useCallback((text: string) => {
    const { address, amount: amt, memo: m, label } = parsePaymentUri(text);
    setTo(address);
    if (amt) setAmount(amt);
    if (m) setMemo(m);
    if (label && address && !findContact(address)) setSuggestedName(label);
  }, []);

  const onScan = useCallback(
    (text: string) => {
      applyRequest(text);
      setScanning(false);
    },
    [applyRequest],
  );

  // A send can only draw on SPENDABLE (matured) funds, not the full balance — so
  // Max, the overspend check, and messaging all use spendable, and the total's
  // maturing remainder is surfaced separately so "you have money but can't send it"
  // is never a mystery. The pending outflow comes off too: the hero subtracts it,
  // and validating against the raw figure let Max fill an amount the daemon then
  // rejected with a raw insufficient-funds error.
  const spendable = spendableFc(status) - outflow;
  const maturing = maturingFc(status);
  const amt = parseAmount(amount);
  const addrOk = looksLikeAddress(to);
  const amtValid = !Number.isNaN(amt) && amt > 0;
  // Fee actually reserved for validation/Max: the worst automatic case, or the
  // user's custom fee when it's higher (a custom fee below the network minimum
  // gets raised server-side, so we still reserve the worst case then).
  const feeCustom = parseAmount(customFee);
  const feeCustomSet = !Number.isNaN(feeCustom) && feeCustom > 0;
  const feeReserve = feeCustomSet ? Math.max(feeCustom, FEE_MAX_FC) : FEE_MAX_FC;
  const overspend = amtValid && amt + feeReserve > spendable + 1e-9;
  // The maturing balance would cover it — the shortfall is just not-yet-matured funds.
  const blockedByMaturing = overspend && amtValid && amt + feeReserve <= spendable + maturing + 1e-9;
  // The send is possible only once the wallet is synced (spends need a matured anchor).
  // The same predicate every other spend control uses. Reading `synced` here let the
  // button stay enabled in the one state where the daemon refuses the payment.
  const canProceed =
    addrOk && amtValid && !overspend && walletCanSpend({ online: !!status, synced: !!status?.synced, spendReady: status?.spend_ready });

  const setMax = () => {
    const max = Math.max(0, spendable - feeReserve);
    setAmount(max > 0 ? String(Number(max.toFixed(8))) : "0");
  };

  const doSend = async (allowMultipleTransactions = false) => {
    // Rows for one payment: ONE ROW PER TRANSACTION (see the recording comment
    // below), all stamped with the payment's shared preFc and a payId, so
    // `reconcile` releases their subtractions CUMULATIVELY — the first chunk's
    // balance drop must not release every chunk's subtraction at once.
    const buildRows = (parts: SendPart[], toAddr: string): Omit<LocalTx, "pending">[] => {
      const now = Date.now();
      // `preFc` is the pre-send balance the optimistic subtraction is measured
      // against, so it belongs to the payment as a whole, not to each part.
      const pre = reliablePreFc(status);
      const payId = `pay_${now.toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
      return parts.map((p) => {
        const partAmt = p.amount_sompi / 1e8;
        const partFee = p.fee_sompi / 1e8;
        return {
          txid: p.txid,
          to: toAddr,
          amountFc: partAmt,
          feeFc: partFee,
          ts: now,
          preFc: pre,
          spentFc: partAmt + partFee,
          payId,
        };
      });
    };
    setBusy(true);
    setError("");
    try {
      // Signed on-device; the seed resolves silently from this device's storage.
      // Only a wallet restored on a NEW device has to be unlocked once.
      let seed: string;
      try {
        seed = await resolveDeviceSeed(status?.address ?? undefined);
      } catch (e) {
        if ((e as Error).message === SEED_REQUIRED) {
          if (!/^[0-9a-fA-F]{64}$/.test(unlock.trim())) {
            setNeedSeed(true);
            setConfirming(false);
            setError("This device doesn't hold this wallet's key yet. Enter your recovery seed once to unlock sending here.");
            return;
          }
          seed = unlock.trim();
          // Verify the seed actually belongs to THIS wallet before keeping it.
          // A user with several wallets WILL paste the wrong one eventually —
          // and without this check the payment below is driven by the pasted
          // seed's FVK, i.e. it would spend FROM THAT OTHER WALLET while the UI
          // showed this one. The on-device address derivation costs nothing.
          if (status?.address) {
            const seedAddr = await addressFromSeed(seed, networkOf(status));
            if (seedAddr !== status.address) {
              setConfirming(false);
              setError(
                "That seed belongs to a different wallet — it does not unlock this one. Check which wallet you are restoring, or switch to the wallet that seed belongs to.",
              );
              return;
            }
          }
          setDeviceSeed(seed);
          setUnlock("");
          setNeedSeed(false);
        } else {
          throw e;
        }
      }
      const feeSompi = feeCustomSet ? Math.round(feeCustom * 1e8) : undefined;
      const sendStartedAt = Date.now();
      const r = await sendNonCustodial(
        seed.trim(),
        networkOf(status),
        to.trim(),
        amt,
        feeSompi,
        onStage,
        memo,
        allowMultipleTransactions,
      );
      // Remember how long that actually took, scaled by the notes it spent, so the
      // NEXT send can count down instead of only counting up. Recorded on success
      // only: a run that failed part-way measures the failure, not the work.
      const spent = r.parts?.length ? r.parts.length : 1;
      recordDuration("prepare", activeToken() ?? "default", Math.max(1, spent), Date.now() - sendStartedAt);
      const toAddr = to.trim();
      setTo("");
      setAmount("");
      setMemo("");
      setConfirming(false);
      setFragmented(false);
      // Record on-device so the balance drops to a 0-conf figure immediately;
      // onSent switches straight to History where the confirmations tick in live.
      // The daemon reports the fee it actually charged (byte-proportional) —
      // record that, not the UI's estimate.
      const paidFeeFc = (r.fee_sompi ?? FEE_FC * 1e8) / 1e8;
      // The one moment the user certainly knows who they just paid — ask now,
      // not in an address book they will never open.
      if (!findContact(toAddr)) setSaveAddr(toAddr);
      // Record ONE ROW PER TRANSACTION. A payment whose notes don't fit a single
      // transaction is broadcast as several, and filing the whole amount under the
      // first txid was wrong twice over: the row claimed a transaction had paid far
      // more than it did, and the remaining transactions went unrecorded entirely —
      // invisible on a device with chain history off. It also made the payment
      // disappear, since the first txid landing on-chain retired a row standing in
      // for all of them.
      const parts = r.parts?.length
        ? r.parts
        : [{ txid: r.txid, amount_sompi: Math.round(amt * 1e8), fee_sompi: Math.round(paidFeeFc * 1e8) }];
      onSent(buildRows(parts, toAddr));
    } catch (e) {
      // A PartialSendError means ≥1 chunk was ALREADY broadcast — real money in
      // flight. Record those rows (History + optimistic balance) BEFORE showing
      // the error, or the balance keeps displaying funds that already left and
      // invites a double-send. `stay` keeps this screen mounted so the error —
      // and how much actually went — stays visible.
      if (e instanceof FragmentedWalletError) {
        // Atomic default: prepare refused before a signature or broadcast. Keep
        // the confirmation visible and let the user choose consolidation or an
        // explicitly non-atomic multi-transaction payment.
        setFragmented(true);
        setError(`${e.message} Nothing was signed or sent.`);
        setConfirming(true);
      } else if (e instanceof PartialSendError && e.parts.length > 0) {
        onSent(buildRows(e.parts, to.trim()), { stay: true });
        setError(`${(e as Error).message} The part already broadcast is recorded in History.`);
        setConfirming(false);
      } else {
        setError((e as Error).message);
        setConfirming(false);
      }
    } finally {
      setBusy(false);
      setStage(null);
      setSendProgress(null);
    }
  };

  // Confirmation step — show exactly what will happen before the proof is built.
  // (No separate success screen: a completed send jumps straight to History,
  // where the new row's confirmations update live.)
  if (confirming) {
    return (
      <div className="card">
        <h2>Confirm</h2>
        <div className="confirm-row">
          <span className="muted">Amount</span>
          <span className="mono">{trimFc(amount)} ZKAS</span>
        </div>
        <div className="confirm-row">
          <span className="muted">Network fee</span>
          <span className="mono">
            {feeCustomSet ? `${feeCustom} ZKAS (custom)` : `${FEE_FC}–${FEE_MAX_FC} ZKAS`}
          </span>
        </div>
        <div className="confirm-row total">
          <span>Total</span>
          <span className="mono">
            {feeCustomSet ? Number((amt + feeCustom).toFixed(8)) : `≤ ${Number((amt + FEE_MAX_FC).toFixed(8))}`} ZKAS
          </span>
        </div>
        {/* Normal payments are atomic at the transaction boundary. If this many
            notes cannot fit, prepare stops before signing and offers a choice. */}
        {(status?.note_count ?? 0) > MAX_NOTES_PER_TX && !feeCustomSet && (
          <div className="muted small" style={{ marginTop: 2 }}>
            Your balance sits in {status!.note_count} notes. If this amount cannot fit in one transaction, nothing is
            sent and the wallet will offer consolidation or an explicit split payment.
          </div>
        )}
        <label>To</label>
        {contact && (
          <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 6 }}>
            <div className="avatar" style={{ width: 30, height: 30, fontSize: 12 }}>
              {initials(contact.name)}
            </div>
            <b>{contact.name}</b>
          </div>
        )}
        <div className="addr">{to.trim()}</div>
        {memo.trim() && (
          <>
            <label>Private note</label>
            <div className="msg small" style={{ background: "transparent", border: "1px solid var(--border)" }}>
              “{memo.trim()}” — sealed in the recipient's encrypted note; only they can read it.
            </div>
          </>
        )}
        {needSeed && (
          <>
            <label>Recovery seed (unlocks signing on this device — stored only here)</label>
            <textarea value={unlock} onChange={(e) => setUnlock(e.target.value)} placeholder="64 hex characters" />
          </>
        )}
        {busy ? (
          <SendScene stage={stage ?? undefined} estimateMs={sendEstimateMs} />
        ) : status?.warming ? (
          <div className="msg warn small">
            <b>⚡ This first payment will take a few minutes</b> — the wallet has to locate your coins in the chain
            before it can spend them. It only does this once; later payments take seconds.
          </div>
        ) : (
          <div className="msg ok small">
            Verified and signed <b>on your device</b>, then broadcast. Usually takes <b>a few seconds</b>.
          </div>
        )}
        {error && <div className="msg err">{error}</div>}
        {fragmented && (
          <div className="msg warn small">
            <b>Choose safely:</b> consolidation is recommended. “Send in parts” broadcasts independent transactions;
            accepted parts cannot be automatically reversed if a later part fails.
          </div>
        )}
        <div className="row send-confirm-actions">
          <button className="btn ghost" disabled={busy} onClick={() => { setConfirming(false); setError(""); }}>
            Back
          </button>
          {fragmented && (
            <button className="btn" disabled={busy} onClick={() => setShowConsolidate(true)}>
              Consolidate first
            </button>
          )}
          <button className={fragmented ? "btn ghost" : "btn"} disabled={busy} onClick={() => void doSend(fragmented)}>
            {busy ? (
              <>
                <span className="spin" />{" "}
                {stage === "signing"
                  ? "Signing on device…"
                  : stage === "broadcasting"
                    ? "Broadcasting…"
                    : "Building private proof…"}
                {/* A multi-transaction payment can run for minutes; without the part
                    counter a healthy send is indistinguishable from a hung one. */}
                {sendProgress && sendProgress.parts > 1 && ` (${sendProgress.part} of ${sendProgress.parts})`}
              </>
            ) : (
              fragmented ? "Send in parts anyway" : "Confirm & send"
            )}
          </button>
        </div>
        {showConsolidate && status && (
          <ConsolidateDialog
            status={status}
            onClose={() => setShowConsolidate(false)}
            onDone={() => {
              setShowConsolidate(false);
              setFragmented(false);
              setConfirming(false);
              setError("");
              toast.show("good", "Consolidation sent", "Wait for the new note to mature, then retry the full payment.");
            }}
          />
        )}
        {busy && sendProgress && sendProgress.parts > 1 && (
          <p className="muted small" style={{ marginTop: 8 }}>
            Your balance is spread across many small notes, so this payment is being sent as{" "}
            {sendProgress.parts} transactions — {trimFc(sendProgress.sentFc.toFixed(8))} of{" "}
            {trimFc(sendProgress.totalFc.toFixed(8))} ZKAS confirmed so far. Keep this page open until it finishes.
          </p>
        )}
      </div>
    );
  }

  return (
    <div className="card">
      <div className="sendhead">
        <h2 style={{ margin: 0 }}>Send</h2>
        <span className="muted small">{trimFc(spendable.toFixed(8))} spendable</span>
      </div>

      <label>Recipient shielded address</label>
      <div className="inputwrap">
        <input
          ref={toRef}
          value={to}
          onChange={(e) => setTo(e.target.value)}
          placeholder="zkas:…"
          className="mono"
          autoCapitalize="off"
          autoCorrect="off"
          spellCheck={false}
          style={to && !addrOk ? { borderColor: "var(--bad)" } : addrOk ? { borderColor: "var(--good)" } : undefined}
        />
        <button type="button" className="inlinebtn" aria-label="Scan QR" onClick={() => setScanning(true)}>
          Scan
        </button>
        <button
          type="button"
          className="inlinebtn"
          onClick={async () => {
            const r = await pasteText();
            if (r.ok) {
              applyRequest(r.text);
              return;
            }
            // Never fail silently. Focusing the field is the useful part: the OS
            // paste gesture always works even where programmatic read does not, so
            // put the cursor where they need it and tell them to use it.
            toRef.current?.focus();
            if (r.reason === "empty") {
              toast.show("info", "Clipboard is empty", "Copy the address first, then tap Paste.");
            } else {
              toast.show(
                "bad",
                "This browser won't share the clipboard",
                "Press and hold the address field, then choose Paste.",
              );
            }
          }}
        >
          Paste
        </button>
      </div>
      {to && !addrOk && <div className="fieldhint bad">That doesn't look like a zkas: address.</div>}
      {contact && (
        <div className="fieldhint" style={{ color: "var(--good)" }}>
          Paying <b>{contact.name}</b> from your contacts.
        </div>
      )}
      {isSelf && (
        <div className="fieldhint" style={{ color: "var(--ember)" }}>
          That's your own address. The payment works — it just returns to you, minus the fee.
        </div>
      )}
      <div style={{ display: "flex", gap: 12, marginTop: 6 }}>
        <button type="button" className="linkbtn" onClick={() => setPickContact(true)}>
          Choose a contact
        </button>
        {addrOk && !contact && (
          <button type="button" className="linkbtn" onClick={() => setSaveAddr(to.trim())}>
            Save as contact
          </button>
        )}
      </div>
      {pickContact && (
        <ContactPicker
          onPick={(c) => {
            setTo(c.address);
            setPickContact(false);
          }}
          onClose={() => setPickContact(false)}
        />
      )}
      {saveAddr && (
        <SaveContactDialog
          address={saveAddr}
          initialName={suggestedName ?? undefined}
          onClose={() => {
            setSaveAddr(null);
            setSuggestedName(null);
          }}
        />
      )}
      {scanning && <QrScanner onResult={onScan} onClose={() => setScanning(false)} />}

      <div className="amthead">
        <label style={{ margin: 0 }}>Amount (ZKAS)</label>
        <button type="button" className="linkbtn" onClick={setMax}>
          Max
        </button>
      </div>
      <input
        value={amount}
        onChange={(e) => setAmount(sanitizeAmountInput(e.target.value))}
        placeholder="0.00"
        inputMode="decimal"
        style={overspend ? { borderColor: "var(--bad)" } : undefined}
      />

      {/* The fee control used to be a bare gear glyph in a 13px zero-padding link
          button: no label, a tap target a third of the 44px minimum, and clicking it
          revealed the fee field further down the form PAST the memo field — so the
          control and the thing it controlled were nowhere near each other. Reported as:
          users do not understand they have to click it to set the fee.
          It now says what it is, shows the current value, is a real touch target, and
          opens the field directly beneath itself. */}
      <button
        type="button"
        className="feerow"
        aria-expanded={showFeeCfg}
        aria-controls="fee-config"
        onClick={() => setShowFeeCfg(!showFeeCfg)}
      >
        <span className="feerow-label">Network fee</span>
        <span className="feerow-value">
          {feeCustomSet ? `${feeCustom} ZKAS` : "Automatic"}
          <span className={"feerow-chev" + (showFeeCfg ? " open" : "")} aria-hidden="true" />
        </span>
      </button>
      {showFeeCfg && (
        <div id="fee-config">
          <input
            value={customFee}
            onChange={(e) => setCustomFee(e.target.value.replace(/[^0-9.]/g, ""))}
            placeholder={`Automatic (${FEE_FC}–${FEE_MAX_FC})`}
            inputMode="decimal"
            autoFocus
          />
          <div className="fieldhint muted">
            Leave this empty and the wallet picks the fee for you. Set a higher one only if a payment came back with a
            fee error — anything below the network minimum is raised automatically, so this cannot break a payment.
          </div>
        </div>
      )}

      <label>Private note (optional)</label>
      <input
        value={memo}
        onChange={(e) => setMemo(e.target.value.slice(0, 400))}
        placeholder="What is this payment for?"
        maxLength={400}
      />
      <div className="fieldhint">
        Sealed inside the recipient's encrypted note — only they can read it. Never appears on-chain or on the explorer.
      </div>
      {overspend && blockedByMaturing && (
        <div className="fieldhint bad">
          Only {trimFc(spendable.toFixed(8))} is ready to spend right now — {trimFc(maturing.toFixed(8))} is still
          arriving. Coins become spendable about 10 minutes after they land, including the change from a payment you
          just made. It'll be ready shortly.
        </div>
      )}
      {overspend && !blockedByMaturing && (
        <div className="fieldhint bad">
          Not enough funds: {trimFc(spendable.toFixed(8))} spendable, need {trimFc((amt + FEE_MAX_FC).toFixed(8))} incl. up
          to {FEE_MAX_FC} fee.
        </div>
      )}
      {amtValid && !overspend && (
        <div className="fieldhint muted">
          + {FEE_FC}–{FEE_MAX_FC} fee (scales with how many coins get combined) = up to{" "}
          {Number((amt + FEE_MAX_FC).toFixed(8))} total
        </div>
      )}

      {!walletCanSpend({ online: !!status, synced: !!status?.synced, spendReady: status?.spend_ready }) && (
        <div className="msg warn small">
          Still catching up with the chain — you can pay once it finishes, so the wallet knows about all your coins.
        </div>
      )}
      {status?.synced && status?.warming && (
        <div className="msg warn warmbanner">
          <b>⚡ Your first payment will take a few minutes.</b>
          <br />
          The wallet is locating your coins in the chain — it does this once, then payments take seconds. You can
          start the payment now; just leave the screen open.
        </div>
      )}
      {error && <div className="msg err">{error}</div>}

      <button className="btn" disabled={!canProceed} onClick={() => { setError(""); setConfirming(true); }}>
        Review send
      </button>
    </div>
  );
}

function Sign({ status, embedded }: { status: Status | null; embedded?: boolean }) {
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [result, setResult] = useState<{ address: string; signature: string } | null>(null);

  // Signed on-device too: the daemon holds no spend/sign authority for a
  // non-custodial wallet, and message signatures prove control of the address.
  const submit = async () => {
    setBusy(true);
    setError("");
    setResult(null);
    try {
      const seed = await resolveDeviceSeed(status?.address ?? undefined);
      const net: Network = status?.network === "mainnet" ? "mainnet" : "testnet";
      const r = await signLocal(seed, net, message);
      setResult({ address: r.address, signature: r.signatureHex });
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className={embedded ? "" : "card"}>
      {!embedded && <h2>Sign message</h2>}
      <p className="muted small" style={{ marginTop: 0 }}>
        Prove you control this wallet's address without spending. The signature discloses your viewing key (enables
        note detection, never spend authority).
      </p>
      <label>Message</label>
      <textarea value={message} onChange={(e) => setMessage(e.target.value)} placeholder="Message to sign…" />
      {error && <div className="msg err">{error}</div>}
      {result && (
        <>
          <label>Address</label>
          <div className="addr">{result.address}</div>
          <label>Signature (fvk‖sig, hex)</label>
          <div className="addr" style={{ maxHeight: 120, overflow: "auto" }}>
            {result.signature}
          </div>
          <button
            className="btn ghost small"
            style={{ marginTop: 12 }}
            onClick={() => copyText(result.signature)}
          >
            Copy signature
          </button>
        </>
      )}
      <button className="btn" disabled={busy || !message} onClick={submit}>
        {busy ? <span className="spin" /> : "Sign"}
      </button>
    </div>
  );
}

function Verify({ embedded }: { embedded?: boolean }) {
  const [address, setAddress] = useState("");
  const [message, setMessage] = useState("");
  const [signature, setSignature] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [result, setResult] = useState<{ valid: boolean; reason: string | null } | null>(null);

  const submit = async () => {
    setBusy(true);
    setError("");
    setResult(null);
    try {
      const valid = await verifyLocal(address.trim(), message, signature.trim());
      setResult({ valid, reason: valid ? null : "signature does not verify for this address/message" });
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className={embedded ? "" : "card"}>
      {!embedded && <h2>Verify message</h2>}
      <p className="muted small" style={{ marginTop: 0 }}>
        Runs entirely in your browser — no server involved.
      </p>
      <label>Signer's address</label>
      <input value={address} onChange={(e) => setAddress(e.target.value)} placeholder="zkas:…" className="mono" />
      <label>Message</label>
      <textarea value={message} onChange={(e) => setMessage(e.target.value)} placeholder="The signed message…" />
      <label>Signature (hex)</label>
      <textarea value={signature} onChange={(e) => setSignature(e.target.value)} placeholder="fvk‖sig hex…" />
      {error && <div className="msg err">{error}</div>}
      {result && (
        <div className={"msg " + (result.valid ? "ok" : "err")}>
          {result.valid ? "✓ VALID — the signer controls this address." : `✗ INVALID — ${result.reason}`}
        </div>
      )}
      <button className="btn" disabled={busy || !address || !signature} onClick={submit}>
        {busy ? <span className="spin" /> : "Verify"}
      </button>
    </div>
  );
}

function shortAddr(a: string): string {
  const body = a.replace(/^(zkas|firecash)(test)?:/, "");
  return body.length > 20 ? `${a.slice(0, 16)}…${a.slice(-6)}` : a;
}

function fmtTime(ms: number): string {
  return new Date(ms).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

// On-device history of sends made from this device. The daemon keeps no per-wallet
// history, so this is the record; each row links to the tx on the explorer.
// A just-broadcast send lands here directly (no separate success screen) with a
// success banner and a highlighted row whose confirmation count ticks up live.
function History({
  txs,
  receipts,
  justSent,
  onSendAnother,
  synced,
}: {
  txs: LocalTx[];
  /// Arrivals this device noticed, shown only in the on-device scope: with full
  /// recovery on, the chain itself reports receives and these would double up.
  receipts?: Receipt[];
  justSent?: string | null;
  onSendAnother?: (prefillAddress?: string) => void;
  synced?: boolean;
}) {
  // Chain-derived history (mints, receives, and OVK-recovered sends): fetched
  // from the daemon, so it survives a seed restore and shows on every device.
  const toast = useToast();
  const [chain, setChain] = useState<ChainHistory | null>(null);
  const [busy, setBusy] = useState(false);
  // True from the moment history is enabled until the recovery scan finishes —
  // so the tab explains the wait instead of looking empty and broken.
  const [recovering, setRecovering] = useState(false);
  const [askRecover, setAskRecover] = useState(false);
  const [askDisable, setAskDisable] = useState(false);
  const [err, setErr] = useState("");
  const [detail, setDetail] = useState<(ChainHistoryRow & { confs?: number }) | null>(null);
  const [q, setQ] = useState("");
  const [kindFilter, setKindFilter] = useState<"all" | "received" | "sent" | "coinbase">("all");
  const [, setLabelRevision] = useState(0);
  // Long histories render windowed — a miner wallet accrues thousands of rows
  // and a multi-thousand-button list makes the tab unusable.
  const [showAll, setShowAll] = useState(false);
  // Set while the recovery scan is genuinely in flight. Enabling history starts a
  // rescan, but the daemon takes a moment to report itself unsynced — so `synced` was
  // still TRUE on the very next render and the tab declared recovery finished
  // immediately, showing an empty history as if it were complete. That is the reported
  // "enabled history, received coins not there": the rows arrived seconds later and
  // nothing was watching for them any more.
  const sawUnsynced = useRef(false);
  useEffect(() => {
    if (!recovering) {
      sawUnsynced.current = false;
      return;
    }
    if (!synced) sawUnsynced.current = true;
    // Finished when rows actually arrived, or when a scan that we WATCHED START has
    // completed. A wallet with no recoverable history legitimately produces zero rows,
    // so rows alone cannot be the only exit.
    if ((chain?.rows.length ?? 0) > 0 || (synced && sawUnsynced.current)) setRecovering(false);
  }, [recovering, chain, synced]);
  useEffect(() => {
    let live = true;
    const pull = () => api.history().then((h) => live && setChain(h)).catch(() => {});
    pull();
    // 15s is fine for a settled wallet, but a recovery scan writes rows continuously
    // for minutes — at that cadence the tab sat empty long enough to look broken. Poll
    // hard while recovering, idle otherwise.
    const t = setInterval(pull, recovering ? 2_000 : 15_000);
    return () => {
      live = false;
      clearInterval(t);
    };
  }, [recovering]);

  // History is opt-in: nothing readable is stored until the user activates it,
  // and turning it off erases the stored record immediately.
  //
  // Enabling also kicks off a rescan. Rows are only written as blocks are
  // scanned, so without it "Enable history" leaves the tab empty until the next
  // payment arrives — the flag looks broken. The rescan re-reads the chain from
  // the wallet's birthday and recovers everything the keys can still derive.
  const setHistory = async (on: boolean, birthday?: number) => {
    setAskDisable(false);
    setErr("");
    setBusy(true);
    try {
      await api.setHistoryEnabled(on);
      if (on) {
        // Genesis unless the user told us when this wallet started. A full replay is
        // millions of leaves; starting at a remembered date skips the years the
        // wallet did not exist for.
        await api.rescan(birthday);
        // Mark recovery BEFORE the fetch below. The rescan is asynchronous on the
        // daemon, so that fetch returns the pre-rescan (empty) history — which is
        // correct to display, but only if the tab knows more is coming. The 2s poll
        // above then fills it in.
        setRecovering(true);
      }
      setChain(await api.history());
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const fresh = justSent ? txs.find((t) => t.txid === justSent) : undefined;
  const allRows = chain?.rows ?? [];
  // Search covers what a person actually remembers about a payment: who, what it
  // was for, and roughly how much — not the txid they never read.
  const needle = q.trim().toLowerCase();
  const chainRows = allRows.filter((r) => {
    if (kindFilter !== "all" && r.kind !== kindFilter) return false;
    if (!needle) return true;
    const who = r.recipient ? `${displayName(r.recipient, "")} ${r.recipient}` : "";
    return (
      who.toLowerCase().includes(needle) ||
      (r.memo ?? "").toLowerCase().includes(needle) ||
      getTxLabel(r.txid).toLowerCase().includes(needle) ||
      r.amountZkas.toFixed(8).includes(needle) ||
      r.txid.toLowerCase().includes(needle)
    );
  });
  // Device-local sends the chain scan hasn't caught up to yet stay on top as
  // 0-conf rows; once the chain reports the same transaction AS A SEND, the chain
  // row is authoritative and the device row steps aside. See `visibleDeviceRows`
  // for why a bare txid match was wrong. Dedupe against ALL chain rows, never the
  // filtered view, or an active filter hides the chain row while still suppressing
  // the device row and the payment disappears from both lists.
  const notYetOnChain = visibleDeviceRows(txs, allRows);
  // These are always SENDS, so they must honour the same filter and search the
  // chain rows do — otherwise a send shows up under "Received".
  const pending = notYetOnChain.filter((t) => {
    if (kindFilter !== "all" && kindFilter !== "sent") return false;
    if (!needle) return true;
    const who = `${displayName(t.to, "")} ${t.to}`.toLowerCase();
    return who.includes(needle) || getTxLabel(t.txid).toLowerCase().includes(needle) || t.amountFc.toFixed(8).includes(needle) || t.txid.toLowerCase().includes(needle);
  });
  const historyOff = chain !== null && !chain.recoverableHistory;
  // Arrivals belong to the on-device scope only. With full recovery on, the chain
  // reports receives itself and these would list the same payment twice.
  const shownReceipts = useMemo(() => {
    if (!historyOff) return [];
    const rows = receipts ?? [];
    if (kindFilter !== "all" && kindFilter !== "received") return [];
    if (!q.trim()) return rows;
    const needle = q.trim().toLowerCase();
    return rows.filter((r) => r.amountFc.toFixed(8).includes(needle) || "received".includes(needle));
  }, [historyOff, receipts, kindFilter, q]);
  const deviceCount = txs.length + (historyOff ? (receipts?.length ?? 0) : 0);
  // Sends this device recorded itself (localtx, in this browser/app's storage).
  // These exist and are readable with chain history OFF — they never left the
  // device. Chain-recovered history is the separate, permissioned thing.
  // Everything this DEVICE recorded itself, not just what is still unconfirmed.
  //
  // This counted only `pending` — sends not yet seen on chain — so the moment a send
  // confirmed it vanished from a history-off wallet and the tab reverted to the
  // "turn history on" wall of text, as if the device had never known about it. It did:
  // localtx rows live in this app's own storage and are readable with chain history
  // off, because they never left the device.
  const deviceRows = txs.filter((t) => {
    if (kindFilter !== "all" && kindFilter !== "sent") return false;
    if (!needle) return true;
    const who = `${displayName(t.to, "")} ${t.to}`.toLowerCase();
    return who.includes(needle) || getTxLabel(t.txid).toLowerCase().includes(needle) || t.amountFc.toFixed(8).includes(needle) || t.txid.toLowerCase().includes(needle);
  });

  // Notes locked by sends still awaiting chain confirmation. Their value includes
  // the change coming back, so this is shown as "held", never as an amount sent —
  // and the daemon returns it all automatically if a transaction never lands.
  const heldZkas = (chain?.pendingOutgoing ?? []).reduce((s, p) => s + p.amountZkas, 0);
  const heldTxids = new Set((chain?.pendingOutgoing ?? []).map((p) => p.txid)).size;

  if (!historyOff && pending.length === 0 && chainRows.length === 0) {
    return (
      <div className="card">
        <h2>History</h2>
        {chain === null && (
          <div style={{ display: "grid", gap: 10 }}>
            {[0, 1, 2].map((i) => (
              <div key={i} className="skel" style={{ height: 46 }} />
            ))}
          </div>
        )}
        <p className="muted small" style={{ marginTop: 0 }}>
          {chain === null
            ? ""
            : recovering
              ? "Recovering your history from the chain — this takes a minute or two. Rows appear here as the scan catches up; you can leave this tab."
              : "Nothing yet. Mints, payments you receive, and sends from this wallet all show up here — recovered from the chain itself, so this list follows your seed, not this device."}
        </p>
        {chain !== null && (
          <button className="btn ghost small" onClick={() => setAskDisable(true)} disabled={busy}>
            Turn history off
          </button>
        )}
      </div>
    );
  }
  return (
    <div className="card">
      <div className="history-heading">
        <h2>History</h2>
        {historyOff && (
          <button className="btn ghost small" onClick={() => setAskRecover(true)} disabled={busy}>
            {busy ? "Starting…" : "Recover full history"}
          </button>
        )}
      </div>
      {historyOff && (
        <div className="history-scope">
          <b>On this device</b>
          <span>{deviceCount === 0 ? "No saved payments" : `${deviceCount} saved payment${deviceCount === 1 ? "" : "s"}`}</span>
        </div>
      )}
      {fresh && (
        <div className="sentbanner appear">
          <span className="sent-check small">✓</span>
          <div>
            <b>Sent privately.</b> Watch it confirm below — this updates live.
          </div>
          {/* Explicit arrow, not the bare handler: passing it directly would hand
              the click event in as the "prefill address" argument. */}
          {onSendAnother && (
            <button className="btn ghost small" style={{ flex: "none" }} onClick={() => onSendAnother()}>
              Send another
            </button>
          )}
        </div>
      )}
      {(historyOff ? txs.length : allRows.length) > 3 && (
        <div className="filterbar">
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search name, note or amount" />
          {(["all", "received", "sent", "coinbase"] as const).map((k) => (
            <button key={k} className={"chip" + (kindFilter === k ? " on" : "")} onClick={() => setKindFilter(k)}>
              {k === "all" ? "All" : k === "coinbase" ? "Mined" : k === "sent" ? "Sent" : "Received"}
            </button>
          ))}
        </div>
      )}
      {allRows.length > 0 && chainRows.length === 0 && (
        <p className="muted small">Nothing matches that filter.</p>
      )}
      <div className="txlist">
        {/* Every send this device recorded, not only the unconfirmed ones. A confirmed
            send used to disappear from a history-off wallet entirely — the device knew
            about it the whole time. Chain-recovered rows are listed separately below,
            and `notYetOnChain` keeps the two from showing the same payment twice. */}
          {historyOff && shownReceipts.map((r) => (
            <div key={`rcpt-${r.ts}`} className="txrow" aria-label="Received">
              <span className="txkind in">Received</span>
              <span className="txamt in">+{trimFc(r.amountFc.toFixed(8))} ZKAS</span>
              {/* An arrival is INFERRED from the balance moving, so this knows the
                  amount and roughly when and nothing else. No txid, and no sender —
                  unknowable for a shielded payment by design. Saying so is the point:
                  the alternative is dressing a local observation up as a chain record. */}
              <span className="muted small">
                {r.whileAway ? "Noticed when you opened the app" : "Seen arriving"} · {new Date(r.ts).toLocaleString()}
              </span>
            </div>
          ))}
          {(historyOff ? deviceRows : pending).map((t) => (
          <button
            key={t.txid}
            type="button"
            className={"txrow" + (t.txid === justSent ? " fresh" : "")}
            style={{ textAlign: "left", width: "100%", font: "inherit", color: "inherit" }}
            onClick={() => setDetail(localTxToRow(t))}
          >
            <div className="txrow-main">
              <span className="txrow-amt">− {trimFc(t.amountFc.toFixed(8))} ZKAS</span>
              <span className={"txrow-badge " + ((t.confs ?? 0) >= 1 ? "done" : "pending")}>{confBadge(t)}</span>
            </div>
            <div className="txrow-sub">
              <span className="mono">to {shortAddr(t.to)}</span>
              <span>{fmtTime(t.ts)}</span>
            </div>
            {getTxLabel(t.txid) && <div className="txrow-label">{getTxLabel(t.txid)}</div>}
          </button>
        ))}
        {(showAll ? chainRows : chainRows.slice(0, HISTORY_PAGE)).map((r, ri) => (
          <button
            // Index included deliberately: one transaction can produce several rows of
            // the same kind (multiple notes received in one payment), and duplicate keys
            // make React reorder and remount rows — which is what made the list jump
            // around as the 15s poll replaced it.
            key={`${r.txid}:${r.kind}:${ri}`}
            type="button"
            className="txrow"
            style={{ textAlign: "left", width: "100%", font: "inherit", color: "inherit" }}
            onClick={() => setDetail(r)}
          >
            <div className="txrow-main">
              <span className="txrow-amt">
                {r.kind === "sent" ? "− " : "+ "}
                {trimFc(r.amountZkas.toFixed(8))} ZKAS
              </span>
              <span className={"txrow-badge " + (r.kind === "sent" ? "done" : "recv")}>
                {r.kind === "coinbase" ? "mined" : r.kind === "received" ? "received" : "sent"}
              </span>
            </div>
            <div className="txrow-sub">
              {r.kind === "sent" && r.recipient ? (
                <span className={findContact(r.recipient) ? "" : "mono"}>
                  to {displayName(r.recipient, shortAddr(r.recipient))}
                </span>
              ) : r.memo ? (
                <span className="memo">“{r.memo}”</span>
              ) : (
                <span className="mono">{shortAddr(r.txid)}</span>
              )}
              <span>{r.timestamp > 0 ? fmtTime(r.timestamp) : `DAA ${r.daaScore}`}</span>
            </div>
            {r.kind === "sent" && r.memo && (
              <div className="txrow-sub">
                <span className="memo">“{r.memo}”</span>
              </div>
            )}
            {getTxLabel(r.txid) && <div className="txrow-label">{getTxLabel(r.txid)}</div>}
          </button>
        ))}
        {historyOff && txs.length > 0 && deviceRows.length === 0 && (
          <div className="history-empty">
            Nothing matches that filter.
          </div>
        )}
      </div>
      {!showAll && chainRows.length > HISTORY_PAGE && (
        <button className="btn ghost small" onClick={() => setShowAll(true)}>
          Show all {chainRows.length} rows
        </button>
      )}
      {heldTxids > 0 && (
        <p className="muted small" style={{ marginTop: 14 }}>
          {heldTxids} outgoing transaction{heldTxids === 1 ? "" : "s"} in flight — {trimFc(heldZkas.toFixed(8))} ZKAS
          temporarily held until it confirms (returned automatically within ~1 hour if it never does).
        </p>
      )}
      {!historyOff && (
        <>
          <RescanButton label="Something missing?" hint="Re-read the chain to rebuild this history and recover any funds the local view lost." />

          <p className="muted small" style={{ marginTop: 14 }}>
            Recovered from the chain by your viewing key. Tap a payment for details.{" "}
            <a
              href="#"
              onClick={(e) => {
                e.preventDefault();
                setAskDisable(true);
              }}
            >
              Turn history off & erase
            </a>
          </p>
        </>
      )}
      {!historyOff && allRows.length > 0 && (
        <button
          className="btn ghost small"
          onClick={() => {
            // Built on-device: exporting your own records must not mean handing them
            // to a server.
            //
            // Goes through `exportFile` because the `<a download>` this used to do is a
            // silent no-op inside a Capacitor WebView and inside Tauri — the button
            // worked on the web and did nothing at all on the apps, with no error to
            // show for it. And it now SAYS what happened, so "nothing appeared" can
            // never again be indistinguishable from success.
            const name = `zkas-history-${new Date().toISOString().slice(0, 10)}.csv`;
            void (async () => {
              try {
                const how = await exportFile(name, "text/csv", historyCsv(allRows));
                toast.show("good", exportMessage(how, name));
              } catch {
                toast.show("bad", "Could not export the CSV on this device.");
              }
            })();
          }}
        >
          Export CSV
        </button>
      )}
      {detail && (
        <TxDetail
          row={detail}
          onClose={() => setDetail(null)}
          onLabelSaved={() => setLabelRevision((value) => value + 1)}
          onSendAgain={(addr) => {
            setDetail(null);
            onSendAnother?.(addr);
          }}
        />
      )}
      {err && <div className="msg err">{err}</div>}
      {askRecover && (
        <RecoverHistoryDialog
          daaScore={loadStatusCache()?.daa_score ?? 0}
          onCancel={() => setAskRecover(false)}
          onConfirm={(birthday) => {
            setAskRecover(false);
            void setHistory(true, birthday);
          }}
        />
      )}
      {askDisable && (
        <ConfirmDialog
          title="Turn history off?"
          body="The stored transaction record is erased from this wallet immediately. Your balance and funds are not affected, and payments stay shielded on-chain either way."
          confirmLabel="Turn off & erase"
          danger
          onConfirm={() => setHistory(false)}
          onCancel={() => setAskDisable(false)}
        />
      )}
    </div>
  );
}

/// The daemon this wallet talks to. Always reachable — not just when the hosted
/// service is down — because pointing it at your own `zkas-walletd` is how you
/// stop trusting ours at all, and that has to be one tap away, at any time.
/// Which wallet service (and through it, which node) this app talks to — the
/// phone/web equivalent of the desktop node picker, and titled so people
/// looking for "connect to my own node" actually find it. The URL is PROBED
/// before it is saved: saving an unreachable one used to reload the app
/// straight into "can't reach the wallet service" — the same wrong-address trap
/// the desktop app had with custom nodes, just softer.
function DaemonSetting() {
  const [open, setOpen] = useState(false);
  const [base, setB] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [bearer, setBearer] = useState("");
  const current = getBase();
  const own = current.includes("127.0.0.1") || current.includes("localhost") || !current.includes("wallet.zkas.info");

  // Accept a bare IP/host and fill in its platform-safe scheme plus :8501, so
  // "just paste your node's address" works. Empty resets to hosted default.
  const save = async (raw: string, accessToken = bearer) => {
    setBusy(true);
    setError("");
    let url = normalizeDaemonInput(raw);
    try {
      if (url) {
        // A bare LAN address is tested over both HTTP and HTTPS. Save only the
        // transport whose authenticated status endpoint really answered.
        url = await findReachableDaemon(raw, accessToken);
      }
      setBase(url);
      setWalletdBearer(url ? accessToken : "");
      location.reload();
    } catch (e) {
      const detail = (e as Error).name === "AbortError" ? "timed out after 5s" : (e as Error).message;
      setError(
        `Couldn't reach a wallet service at ${url} (${detail}). Make sure zkas-walletd is running there and the ` +
          `port is open. Nothing was changed — still using ${current}.`,
      );
      setBusy(false);
    }
  };

  return (
    <div className="card">
      <h2 style={{ margin: 0 }}>
        <button
          className="btn ghost small daemon-btn"
          style={{ width: "100%", justifyContent: "space-between", textTransform: "none", letterSpacing: 0 }}
          onClick={() => setOpen(!open)}
        >
          <span className="daemon-url">Connect to your own node</span>
          <span className="muted daemon-mode">{own ? "your own ✓" : "hosted"} {open ? "▲" : "▼"}</span>
        </button>
      </h2>
      {open && (
        <>
          <p className="muted small" style={{ marginTop: 14 }}>
            Your seed always signs on this device. But the hosted service still sees your <b>viewing key</b> — it can
            watch your balance and history. To keep even that private, run <code>zkas-walletd</code> on your own node
            and connect this wallet straight to it.
          </p>
          <p className="muted small">
            Just enter your node's <b>IP address</b> — we add the rest. {isNative() ? "The installed app supports HTTPS and plain HTTP LAN connections." : "The web wallet requires HTTPS; use the installed app for plain HTTP on a LAN."} Currently using{" "}
            <span className="mono">{current}</span>.
          </p>
          {error && <div className="msg err">{error}</div>}
          <label>{isNative() ? "Walletd IP address or hostname" : "HTTPS walletd URL"}</label>
          <div className="row">
            <input
              value={base}
              onChange={(e) => setB(e.target.value)}
              className="mono"
              placeholder={isNative() ? "192.168.1.20" : "https://wallet.example.com"}
              inputMode="url"
              autoCapitalize="none"
              autoCorrect="off"
              spellCheck={false}
            />
            <button className="btn small" style={{ flex: "0 0 auto" }} disabled={busy || !base.trim()} onClick={() => save(base)}>
              {busy ? <span className="spin" /> : "Connect"}
            </button>
          </div>
          <label style={{ marginTop: 10 }}>Access token <span className="muted">(if the host requires one)</span></label>
          <input
            type="password"
            value={bearer}
            onChange={(e) => setBearer(e.target.value)}
            className="mono"
            placeholder="64-character host access token"
            autoCapitalize="none"
            autoCorrect="off"
            spellCheck={false}
          />
          <p className="muted small" style={{ marginTop: 8, marginBottom: 0 }}>
            Uses port {DEFAULT_WALLETD_PORT} by default — add <span className="mono">:port</span> only if you changed it.
          </p>
          {!own && (
            <button className="btn ghost small" style={{ marginTop: 12 }} disabled={busy} onClick={() => save("", "")}>
              Reset to hosted default
            </button>
          )}
        </>
      )}
    </div>
  );
}

/// Desktop only: which ZKas node the EMBEDDED wallet engine scans through.
/// The engine itself always runs in-app (seed never leaves this machine) —
/// this only picks where chain data comes from.
/// Lock the wallet without quitting the app, and nag a legacy cleartext wallet
/// into being encrypted. Locking stops the embedded daemon and drops the
/// passphrase, so what stays on disk cannot be spent.
function VaultSetting() {
  const [state, setState] = useState<string | null>(null);
  const [askLock, setAskLock] = useState(false);
  useEffect(() => {
    vaultStatus()
      .then((v) => setState(v.state))
      .catch(() => {});
  }, []);
  if (state === null) return null;

  // Watch-only wallets hold no spending key: nothing to encrypt, nothing to back
  // up. Every other state gets the backup option — including an unencrypted
  // wallet, whose seed is exactly the one most worth getting a copy of.
  const watchOnly = state === "watchonly";

  return (
    <div className="card">
      <h2>Security &amp; backup</h2>

      {state === "plaintext" && (
        <>
          <p className="muted small" style={{ marginTop: 0 }}>
            This wallet's seed is stored <b>unencrypted</b> on this computer — anyone who copies the file can spend your
            funds. Set a passphrase to encrypt it; your balance and history are untouched.
          </p>
          <button
            className="btn"
            onClick={() => {
              // Plaintext wallets boot straight into the app (they are usable and
              // we must not lock anyone out of their money), so ask for the setup
              // screen explicitly rather than relying on the boot check.
              sessionStorage.setItem("vault_setup", "1");
              location.reload();
            }}
          >
            Set a passphrase
          </button>
          <div style={{ height: 1, background: "var(--border)", margin: "18px 0" }} />
        </>
      )}

      {state === "encrypted" && (
        <>
          <p className="muted small" style={{ marginTop: 0 }}>
            Your seed is encrypted on this device. Locking stops the wallet daemon and forgets your passphrase until you
            enter it again — do this when you step away.
          </p>
          <button className="btn ghost" onClick={() => setAskLock(true)}>
            Lock wallet
          </button>
          <div style={{ height: 1, background: "var(--border)", margin: "18px 0" }} />
        </>
      )}

      {watchOnly ? <DeviceSeedBackup /> : <BackupWallet />}

      {askLock && (
        <ConfirmDialog
          title="Lock wallet?"
          body="The wallet daemon stops and your passphrase is forgotten. You will need it again to unlock. Your funds are not affected."
          confirmLabel="Lock"
          onConfirm={async () => {
            await lockVault().catch(() => {});
            location.reload();
          }}
          onCancel={() => setAskLock(false)}
        />
      )}
    </div>
  );
}

/// Turn the app lock on/off: a PIN (or passphrase) that ENCRYPTS this device's
/// spending key, rather than merely hiding the screen.
///
/// This is the phone's real protection: the seed lives in this app's storage, so
/// a lock that only hid the UI would leave it readable to anyone with the
/// device's data or a backup of it. Sealed, a locked app holds nothing spendable.
/// Android only: an opt-in periodic native wake (~every 15 min) that keeps the
/// daemon-side scan warm and posts a local notification when a payment lands
/// while the app is closed (see bgsync.ts). Off by default — a convenience worth
/// a little battery is the user's to choose, not ours to take.
function BackgroundSyncCard() {
  const [on, setOn] = useState(bgSyncEnabled());
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  if (!bgSyncAvailable()) return null;
  const toggle = async () => {
    setBusy(true);
    setErr("");
    try {
      if (on) {
        await bgSyncDisable();
        setOn(false);
      } else {
        await bgSyncEnable();
        setOn(true);
      }
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="card">
      <h2>Background sync</h2>
      <p className="muted small" style={{ marginTop: 0 }}>
        While on, the phone wakes briefly about every 15 minutes — even with the app closed — to keep your wallet
        caught up and to show a notification when a payment arrives. Off, the wallet catches up when you open the
        app. Light on battery; the seed stays on this device either way.
      </p>
      <button className={"btn small" + (on ? " ghost" : "")} disabled={busy} onClick={toggle}>
        {busy ? "…" : on ? "Turn background sync off" : "Turn background sync on"}
      </button>
      {on && (
        <p className="muted small" style={{ marginTop: 8 }}>
          On. Android may delay the wake when the battery is low — payments are never lost, the notification is
          simply later.
        </p>
      )}
      {err && <div className="msg err">{err}</div>}
    </div>
  );
}

function AppLockSetting() {
  const [enabled, setEnabled] = useState(isLockEnabled());
  const [kind, setKind] = useState<"pin" | "passphrase">("pin");
  const [secret, setSecret] = useState("");
  const [confirmSecret, setConfirmSecret] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [mode, setMode] = useState<"idle" | "enable" | "disable">("idle");

  // 6 digits, not 4: the seal is only as strong as what derives it, and a
  // 4-digit PIN is 10,000 guesses to anyone who copies the encrypted blob off
  // the device. Even 6 is a device-theft deterrent rather than real key
  // strength — which is why the UI says so and offers a passphrase.
  const minLen = kind === "pin" ? 6 : 8;

  const enable = async () => {
    setErr("");
    if (secret.length < minLen) return setErr(`Use at least ${minLen} ${kind === "pin" ? "digits" : "characters"}.`);
    if (secret !== confirmSecret) return setErr("The two entries do not match.");
    setBusy(true);
    try {
      // Seals EVERY wallet on this device, not just the active one.
      await enableLock(secret, kind);
      setEnabled(true);
      setMode("idle");
      setSecret("");
      setConfirmSecret("");
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const disable = async () => {
    setErr("");
    setBusy(true);
    try {
      if (!(await disableLock(secret))) {
        setErr("That passphrase does not unlock this device.");
        return;
      }
      setEnabled(false);
      setMode("idle");
      setSecret("");
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="card">
      <h2>App lock</h2>
      {mode === "enable" ? (
        <>
          <p className="muted small" style={{ marginTop: 0 }}>
            Choose what to unlock with. This encrypts the key of <b>every wallet</b> on this device and asks for it
            when the app opens — while locked, this device holds nothing that can spend any of them.
          </p>
          <div style={{ display: "flex", gap: 14, margin: "8px 0 4px" }}>
            <label className="choice" style={{ margin: 0 }}>
              <input type="radio" checked={kind === "pin"} onChange={() => setKind("pin")} /> <span>PIN</span>
            </label>
            <label className="choice" style={{ margin: 0 }}>
              <input type="radio" checked={kind === "passphrase"} onChange={() => setKind("passphrase")} />{" "}
              <span>Passphrase</span>
            </label>
          </div>
          <label>{kind === "pin" ? "PIN" : "Passphrase"}</label>
          <input
            type="password"
            inputMode={kind === "pin" ? "numeric" : "text"}
            value={secret}
            onChange={(e) => setSecret(e.target.value)}
            placeholder={kind === "pin" ? `At least ${minLen} digits` : `At least ${minLen} characters`}
          />
          <label>Confirm</label>
          <input
            type="password"
            inputMode={kind === "pin" ? "numeric" : "text"}
            value={confirmSecret}
            onChange={(e) => setConfirmSecret(e.target.value)}
            placeholder="Enter it again"
          />
          {err && <div className="msg err">{err}</div>}
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            <button className="btn" onClick={enable} disabled={busy || !secret}>
              {busy ? "Encrypting…" : "Turn on app lock"}
            </button>
            <button className="btn ghost" onClick={() => setMode("idle")} disabled={busy}>
              Cancel
            </button>
          </div>
          <p className="muted small" style={{ marginTop: 10 }}>
            Back up your wallet first. Nothing stores this {kind === "pin" ? "PIN" : "passphrase"}, so if you forget it
            the only way back in is your seed phrase or a backup file.
          </p>
          {kind === "pin" && (
            <p className="muted small">
              A PIN stops someone who picks up your phone. It is short enough to be guessed by anyone who copies the
              encrypted key off the device itself — choose a passphrase if that is your concern.
            </p>
          )}
        </>
      ) : mode === "disable" ? (
        <>
          <p className="muted small" style={{ marginTop: 0 }}>
            Enter your current {lockKind() === "pin" ? "PIN" : "passphrase"} to turn the lock off. Your key will be
            stored unencrypted on this device again.
          </p>
          <input
            type="password"
            inputMode={lockKind() === "pin" ? "numeric" : "text"}
            value={secret}
            onChange={(e) => setSecret(e.target.value)}
            placeholder={lockKind() === "pin" ? "Current PIN" : "Current passphrase"}
          />
          {err && <div className="msg err">{err}</div>}
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            <button className="btn ghost" onClick={disable} disabled={busy || !secret}>
              {busy ? "Removing…" : "Turn off app lock"}
            </button>
            <button className="btn ghost" onClick={() => setMode("idle")} disabled={busy}>
              Cancel
            </button>
          </div>
        </>
      ) : enabled ? (
        <>
          <p className="muted small" style={{ marginTop: 0 }}>
            <b>On.</b> Every wallet's key on this device is encrypted, and the app asks for your{" "}
            {lockKind() === "pin" ? "PIN" : "passphrase"} to open. It re-locks itself after a few minutes in the
            background.
          </p>
          <button className="btn ghost" onClick={() => setMode("disable")}>
            Turn off app lock
          </button>
        </>
      ) : (
        <>
          <p className="muted small" style={{ marginTop: 0 }}>
            Your wallet keys are stored on this device <b>unencrypted</b>. Turn on a PIN or passphrase and every one
            of them is encrypted at rest, and the app asks for it on open — so someone holding this device, or a
            backup of its data, cannot spend from it.
          </p>
          <button className="btn" onClick={() => setMode("enable")}>
            Set a PIN or passphrase
          </button>
        </>
      )}
    </div>
  );
}

/// Forget this device's wallet so the app offers onboarding again — create a new
/// one, restore a backup, or import a seed.
///
/// Exists because the wallet is remembered across launches (by design: nobody
/// wants to re-import every morning), which also means a user who wants a
/// DIFFERENT wallet has no way out — their old one is simply loaded again every
/// start. Guarded hard: without a backup or seed phrase, the funds in the
/// forgotten wallet are unreachable from this machine.
function SwitchWallet() {
  const [, bump] = useState(0);
  const [askRemove, setAskRemove] = useState<WalletRef | null>(null);
  const [renaming, setRenaming] = useState<WalletRef | null>(null);
  const [err, setErr] = useState("");
  useEffect(() => {
    const h = () => bump((n) => n + 1);
    window.addEventListener("wallets-changed", h);
    return () => window.removeEventListener("wallets-changed", h);
  }, []);

  const active = activeToken();
  const wallets = listWallets();

  return (
    <div className="card">
      <h2>Wallets</h2>
      <p className="muted small" style={{ marginTop: 0 }}>
        This device can hold several wallets at once. Switching between them keeps every one of them — their keys,
        history and contacts stay exactly where they are.
      </p>

      {wallets.map((w) => (
        <div key={w.token} className="contact-row">
          <div className="avatar" style={w.token === active ? undefined : { opacity: 0.45 }}>
            {(w.label.match(/\d+/)?.[0] ?? w.label.slice(0, 1)).toString()}
          </div>
          <div className="contact-main">
            <div className="contact-name">
              {w.label} {w.token === active && <span className="muted small">· active</span>}
            </div>
            {w.address && <div className="contact-addr">{w.address}</div>}
          </div>
          {w.token === active ? (
            <button className="linkbtn" onClick={() => setRenaming(w)}>
              Rename
            </button>
          ) : (
            <button
              className="linkbtn"
              onClick={() => {
                switchWallet(w.token);
                location.reload();
              }}
            >
              Switch
            </button>
          )}
        </div>
      ))}

      {err && <div className="msg err">{err}</div>}

      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginTop: 12 }}>
        <button
          className="btn"
          onClick={() => {
            // A brand-new token with nothing behind it: the app then shows
            // onboarding for it (create / restore / import) while every existing
            // wallet stays untouched under its own token.
            addWallet();
            location.reload();
          }}
        >
          Add another wallet
        </button>
        {wallets.length > 0 && (
          <button
            className="btn ghost"
            style={{ color: "var(--bad)" }}
            onClick={() => setAskRemove(wallets.find((w) => w.token === active) ?? null)}
          >
            Remove this wallet
          </button>
        )}
      </div>

      {renaming && (
        <RenameWallet
          wallet={renaming}
          onClose={() => {
            setRenaming(null);
            bump((n) => n + 1);
          }}
        />
      )}

      {askRemove && (
        <ConfirmDialog
          title={`Remove ${askRemove.label}?`}
          body="This wallet's key and data are erased from this device. Your other wallets are not affected. The coins stay on-chain but are unreachable from here without a backup or seed phrase."
          confirmLabel="Remove wallet"
          danger
          onConfirm={async () => {
            const w = askRemove;
            setAskRemove(null);
            try {
              const rest = listWallets().filter((x) => x.token !== w.token);
              // Desktop owns its daemon, so delete the wallet file there too.
              // Hosted: dropping the token is what makes this device forget it —
              // we must not delete server state on a shared daemon.
              if (isDesktop()) await forgetWallet(w.token);
              wipeWalletState(w.token);
              forgetWalletLock(w.token);
              // Its balance baseline and arrival records go too: a new wallet under a
              // recycled token must not inherit another wallet's income.
              forgetReceipts(w.token);
              unregisterWallet(w.token);
              // Fall back to another wallet if one exists, rather than dumping the
              // user into onboarding when they still have wallets left.
              if (rest.length > 0) switchWallet(rest[0].token);
              location.reload();
            } catch (e) {
              setErr((e as Error).message);
            }
          }}
          onCancel={() => setAskRemove(null)}
        />
      )}
    </div>
  );
}

function RenameWallet({ wallet, onClose }: { wallet: WalletRef; onClose: () => void }) {
  const [name, setName] = useState(wallet.label);
  return createPortal(
    <div className="modalwrap" onClick={onClose}>
      <div className="card modalcard" onClick={(e) => e.stopPropagation()}>
        <h2 style={{ marginTop: 0 }}>Rename wallet</h2>
        <input value={name} onChange={(e) => setName(e.target.value)} autoFocus />
        <div style={{ display: "flex", gap: 8 }}>
          <button
            className="btn"
            disabled={!name.trim()}
            onClick={() => {
              renameWallet(wallet.token, name);
              onClose();
            }}
          >
            Save
          </button>
          <button className="btn ghost" onClick={onClose}>
            Cancel
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
/// Backup for the NON-CUSTODIAL case — which is the default.
///
/// The wallet generates its seed in the app and registers only the viewing key
/// with the daemon, so the daemon correctly reports "watch-only: nothing to back
/// up" while the app holds the one secret that matters, in this device's
/// storage. The encryption therefore has to happen here (see `backup.ts`), not
/// in walletd.
function DeviceSeedBackup() {
  const [pass, setPass] = useState("");
  const [confirmPass, setConfirmPass] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [done, setDone] = useState<{ path: string; folder: string } | null>(null);
  const [mode, setMode] = useState<"backup" | "restore">("backup");
  // The last backup document, kept so the native (clipboard) path can offer
  // "copy again" without re-encrypting.
  const [lastDoc, setLastDoc] = useState("");
  const seed = getDeviceSeed();

  if (!seed) {
    return (
      <p className="muted small" style={{ marginTop: 0 }}>
        This device holds no spending key for the wallet — it can watch the balance but not spend. Restore your seed
        phrase on the Send tab to spend from here.
      </p>
    );
  }

  const run = async () => {
    setErr("");
    if (pass.length < 8) return setErr("Use at least 8 characters.");
    if (pass !== confirmPass) return setErr("The two passphrases do not match.");
    setBusy(true);
    try {
      // Carry the wallet's real scan birthday (remembered at watch/restore time):
      // a backup saying 0 makes every restore rescan from GENESIS — minutes to an
      // hour — even for a wallet born yesterday.
      const doc = await makeBackup(seed, pass, "mainnet", walletBirthday());
      setLastDoc(doc);
      if (isDesktop()) {
        setDone(await writeBackupFile(doc));
      } else if (isNative()) {
        // A Capacitor WebView has NO download manager: the browser path below
        // silently saves NOTHING on a phone while the confirmation claims a
        // file exists — the classic "I made a backup" that is nowhere, which
        // is how wallets end up unbacked-up.
        //
        // The native branch used to copy to the clipboard, which was the best available
        // then. `exportFile` tries the real share sheet first — a backup the user can
        // file away in Drive or mail to themselves is a backup that survives losing the
        // phone, which a clipboard entry does not — and still falls back to the
        // clipboard where sharing is unavailable.
        const name = `zkas-wallet-backup-${Math.floor(Date.now() / 1000)}.json`;
        const how = await exportFile(name, "application/json", doc);
        setDone({ path: how === "copied" ? "" : name, folder: "" });
      } else {
        const name = `zkas-wallet-backup-${Math.floor(Date.now() / 1000)}.json`;
        const how = await exportFile(name, "application/json", doc);
        setDone({ path: how === "copied" ? "" : name, folder: "" });
      }
      setPass("");
      setConfirmPass("");
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  if (done) {
    // Native clipboard path: no file was written (a WebView can't); the backup
    // only exists on the clipboard until the user pastes it somewhere.
    if (!done.path && !done.folder) {
      return (
        <>
          <p className="muted small" style={{ marginTop: 0 }}>
            <b>Your backup is copied.</b> Paste it somewhere safe right now — a password manager, a syncing notes
            app, a message to yourself. Nothing was saved as a file on this phone. The text is encrypted: useless
            without the backup passphrase.
          </p>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginTop: 10 }}>
            <button className="btn small" onClick={() => void copyText(lastDoc)}>
              Copy again
            </button>
            <button className="btn ghost small" onClick={() => setDone(null)}>
              Done
            </button>
          </div>
        </>
      );
    }
    return (
      <>
        <p className="muted small" style={{ marginTop: 0 }}>
          <b>Backup written.</b> Copy it somewhere off this computer — a USB stick, cloud storage, or a password
          manager. It is encrypted, so it is useless to anyone without the backup passphrase.
        </p>
        <div className="addr" style={{ fontSize: 12 }}>
          {done.path}
        </div>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginTop: 10 }}>
          {done.folder && (
            <button className="btn ghost small" onClick={() => openPath(done.folder).catch(() => {})}>
              Open folder
            </button>
          )}
          <button className="btn ghost small" onClick={() => setDone(null)}>
            Done
          </button>
        </div>
      </>
    );
  }

  if (mode === "restore") return <RestoreSeedBackup onBack={() => setMode("backup")} />;

  return (
    <>
      <p className="muted small" style={{ marginTop: 0 }}>
        <b>Back up your wallet.</b> Your spending key is stored by this app on this computer. Save an encrypted copy to
        a file so you can restore the wallet if this machine is lost — give the file its own passphrase.
      </p>
      <label>Backup passphrase</label>
      <input type="password" value={pass} onChange={(e) => setPass(e.target.value)} placeholder="At least 8 characters" />
      <label>Confirm backup passphrase</label>
      <input type="password" value={confirmPass} onChange={(e) => setConfirmPass(e.target.value)} placeholder="Type it again" />
      {err && <div className="msg err">{err}</div>}
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
        <button className="btn" onClick={run} disabled={busy || !pass}>
          {busy ? "Encrypting…" : isNative() ? "Copy encrypted backup" : "Create backup file"}
        </button>
        {isDesktop() && (
          <button className="btn ghost" onClick={() => setMode("restore")} disabled={busy}>
            Restore from backup
          </button>
        )}
      </div>
      <p className="muted small" style={{ marginTop: 10 }}>
        Lose the backup passphrase and the file cannot be opened — not by us, not by anyone. Your seed phrase remains
        the other way back in.
      </p>
    </>
  );
}

/// Restore the device's spending key from an encrypted backup file.
function RestoreSeedBackup({ onBack }: { onBack: () => void }) {
  const [found, setFound] = useState<string[]>([]);
  const [path, setPath] = useState("");
  const [pass, setPass] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [ok, setOk] = useState(false);

  useEffect(() => {
    listBackups()
      .then((b) => {
        setFound(b);
        if (b.length > 0) setPath(b[0]);
      })
      .catch(() => {});
  }, []);

  const run = async () => {
    setErr("");
    if (!path.trim()) return setErr("Choose a backup file.");
    setBusy(true);
    try {
      const json = await readBackupFile(path.trim());
      const { seedHex, birthday } = await readBackup(json, pass);
      // Register the viewing key with the daemon and keep the seed on-device —
      // the same shape as a freshly created wallet, so spending works after this.
      await api.watch(await fvkHex(seedHex), birthday);
      rememberBirthday(birthday);
      setDeviceSeed(seedHex);
      setOk(true);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  if (ok) {
    return (
      <>
        <p className="muted small" style={{ marginTop: 0 }}>
          <b>Wallet restored.</b> Your balance rebuilds from the chain — this takes a minute or two.
        </p>
        <button className="btn" onClick={() => location.reload()}>
          Reload wallet
        </button>
      </>
    );
  }

  return (
    <>
      <p className="muted small" style={{ marginTop: 0 }}>
        <b>Restore from backup.</b> Open an encrypted backup file and put its wallet on this computer.
      </p>
      {found.length > 0 && (
        <>
          <label>Backups found on this computer</label>
          <select value={path} onChange={(e) => setPath(e.target.value)}>
            {found.map((f) => (
              <option key={f} value={f}>
                {f.split(/[/\\]/).pop()}
              </option>
            ))}
          </select>
        </>
      )}
      <label>{found.length > 0 ? "…or paste a path" : "Path to your backup file"}</label>
      <input value={path} onChange={(e) => setPath(e.target.value)} placeholder="/path/to/zkas-wallet-backup-….json" />
      <label>Backup passphrase</label>
      <input type="password" value={pass} onChange={(e) => setPass(e.target.value)} placeholder="The passphrase you gave the file" />
      {err && <div className="msg err">{err}</div>}
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
        <button className="btn" onClick={run} disabled={busy || !pass}>
          {busy ? "Restoring…" : "Restore wallet"}
        </button>
        <button className="btn ghost" onClick={onBack} disabled={busy}>
          Back
        </button>
      </div>
    </>
  );
}

/// Write an encrypted backup file the user can store off this machine.
///
/// The file gets its OWN passphrase: it is meant to travel (USB stick, cloud
/// drive, password manager), and reusing the daily unlock secret on something
/// that leaves the machine turns one compromise into two. The file is useless
/// without that passphrase, so it is safe to keep where the seed phrase alone
/// would not be.
function BackupWallet() {
  const [pass, setPass] = useState("");
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [done, setDone] = useState<{ path: string; folder: string } | null>(null);

  const run = async () => {
    setErr("");
    if (pass.length < 8) return setErr("Use at least 8 characters.");
    if (pass !== confirm) return setErr("The two passphrases do not match.");
    setBusy(true);
    try {
      const info = await backupWallet(pass);
      setDone(info);
      setPass("");
      setConfirm("");
    } catch (e) {
      setErr(String(e));
    } finally {
      setBusy(false);
    }
  };

  if (done) {
    return (
      <>
        <p className="muted small" style={{ marginTop: 0 }}>
          <b>Backup written.</b> Copy this file somewhere off this computer — a USB stick, cloud storage, or a password
          manager. It is encrypted, so it is useless to anyone without the backup passphrase.
        </p>
        <div className="addr" style={{ fontSize: 12 }}>
          {done.path}
        </div>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginTop: 10 }}>
          <button className="btn ghost small" onClick={() => openPath(done.folder).catch(() => {})}>
            Open folder
          </button>
          <button className="btn ghost small" onClick={() => setDone(null)}>
            Make another
          </button>
        </div>
      </>
    );
  }

  return (
    <>
      <p className="muted small" style={{ marginTop: 0 }}>
        <b>Backup</b> — save an encrypted copy of your wallet to a file. Restore it on any computer with this app. Give
        it its own passphrase; do not reuse the one that unlocks this device.
      </p>
      <label>Backup passphrase</label>
      <input type="password" value={pass} onChange={(e) => setPass(e.target.value)} placeholder="At least 8 characters" />
      <label>Confirm backup passphrase</label>
      <input type="password" value={confirm} onChange={(e) => setConfirm(e.target.value)} placeholder="Type it again" />
      {err && <div className="msg err">{err}</div>}
      <button className="btn ghost" onClick={run} disabled={busy || !pass}>
        {busy ? "Writing…" : "Create backup file"}
      </button>
      <p className="muted small" style={{ marginTop: 10 }}>
        Lose this passphrase and the file cannot be opened — not by us, not by anyone. Your seed phrase remains the
        other way back in.
      </p>
    </>
  );
}

function NodeSourceSetting() {
  const [cfg, setCfg] = useState<DesktopConfig | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  useEffect(() => {
    initDesktop().then(setCfg).catch((e) => setErr(String(e)));
  }, []);
  if (!cfg) return null;
  const switchToPublic = async () => {
    setBusy(true);
    setErr("");
    try {
      await setNodeSource("remote");
      location.reload();
    } catch (e) {
      setErr(String(e));
      setBusy(false);
    }
  };
  const source = cfg.mode === "local" ? "Managed local node" : cfg.mode === "custom" ? "Your node" : "ZKAS public node";
  return (
    <div className="card">
      <h2>Wallet node</h2>
      <div className="detail-row"><span className="k">Connected through</span><span className="v">{source}</span></div>
      <div className="detail-row"><span className="k">gRPC</span><span className="v mono">{cfg.node_addr}</span></div>
      <p className="muted small">The embedded wallet engine keeps your keys on this computer. Node changes are checked before the wallet switches.</p>
      <div className="row" style={{ flexWrap: "wrap", gap: 8 }}>
        <button className="btn small" onClick={() => { location.hash = "#/node"; }}>Manage local node</button>
        {cfg.mode !== "remote" && <button className="btn small ghost" disabled={busy} onClick={() => void switchToPublic()}>{busy ? "Checking…" : "Use public node"}</button>}
      </div>
      {err && <div className="msg warn">{err}</div>}
    </div>
  );
}

/// Desktop with a genuinely dead embedded engine. Node outages no longer reach
/// this screen: walletd serves cached wallet state while it reconnects. Keep an
/// escape hatch here for local bind/config/runtime failures, but never claim the
/// public node is guaranteed to repair an unrelated engine problem.
function DesktopEngineDown({ requestError }: { requestError?: string | null }) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(requestError ?? null);
  const [engineAlive, setEngineAlive] = useState<boolean | null>(null);
  const [showLogs, setShowLogs] = useState(false);
  useEffect(() => {
    let alive = true;
    desktopServices.walletdStatus()
      .then((status) => {
        if (!alive) return;
        setEngineAlive(status.running);
        if (status.error) setErr(status.error);
      })
      .catch(() => undefined);
    return () => { alive = false; };
  }, []);
  return (
    <div className="card setup">
      <h2>{engineAlive ? "Wallet display lost its engine connection" : "The wallet engine didn't start"}</h2>
      <div className="msg warn">
        {engineAlive
          ? "The embedded wallet engine is running, but the display request failed. Retry reconnects the display to the engine's current internal port."
          : "ZKas Wallet runs its wallet engine inside this app, and it isn't answering. Your funds are safe on-chain — this is a local problem, not a chain one."}
      </div>
      <p className="muted small">
        Retry first. If this began after choosing another node, switch the connection back to the public history node.
        Neither action changes your wallet files or seed.
      </p>
      <div className="row" style={{ gap: 8, flexWrap: "wrap" }}>
        <button
          className="btn"
          disabled={busy}
          onClick={async () => {
            setBusy(true);
            setErr(null);
            try {
              await setNodeSource("remote");
              location.reload();
            } catch (e) {
              setErr(String((e as Error)?.message ?? e));
              setBusy(false);
            }
          }}
        >
          {busy ? "Switching…" : "Use public history node"}
        </button>
        {/* A plain retry first: the engine also fails for transient reasons, and
            the only remedy used to discard the user's custom-node config just to
            find out. */}
        <button className="btn ghost" disabled={busy} onClick={() => location.reload()}>
          Retry
        </button>
        <button className="btn ghost" onClick={() => setShowLogs(true)}>
          View wallet logs
        </button>
      </div>
      {err && <div className="msg warn">{err}</div>}
      <p className="muted small">If it still fails after retrying, restart the app once and keep the error shown above.</p>
      <ServiceLogsDialog
        open={showLogs}
        onClose={() => setShowLogs(false)}
        service="wallet-engine"
        title="Wallet engine logs"
      />
    </div>
  );
}

function Setup({ error: requestError }: { error?: string | null }) {
  const [base, setB] = useState(getBase());
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  // Desktop runs the wallet engine INSIDE the app, so "the hosted service is
  // down" is both wrong and unactionable there — and the URL box is meaningless,
  // since the shell hands the UI its own loopback port and token.
  if (isDesktop()) {
    return <DesktopEngineDown requestError={requestError} />;
  }

  return (
    <div className="card setup">
      <h2>Can't reach the wallet service</h2>
      <div className="msg warn">
        {isNative()
          ? "The wallet service isn't responding. Check your connection and try again shortly — your funds are safe on-chain."
          : "The hosted wallet service isn't responding right now. It normally runs on our side, connected to ZKas's public node — you don't need to run anything. Try again shortly."}
      </div>
      <p className="muted small">
        Your spending key is on this device either way — it is never sent to the service. What running your own{" "}
        <code>zkas-walletd</code> changes is <b>privacy</b>: the hosted service can see which wallet is asking about
        which blocks, and your own daemon sees only what you already know.
      </p>
      <p className="muted small">{isNative() ? "The installed app accepts HTTPS and plain HTTP LAN addresses." : "The web wallet requires an HTTPS wallet-service URL."}</p>
      {error && <div className="msg err">{error}</div>}
      <label>Daemon URL</label>
      <div className="row">
        <input value={base} onChange={(e) => setB(e.target.value)} className="mono" placeholder={isNative() ? "http://192.168.1.20:8501" : "https://wallet.example.com"} />
        <button
          className="btn small"
          style={{ flex: "0 0 auto" }}
          disabled={busy || !base.trim()}
          onClick={() => void (async () => {
            setBusy(true);
            setError("");
            try {
              const url = await findReachableDaemon(base, getWalletdBearer());
              setBase(url);
              location.reload();
            } catch (cause) {
              setError((cause as Error).message || String(cause));
              setBusy(false);
            }
          })()}
        >
          {busy ? "Checking…" : "Save"}
        </button>
      </div>
    </div>
  );
}
function trimFc(fc: string): string {
  // "12.34500000" -> "12.345"; "12.00000000" -> "12"
  if (!fc.includes(".")) return fc;
  const [w, f] = fc.split(".");
  const trimmed = f.replace(/0+$/, "");
  return trimmed ? `${w}.${trimmed}` : w;
}
