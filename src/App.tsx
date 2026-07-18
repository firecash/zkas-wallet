import { useCallback, useEffect, useRef, useState } from "react";
import QRCode from "qrcode";
import jsQR from "jsqr";
import { api, chainTx, getBase, setBase, isNative, loadStatusCache, saveStatusCache, type ChainHistory, type Status } from "./api";
import { attachTapHaptics, successFeedback } from "./haptics";
import {
  loadTxs,
  recordSend,
  reconcile,
  pendingTotal,
  applyChainStatus,
  saveSnapshot,
  loadSnapshot,
  type LocalTx,
} from "./localtx";
import { fvkHex, generateWallet, signLocal, verifyLocal, type Network } from "./signer";
import { sendNonCustodial, type SendStage } from "./noncustodial";
import { initDesktop, isDesktop, setNodeSource, type DesktopConfig } from "./desktop";
import logo from "./assets/zkas-logo.png";

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
  // A shielded address is a fixed-size Orchard payload → 79 bech32 chars after the
  // HRP. Use a tolerant lower bound (not an exact 79) so this stays a typo guard,
  // not a second decoder — the real validation is the on-device decode at send time.
  const s = a.trim();
  return /^(zkas|firecash)(test)?:[0-9a-z]{70,}$/.test(s);
}

// A scanned QR may be a bare address ("zkas:pxvt…") or a payment URI carrying
// an amount ("zkas:pxvt…?amount=1.5"). Split off the address and, if present,
// a numeric amount the caller can prefill.
function parsePaymentUri(text: string): { address: string; amount?: string } {
  const s = text.trim();
  const q = s.indexOf("?");
  if (q === -1) return { address: s };
  const address = s.slice(0, q);
  const amount = new URLSearchParams(s.slice(q + 1)).get("amount");
  return { address, amount: amount && /^\d*\.?\d+$/.test(amount) ? amount : undefined };
}

// Read the clipboard for a paste button (mobile keyboards make long addresses
// painful to type). Returns "" if the browser/WebView denies clipboard read.
async function pasteText(): Promise<string> {
  try {
    return (await navigator.clipboard.readText()).trim();
  } catch {
    return "";
  }
}

// "12.34500000" or "12.345" -> 12.345 (number); NaN if not a clean amount.
function parseAmount(s: string): number {
  if (!/^\d*\.?\d*$/.test(s.trim()) || s.trim() === "" || s.trim() === ".") return NaN;
  return parseFloat(s);
}

const EXPLORER = "https://explorer.zkas.info";
// Beta signal: the chain runs as mainnet internally (addresses, signing, the node),
// but while it's still being hardened we surface the network to users as "testnet"
// so nobody treats it as final. Display-only — does not affect address derivation
// or which network the daemon/signer actually use.
const NET_LABEL = "testnet";

type Tab = "receive" | "send" | "history" | "sign" | "verify";
const TAB_LABEL: Record<Tab, string> = {
  receive: "Receive",
  send: "Send",
  history: "History",
  sign: "Sign",
  verify: "Verify",
};
// On phones (native app or a narrow browser) five pills don't fit — drop Verify,
// the least-used power feature. Signature verification stays available on desktop.
const TABS: Tab[] =
  isNative() || (typeof window !== "undefined" && window.innerWidth < 480)
    ? ["receive", "send", "history", "sign"]
    : ["receive", "send", "history", "sign", "verify"];

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

function scrollToPane() {
  if (typeof window === "undefined" || window.innerWidth > MOBILE_SCROLL_MAX_WIDTH) return;
  requestAnimationFrame(() => {
    document.querySelector(".pane")?.scrollIntoView({ behavior: "smooth", block: "start" });
  });
}

export default function App() {
  // Boot from the cached last-known status: the whole UI (balance, address, QR)
  // renders in the first frame instead of trickling in as network calls land —
  // the 1s poll then corrects anything stale within a second.
  const [status, setStatus] = useState<Status | null>(() => loadStatusCache());
  const [reachable, setReachable] = useState<boolean | null>(() => (loadStatusCache() ? true : null));
  const [tab, setTab] = useState<Tab>("receive");
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
  // On-device send history; drives the optimistic (0-conf) balance and History tab.
  const [txs, setTxs] = useState<LocalTx[]>(() => loadTxs());

  // Hysteresis timers: the 1s poll can flip `synced` and `warming` for a beat
  // (a block lands, the background warm re-runs) and rendering every flip made the
  // hero text flap "synced" ↔ "syncing" ↔ "speeding up" — unsettling to watch.
  // A state change is only shown once it has held for a few seconds; brief dips
  // keep displaying the previous steady state.
  const unsyncedSince = useRef<number | null>(null);
  const warmingSince = useRef<number | null>(null);

  const refresh = useCallback(async () => {
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
        return prev?.has_wallet && (!s.has_wallet || !s.address)
          ? { ...stable, has_wallet: true, address: s.address ?? prev.address }
          : stable;
      });
      saveStatusCache(s);
      setReachable(true);
      let list = reconcile(parseFloat(s.balance_fc || "0"), !!s.synced);
      // Ask the chain about every send still shown as pending. This is what stops a
      // confirmed transaction from being displayed as "0-conf" indefinitely.
      for (const t of list.filter((x) => x.pending)) {
        const ct = await chainTx(t.txid);
        if (ct?.confirmations != null) list = applyChainStatus(t.txid, ct.confirmations);
      }
      setTxs(list);
      // Remember a balance the daemon actually knows, so a later reload/restart — when
      // it answers with zeros while rebuilding — has something honest to show instead.
      if (s.has_wallet && s.scanned_blocks > 0) {
        saveSnapshot({
          balanceFc: parseFloat(s.balance_fc || "0"),
          spendableFc: spendableFc(s),
          maturingFc: maturingFc(s),
          noteCount: s.note_count,
          ts: Date.now(),
        });
      }
    } catch {
      setReachable(false);
    }
  }, []);

  // Called by Send the instant a tx is broadcast: record it, jump straight to
  // History (highlighting the new row) so the confirmations can be watched
  // arriving live, and answer with a success haptic on the phone.
  const [justSent, setJustSent] = useState<string | null>(null);
  const onSent = useCallback(
    (tx: Omit<LocalTx, "pending">) => {
      setTxs(recordSend(tx));
      setJustSent(tx.txid);
      setTab("history");
      successFeedback();
      refresh();
    },
    [refresh],
  );

  // Native app: every tap on a control answers with a soft haptic tick.
  useEffect(() => attachTapHaptics(), []);

  // Warm the signer WASM in the background right after first paint, so the first
  // send/sign never waits on its (lazily-chunked) download + compile.
  useEffect(() => {
    const t = setTimeout(() => import("./signer").then((s) => s.ensureSigner()).catch(() => {}), 800);
    return () => clearTimeout(t);
  }, []);

  useEffect(() => {
    refresh();
    // 1s, not 4s: the daemon now sees a payment in the mempool within a second of it
    // being broadcast, so a slow poll here would be the only thing left making a payment
    // feel sluggish. The call is a cheap read of in-memory state.
    const t = setInterval(refresh, 1000);
    return () => clearInterval(t);
  }, [refresh]);

  return (
    <div className="wrap">
      <Header status={status} reachable={reachable} />
      <HostedNotice />
      {/* First-ever open (nothing cached yet): a visible connecting state while the
          first status call is in flight, never a stretch of empty page. */}
      {reachable === null && !status && (
        <div className="card center">
          <p className="muted" style={{ margin: 0 }}>
            <span className="spin" style={{ verticalAlign: -3, marginRight: 8 }} />
            Connecting to your wallet…
          </p>
        </div>
      )}
      {reachable === false && <Setup />}
      {/* Seed backup takes priority and stays until dismissed — independent of has_wallet. */}
      {reachable && freshSeed && (
        <SeedBackup seed={freshSeed.seed} address={freshSeed.address} onDone={() => setFreshSeed(null)} />
      )}
      {reachable && !freshSeed && status && !status.has_wallet && (
        <Onboard status={status} onCreated={(seed, address) => setFreshSeed({ seed, address })} onImported={refresh} />
      )}
      {reachable && !freshSeed && status && status.has_wallet && (
        <>
          <BalanceHero status={status} txs={txs} />
          <div className="tabs">
            {TABS.map((t) => (
              <button key={t} className={tab === t ? "active" : ""} onClick={() => setTab(t)}>
                {TAB_LABEL[t]}
              </button>
            ))}
          </div>
          {/* key remounts the pane on tab switch so the entrance transition plays. */}
          <div className="pane appear" key={tab}>
            {tab === "receive" && <Receive status={status} />}
            {tab === "send" && <Send status={status} onSent={onSent} />}
            {tab === "history" && (
              <History txs={txs} justSent={justSent} onSendAnother={() => { setJustSent(null); setTab("send"); }} />
            )}
            {tab === "sign" && <Sign status={status} />}
            {tab === "verify" && <Verify />}
          </div>
        </>
      )}
      {isDesktop() ? <NodeSourceSetting /> : <DaemonSetting />}
      <div className="footer">
        ZKas Wallet · shielded by default · connected to ZKas's public node.
        <br />
        This wallet lives in this browser — back up your recovery seed to open it on another device or in incognito.
        <br />
        <a href="https://github.com/firecash/firecash-wallet" target="_blank" rel="noreferrer" className="ghlink">
          GitHub
        </a>
      </div>
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
  return localStorage.getItem(deviceSeedKey()) || "";
}
export function setDeviceSeed(seed: string) {
  if (seed) localStorage.setItem(deviceSeedKey(), seed);
}

/// Thrown when this device has no key for the wallet and the daemon has none to
/// give (a watch-only wallet opened on a new device) — the caller then asks the
/// user to restore it from their seed.
export const SEED_REQUIRED = "SEED_REQUIRED";

/// The seed to sign with. From this device's storage first; for wallets created
/// under the old hosted model the daemon still holds one, so fall back to it once
/// and remember it here. A watch-only wallet on a fresh device has neither — the
/// user must restore from their backup.
export async function resolveDeviceSeed(): Promise<string> {
  const stored = getDeviceSeed();
  if (stored) return stored;
  try {
    const r = await api.reveal();
    setDeviceSeed(r.seed_hex);
    return r.seed_hex;
  } catch {
    throw new Error(SEED_REQUIRED);
  }
}

function HostedNotice() {
  // Mobile: keep it to one line — screen real estate is tight and the self-host
  // links live in the Daemon card anyway. Web keeps the fuller explainer.
  if (isNative()) {
    return (
      <div className="warnbar" role="note">
        <span className="warnbar-icon" aria-hidden="true">🔒</span>
        <div>Signed on your device — <b>your seed never leaves it</b>.</div>
      </div>
    );
  }
  // Web: one calm line. The self-host and cold-storage links matter, but they don't
  // deserve a red multi-line banner permanently parked above the balance — that just
  // pushed the actual wallet below the fold.
  return (
    <div className="warnbar" role="note">
      <span className="warnbar-icon" aria-hidden="true">🔒</span>
      <div>
        Signed on your device — <b>your seed never leaves it</b>. Max security:{" "}
        <a href="https://github.com/firecash/firecash-rusty#zkas-walletd--wallet-daemon-rest-powers-the-web-wallet"
           target="_blank" rel="noreferrer">self-host</a>{" "}
        ·{" "}
        <a href="https://zkas.info/paper-wallet.html" target="_blank" rel="noreferrer">paper wallet</a>.
      </div>
    </div>
  );
}

function Header({ status, reachable }: { status: Status | null; reachable: boolean | null }) {
  const node = reachable && status?.node_connected;
  return (
    <div className="brand">
      <img src={logo} alt="ZKas" />
      <h1>
        <span className="em">Z</span>Kas Wallet
      </h1>
      <span className="tag">
        <span className={"dot " + (node ? "on" : "off")} />
        {reachable === false ? "daemon offline" : node ? `${NET_LABEL} · node live` : "node offline"}
      </span>
    </div>
  );
}

// Spendable-now balance, falling back to the full balance for older daemons that
// don't report it (so nothing regresses if status lacks the field).
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

function BalanceHero({ status, txs }: { status: Status; txs: LocalTx[] }) {
  // NB: every hook here runs BEFORE the `restoring` early return below. That
  // return comes and goes with the daemon's scan state, so a hook placed after
  // it would change hook order between renders — React's "rendered fewer hooks
  // than expected" crash, on exactly the path a user hits after a restart.
  const syncing = useMinDwell(!status.synced, 5000);
  const warming = useMinDwell(!!status.warming, 6000);
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
  const inNotice = useHeldAmount(pendingIn, 4000);
  const outNotice = useHeldAmount(outflow, 4000);
  const pct =
    status.chain_len > 0 ? Math.min(100, Math.round((status.scanned_blocks / status.chain_len) * 100)) : 0;
  // The daemon has not rebuilt this wallet's state yet — it reports zeros because it
  // does not KNOW the balance, not because the balance is zero. Never render those
  // zeros as a balance; fall back to the last figure it gave us.
  const restoring = status.scanned_blocks === 0 && !status.synced;
  const snap = restoring ? loadSnapshot() : null;
  if (restoring) {
    return (
      <div className="card balance">
        <div className="amt">
          {snap ? trimFc(snap.balanceFc.toFixed(8)) : "—"}
          <span className="unit">ZKAS</span>
        </div>
        <div className="sub">
          <span className="spin" style={{ width: 11, height: 11 }} />{" "}
          {snap ? "last known balance — restoring your wallet…" : "restoring your wallet…"}
        </div>
        <div className="sub" style={{ marginTop: 8, fontSize: 12 }}>
          Your coins are on-chain and safe. The wallet is rebuilding its private view of them; this can take a few
          minutes after a server restart.
        </div>
      </div>
    );
  }
  const pendingCount = txs.filter((t) => t.pending).length;
  const shownBal = Math.max(0, parseFloat(status.balance_fc || "0") + pendingIn - outflow);
  // Spendable now vs still-maturing (shielded anchor depth ~10 min). Incoming 0-conf
  // value is NOT spendable yet, so it only counts toward maturing.
  const maturing = maturingFc(status) + pendingIn;
  const spendable = spendableFc(status) - outflow;
  return (
    <div className="card balance">
      <div className="amt">
        {trimFc(shownBal.toFixed(8))}
        <span className="unit">ZKAS</span>
      </div>
      <div className="sub">
        {status.note_count} shielded note{status.note_count === 1 ? "" : "s"}
        {syncing ? (
          <>
            {" · "}
            <span className="spin" style={{ width: 11, height: 11 }} />{" "}
            {/* "syncing 100%" reads as stuck — at the top of the scan the remaining
                work is ingesting the last few blocks, so say what's happening. */}
            {pct >= 99 ? "finalizing sync…" : `syncing ${pct}%`}
          </>
        ) : warming ? (
          <>
            {" · "}synced{" · "}
            <span className="spin" style={{ width: 11, height: 11 }} /> <span className="warmtag">speeding up sends</span>
          </>
        ) : (
          " · synced"
        )}
      </div>
      {!syncing && warming && (
        <div className="sub warmnote">⚡ Getting up to speed (~1–2 min) — after this, sends take seconds.</div>
      )}
      {inNotice.shown && (
        <div className="sub" style={{ marginTop: 6, color: "var(--ember)" }}>
          +{trimFc(inNotice.amount.toFixed(8))} ZKAS incoming — confirmed on-chain, settling into your wallet
        </div>
      )}
      {outNotice.shown && (
        <div className="sub" style={{ marginTop: 6, color: "var(--ember)" }}>
          {trimFc(outNotice.amount.toFixed(8))} ZKAS{" "}
          {pendingOut > 0 || txs.some((t) => t.pending && (t.confs ?? 0) >= 1)
            ? "sent — confirmed on-chain, updating your balance shortly"
            : `sent — broadcast${pendingCount > 1 ? ` · ${pendingCount} sends` : ""} (0-conf)`}
        </div>
      )}
      {maturing > 0.00000001 && (
        <div className="sub" style={{ marginTop: 6 }}>
          {trimFc(Math.max(0, spendable).toFixed(8))} spendable now ·{" "}
          <span style={{ color: "var(--ember)" }}>{trimFc(maturing.toFixed(8))} maturing</span> — shielded coins are
          spendable ~10 min after they arrive.
        </div>
      )}
      {syncing && (
        <>
          <div className="syncbar">
            <div className="syncbar-fill" style={{ width: `${Math.max(2, pct)}%` }} />
          </div>
          <div className="sub" style={{ marginTop: 8, fontSize: 12 }}>
            Balances appear as the wallet scans the chain — your funds are safe.
          </div>
        </>
      )}
      {status.error && <div className="msg err">{status.error}</div>}
    </div>
  );
}

// One-time seed backup, shown right after creation. Rendered at the App level so
// the periodic status poll can't unmount it — it stays until the user dismisses it.
function SeedBackup({ seed, address, onDone }: { seed: string; address: string; onDone: () => void }) {
  const [copied, setCopied] = useState(false);
  const [confirmed, setConfirmed] = useState(false);
  const copy = async () => {
    try {
      await copyText(seed);
    } catch {
      /* clipboard may be blocked; the seed is shown below to copy by hand */
    }
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };
  return (
    <div className="card">
      <h2>Back up your recovery phrase</h2>
      <div className="msg warn">
        This 32-byte seed <b>is</b> your wallet. Write it down and store it offline. Anyone who has it controls your
        funds. Take your time — nothing is synced until you continue.
      </div>
      <label>Recovery seed (hex)</label>
      <div className="addr">{seed}</div>
      <button className="btn ghost small" style={{ marginTop: 12 }} onClick={copy}>
        {copied ? "Copied ✓" : "Copy seed"}
      </button>
      <label style={{ marginTop: 16 }}>Your shielded address</label>
      <div className="addr">{address}</div>
      <label style={{ display: "flex", gap: 10, alignItems: "flex-start", marginTop: 18, cursor: "pointer" }}>
        <input type="checkbox" checked={confirmed} onChange={(e) => setConfirmed(e.target.checked)} style={{ marginTop: 3 }} />
        <span className="muted small">
          I've written down my recovery seed and understand it's the only way to restore this wallet. You can view it
          again anytime under the <b>Receive</b> tab.
        </span>
      </label>
      <button className="btn" disabled={!confirmed} onClick={onDone}>
        Open wallet
      </button>
    </div>
  );
}

/// The signer's network name for the daemon's chain (only mainnet/testnet exist
/// for address encoding; anything else is a devnet using the testnet HRP).
function networkOf(status: Status | null): Network {
  return status?.network === "mainnet" ? "mainnet" : "testnet";
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
  const [mode, setMode] = useState<"choose" | "import">("choose");
  const [importHex, setImportHex] = useState("");
  const [birthday, setBirthday] = useState("");
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
      const w = await generateWallet(networkOf(status));
      // Born now: the daemon fast-syncs from the current tip instead of scanning
      // the whole chain for history this wallet cannot have.
      const birthday = status?.daa_score ?? 0;
      await api.watch(await fvkHex(w.seedHex), birthday);
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
  const doImport = async () => {
    setBusy(true);
    setError("");
    try {
      const seed = importHex.trim();
      await api.watch(await fvkHex(seed), birthday.trim() ? Number(birthday.trim()) : 0);
      setDeviceSeed(seed);
      onImported();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  if (mode === "import") {
    return (
      <div className="card">
        <h2>Import wallet</h2>
        <label>Recovery seed (64 hex characters)</label>
        <textarea value={importHex} onChange={(e) => setImportHex(e.target.value)} placeholder="e.g. 0a1b2c…" />
        <label>Wallet birthday — block height (optional, speeds up sync)</label>
        <input
          value={birthday}
          onChange={(e) => setBirthday(e.target.value.replace(/[^0-9]/g, ""))}
          placeholder="0 = scan whole chain for old funds"
          inputMode="numeric"
        />
        <div className="msg small" style={{ background: "transparent", border: "1px solid var(--border)", color: "var(--muted)" }}>
          Set this to the block height around when the wallet first received funds to skip scanning older history.
          Leave blank to scan from the start. Spending always re-checks the full chain, so funds are never missed.
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
        Create a fresh shielded wallet, or restore one from a seed. Every ZKas transfer is a private Orchard
        (zk-SNARK) transaction.
      </p>
      {error && <div className="msg err">{error}</div>}
      <button className="btn" disabled={busy} onClick={create}>
        {busy ? <span className="spin" /> : "Create new wallet"}
      </button>
      <button className="btn ghost" onClick={() => setMode("import")}>
        Import from seed
      </button>
    </div>
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

  const run = async (alsoEnableHistory: boolean) => {
    const scope = alsoEnableHistory
      ? "Rescan will re-read the chain from your wallet's birthday, recovering your balance AND rebuilding your transaction history from here on."
      : historyOn === false
        ? "Rescan will re-read the chain from your wallet's birthday and recover your balance. History is off, so no transaction list is produced."
        : "Rescan will re-read the chain from your wallet's birthday to rebuild history and recover anything missing.";
    if (!confirm(scope + " Takes a minute or two — the balance shows as syncing meanwhile. Continue?")) return;
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
      alert((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

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
        <button className="btn ghost" onClick={() => run(false)} disabled={busy}>
          {busy ? "Starting…" : "↻ Rescan"}
        </button>
        {historyOn === false && (
          <button className="btn ghost small" onClick={() => run(true)} disabled={busy}>
            Enable history & recover
          </button>
        )}
      </div>
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
      <div className="qr">{qr && <img src={qr} alt="address QR" onClick={copy} style={{ cursor: "pointer" }} />}</div>
      <label>Your shielded address</label>
      <div className="addr" onClick={copy} style={{ cursor: "pointer" }} title="Tap to copy">
        {addr}
      </div>
      <button className="btn ghost small" style={{ marginTop: 12 }} onClick={copy}>
        {copied ? "Copied ✓" : "Copy address"}
      </button>

      <RescanButton label="Payment not showing up?" hint="Re-read the chain for this wallet — recovers anything the local view is missing." />

      <div style={{ height: 1, background: "var(--border)", margin: "22px 0" }} />
      <RevealSeed />
    </div>
  );
}

// Reveal / copy the recovery seed on demand. Lives inside Receive so a wallet's
// address and its backup phrase sit together. Gated behind an explicit tap so the
// seed is never on screen until asked for.
function RevealSeed() {
  const [seed, setSeed] = useState("");
  const [shown, setShown] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [copied, setCopied] = useState(false);

  const reveal = async () => {
    setBusy(true);
    setError("");
    try {
      // The seed lives on this device, not on the server.
      setSeed(await resolveDeviceSeed());
      setShown(true);
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
    <>
      <label>Recovery phrase</label>
      <p className="muted small" style={{ marginTop: 4 }}>
        Your seed is the only way to restore this wallet. Anyone who sees it can spend your funds — reveal it only
        somewhere private.
      </p>
      {error && <div className="msg err">{error}</div>}
      {!shown ? (
        <button className="btn ghost small" disabled={busy} onClick={reveal}>
          {busy ? <span className="spin" /> : "Reveal recovery seed"}
        </button>
      ) : (
        <>
          <div className="msg warn small">Keep this private. Anyone with it controls your funds.</div>
          <div className="addr">{seed}</div>
          <div className="row" style={{ marginTop: 12 }}>
            <button className="btn ghost small" onClick={copy}>
              {copied ? "Copied ✓" : "Copy seed"}
            </button>
            <button className="btn ghost small" onClick={() => setShown(false)}>
              Hide
            </button>
          </div>
        </>
      )}
    </>
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
    <div className="scan-overlay" role="dialog" aria-label="Scan address QR code">
      <div className="scan-frame">
        <video ref={videoRef} className="scan-video" muted playsInline />
        <div className="scan-reticle" />
      </div>
      <p className="scan-hint">{err || "Point the camera at the recipient's address QR"}</p>
      <button type="button" className="btn ghost" style={{ maxWidth: 220 }} onClick={onClose}>
        {err ? "Close" : "Cancel"}
      </button>
    </div>
  );
}

function Send({ status, onSent }: { status: Status | null; onSent: (tx: Omit<LocalTx, "pending">) => void }) {
  const [to, setTo] = useState("");
  const [amount, setAmount] = useState("");
  const [busy, setBusy] = useState(false);
  const [stage, setStage] = useState<SendStage | null>(null);
  const [error, setError] = useState("");
  const [unlock, setUnlock] = useState("");
  const [needSeed, setNeedSeed] = useState(false);
  const [confirming, setConfirming] = useState(false);
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

  const onScan = useCallback((text: string) => {
    const { address, amount: amt } = parsePaymentUri(text);
    setTo(address);
    if (amt) setAmount(amt);
    setScanning(false);
  }, []);

  // A send can only draw on SPENDABLE (matured) funds, not the full balance — so
  // Max, the overspend check, and messaging all use spendable, and the total's
  // maturing remainder is surfaced separately so "you have money but can't send it"
  // is never a mystery.
  const spendable = spendableFc(status);
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
  const canProceed = addrOk && amtValid && !overspend && !!status?.synced;

  const setMax = () => {
    const max = Math.max(0, spendable - feeReserve);
    setAmount(max > 0 ? String(Number(max.toFixed(8))) : "0");
  };

  const doSend = async () => {
    setBusy(true);
    setError("");
    try {
      // Signed on-device; the seed resolves silently from this device's storage.
      // Only a wallet restored on a NEW device has to be unlocked once.
      let seed: string;
      try {
        seed = await resolveDeviceSeed();
      } catch (e) {
        if ((e as Error).message === SEED_REQUIRED) {
          if (!/^[0-9a-fA-F]{64}$/.test(unlock.trim())) {
            setNeedSeed(true);
            setConfirming(false);
            setError("This device doesn't hold this wallet's key yet. Enter your recovery seed once to unlock sending here.");
            return;
          }
          seed = unlock.trim();
          setDeviceSeed(seed);
          setUnlock("");
          setNeedSeed(false);
        } else {
          throw e;
        }
      }
      const feeSompi = feeCustomSet ? Math.round(feeCustom * 1e8) : undefined;
      const r = await sendNonCustodial(seed.trim(), networkOf(status), to.trim(), amt, feeSompi, setStage);
      const toAddr = to.trim();
      setTo("");
      setAmount("");
      setConfirming(false);
      // Record on-device so the balance drops to a 0-conf figure immediately;
      // onSent switches straight to History where the confirmations tick in live.
      // The daemon reports the fee it actually charged (byte-proportional) —
      // record that, not the UI's estimate.
      const paidFeeFc = (r.fee_sompi ?? FEE_FC * 1e8) / 1e8;
      onSent({
        txid: r.txid,
        to: toAddr,
        amountFc: amt,
        feeFc: paidFeeFc,
        ts: Date.now(),
        preFc: reliablePreFc(status),
        spentFc: amt + paidFeeFc,
      });
    } catch (e) {
      setError((e as Error).message);
      setConfirming(false);
    } finally {
      setBusy(false);
      setStage(null);
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
        <label>To</label>
        <div className="addr">{to.trim()}</div>
        {needSeed && (
          <>
            <label>Recovery seed (unlocks signing on this device — stored only here)</label>
            <textarea value={unlock} onChange={(e) => setUnlock(e.target.value)} placeholder="64 hex characters" />
          </>
        )}
        {status?.warming ? (
          <div className="msg warn small">
            <b>⚡ This send may take up to a minute</b> — your wallet is still speeding up. Later sends take seconds.
          </div>
        ) : (
          <div className="msg ok small">
            Verified and signed <b>on your device</b>, then broadcast. Usually takes <b>a few seconds</b>.
          </div>
        )}
        {error && <div className="msg err">{error}</div>}
        <div className="row">
          <button className="btn ghost" disabled={busy} onClick={() => { setConfirming(false); setError(""); }}>
            Back
          </button>
          <button className="btn" disabled={busy} onClick={doSend}>
            {busy ? (
              <>
                <span className="spin" />{" "}
                {stage === "signing"
                  ? "Signing on device…"
                  : stage === "broadcasting"
                    ? "Broadcasting…"
                    : "Building private proof…"}
              </>
            ) : (
              "Confirm & send"
            )}
          </button>
        </div>
        {busy && (
          <div className="stagebar" aria-hidden="true">
            <span className={"stagedot " + (stage === "proving" ? "live" : "done")} />
            <span className={"stagedot " + (stage === "signing" ? "live" : stage === "broadcasting" ? "done" : "")} />
            <span className={"stagedot " + (stage === "broadcasting" ? "live" : "")} />
          </div>
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
            const t = await pasteText();
            if (t) setTo(t);
          }}
        >
          Paste
        </button>
      </div>
      {to && !addrOk && <div className="fieldhint bad">That doesn't look like a zkas: address.</div>}
      {scanning && <QrScanner onResult={onScan} onClose={() => setScanning(false)} />}

      <div className="amthead">
        <label style={{ margin: 0 }}>Amount (ZKAS)</label>
        <div style={{ display: "flex", gap: 14, alignItems: "center" }}>
          <button
            type="button"
            className="linkbtn"
            aria-label="Fee settings"
            title="Fee settings"
            style={feeCustomSet ? undefined : { color: "var(--muted)" }}
            onClick={() => setShowFeeCfg(!showFeeCfg)}
          >
            ⚙{feeCustomSet ? ` ${feeCustom}` : ""}
          </button>
          <button type="button" className="linkbtn" onClick={setMax}>
            Max
          </button>
        </div>
      </div>
      <input
        value={amount}
        onChange={(e) => setAmount(e.target.value.replace(/[^0-9.]/g, ""))}
        placeholder="0.00"
        inputMode="decimal"
        style={overspend ? { borderColor: "var(--bad)" } : undefined}
      />
      {showFeeCfg && (
        <>
          <label>Custom network fee (ZKAS) — optional</label>
          <input
            value={customFee}
            onChange={(e) => setCustomFee(e.target.value.replace(/[^0-9.]/g, ""))}
            placeholder={`automatic (${FEE_FC}–${FEE_MAX_FC})`}
            inputMode="decimal"
          />
          <div className="fieldhint muted">
            Leave empty for automatic. If a send bounced with a fee error, set a higher fee here — fees below the
            network minimum are raised automatically, so this can't break a send.
          </div>
        </>
      )}
      {overspend && blockedByMaturing && (
        <div className="fieldhint bad">
          Only {trimFc(spendable.toFixed(8))} is spendable right now — {trimFc(maturing.toFixed(8))} is still maturing
          (shielded coins can be spent ~10 min after they arrive, incl. your change from a recent send). It'll be
          available shortly.
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

      {!status?.synced && (
        <div className="msg warn small">Wallet is still syncing — you can send once it finishes.</div>
      )}
      {status?.synced && status?.warming && (
        <div className="msg warn warmbanner">
          <b>⚡ First send may take up to a minute.</b>
          <br />
          Your wallet is speeding up right now (~1–2 min). After that, sends take seconds.
        </div>
      )}
      {error && <div className="msg err">{error}</div>}

      <button className="btn" disabled={!canProceed} onClick={() => { setError(""); setConfirming(true); }}>
        Review send
      </button>
    </div>
  );
}

function Sign({ status }: { status: Status | null }) {
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
      const seed = await resolveDeviceSeed();
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
    <div className="card">
      <h2>Sign message</h2>
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

function Verify() {
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
    <div className="card">
      <h2>Verify message</h2>
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
  justSent,
  onSendAnother,
}: {
  txs: LocalTx[];
  justSent?: string | null;
  onSendAnother?: () => void;
}) {
  // Chain-derived history (mints, receives, and OVK-recovered sends): fetched
  // from the daemon, so it survives a seed restore and shows on every device.
  const [chain, setChain] = useState<ChainHistory | null>(null);
  const [busy, setBusy] = useState(false);
  // True from the moment history is enabled until the recovery scan produces
  // rows — so the tab explains the wait instead of looking empty and broken.
  const [recovering, setRecovering] = useState(false);
  useEffect(() => {
    if (recovering && (chain?.rows.length ?? 0) > 0) setRecovering(false);
  }, [recovering, chain]);
  useEffect(() => {
    let live = true;
    const pull = () => api.history().then((h) => live && setChain(h)).catch(() => {});
    pull();
    const t = setInterval(pull, 15_000);
    return () => {
      live = false;
      clearInterval(t);
    };
  }, []);

  // History is opt-in: nothing readable is stored until the user activates it,
  // and turning it off erases the stored record immediately.
  //
  // Enabling also kicks off a rescan. Rows are only written as blocks are
  // scanned, so without it "Enable history" leaves the tab empty until the next
  // payment arrives — the flag looks broken. The rescan re-reads the chain from
  // the wallet's birthday and recovers everything the keys can still derive.
  const setHistory = async (on: boolean) => {
    if (
      !on &&
      !confirm("Turn history off? The stored record is erased immediately. Your balance and funds are not affected.")
    )
      return;
    setBusy(true);
    try {
      await api.setHistoryEnabled(on);
      if (on) {
        await api.rescan();
        setRecovering(true);
      }
      setChain(await api.history());
    } catch (e) {
      alert((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const fresh = justSent ? txs.find((t) => t.txid === justSent) : undefined;
  const chainRows = chain?.rows ?? [];
  const confirmed = new Set(chainRows.map((r) => r.txid));
  // Device-local sends the chain scan hasn't caught up to yet stay on top as
  // 0-conf rows; once a send appears chain-side, the chain row is authoritative.
  const pending = txs.filter((t) => !confirmed.has(t.txid));
  const historyOff = chain !== null && !chain.recoverableHistory;

  // Notes locked by sends still awaiting chain confirmation. Their value includes
  // the change coming back, so this is shown as "held", never as an amount sent —
  // and the daemon returns it all automatically if a transaction never lands.
  const heldZkas = (chain?.pendingOutgoing ?? []).reduce((s, p) => s + p.amountZkas, 0);
  const heldTxids = new Set((chain?.pendingOutgoing ?? []).map((p) => p.txid)).size;

  if (historyOff) {
    return (
      <div className="card">
        <h2>History</h2>
        {heldTxids > 0 && (
          <p className="muted small">
            {heldTxids} outgoing transaction{heldTxids === 1 ? "" : "s"} in flight — {trimFc(heldZkas.toFixed(8))} ZKAS
            temporarily held until it confirms (returned automatically within ~1 hour if it never does).
          </p>
        )}
        <p className="muted small" style={{ marginTop: 0 }}>
          Transaction history is <b>off</b> — the private default. Nothing about your payments is stored anywhere.
        </p>
        <p className="muted small">
          Turn it on and this wallet keeps a readable record — amounts, dates, and for your own sends the recipient and
          memo — saved with the wallet’s sync data, so it survives restarts and follows your seed. The risk you accept:
          anyone who obtains this wallet’s access token or file can read that record. On-chain, transactions stay fully
          shielded either way.
        </p>
        <button className="btn" onClick={() => setHistory(true)} disabled={busy}>
          {busy ? "Enabling & recovering…" : "Enable history & recover"}
        </button>
        <p className="muted small" style={{ marginTop: 10 }}>
          Enabling immediately re-reads the chain to recover everything your keys can still see — mints, payments
          received, and sends made while history was on before. Takes a minute or two. Sends made while history was off
          carry no record for anyone, so those recover as amounts without a recipient — not even you can recover who was
          paid.
        </p>
      </div>
    );
  }

  if (pending.length === 0 && chainRows.length === 0) {
    return (
      <div className="card">
        <h2>History</h2>
        <p className="muted small" style={{ marginTop: 0 }}>
          {chain === null
            ? "Loading history…"
            : recovering
              ? "Recovering your history from the chain — this takes a minute or two. Rows appear here as the scan catches up; you can leave this tab."
              : "Nothing yet. Mints, payments you receive, and sends from this wallet all show up here — recovered from the chain itself, so this list follows your seed, not this device."}
        </p>
        {chain !== null && !recovering && (
          <button className="btn ghost small" onClick={() => setHistory(false)} disabled={busy}>
            Turn history off
          </button>
        )}
      </div>
    );
  }
  return (
    <div className="card">
      <h2>History</h2>
      {fresh && (
        <div className="sentbanner appear">
          <span className="sent-check small">✓</span>
          <div>
            <b>Sent privately.</b> Watch it confirm below — this updates live.
          </div>
          {onSendAnother && (
            <button className="btn ghost small" style={{ flex: "none" }} onClick={onSendAnother}>
              Send another
            </button>
          )}
        </div>
      )}
      <div className="txlist">
        {pending.map((t) => (
          <a
            key={t.txid}
            className={"txrow" + (t.txid === justSent ? " fresh" : "")}
            href={`${EXPLORER}/txs/${t.txid}`}
            target="_blank"
            rel="noreferrer"
          >
            <div className="txrow-main">
              <span className="txrow-amt">− {trimFc(t.amountFc.toFixed(8))} ZKAS</span>
              <span className={"txrow-badge " + ((t.confs ?? 0) >= 1 ? "done" : "pending")}>
                {(t.confs ?? 0) >= 1 ? `${t.confs} conf${t.confs === 1 ? "" : "s"}` : "0-conf"}
              </span>
            </div>
            <div className="txrow-sub">
              <span className="mono">to {shortAddr(t.to)}</span>
              <span>{fmtTime(t.ts)}</span>
            </div>
          </a>
        ))}
        {chainRows.map((r) => (
          <a key={r.txid + r.kind} className="txrow" href={`${EXPLORER}/txs/${r.txid}`} target="_blank" rel="noreferrer">
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
                <span className="mono">to {shortAddr(r.recipient)}</span>
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
          </a>
        ))}
      </div>
      {heldTxids > 0 && (
        <p className="muted small" style={{ marginTop: 14 }}>
          {heldTxids} outgoing transaction{heldTxids === 1 ? "" : "s"} in flight — {trimFc(heldZkas.toFixed(8))} ZKAS
          temporarily held until it confirms (returned automatically within ~1 hour if it never does).
        </p>
      )}
      <RescanButton label="Something missing?" hint="Re-read the chain to rebuild this history and recover any funds the local view lost." />

      <p className="muted small" style={{ marginTop: 14 }}>
        Recovered from the chain by your viewing key — only this wallet can see any of it. Tap a row to view it on the
        explorer (which shows the shielded transaction, not its contents).{" "}
        <a
          href="#"
          onClick={(e) => {
            e.preventDefault();
            setHistory(false);
          }}
        >
          Turn history off & erase
        </a>
      </p>
    </div>
  );
}

/// The daemon this wallet talks to. Always reachable — not just when the hosted
/// service is down — because pointing it at your own `zkas-walletd` is how you
/// stop trusting ours at all, and that has to be one tap away, at any time.
function DaemonSetting() {
  const [open, setOpen] = useState(false);
  const [base, setB] = useState(getBase());
  const current = getBase();
  const own = current.includes("127.0.0.1") || current.includes("localhost");
  return (
    <div className="card">
      <h2 style={{ margin: 0 }}>
        <button
          className="btn ghost small daemon-btn"
          style={{ width: "100%", justifyContent: "space-between", textTransform: "none", letterSpacing: 0 }}
          onClick={() => setOpen(!open)}
        >
          <span className="daemon-url">Daemon: <span className="mono">{current}</span></span>
          <span className="muted daemon-mode">{own ? "your own ✓" : "hosted"} {open ? "▲" : "▼"}</span>
        </button>
      </h2>
      {open && (
        <>
          <p className="muted small" style={{ marginTop: 14 }}>
            Your seed is signed with on this device either way. But the hosted daemon still sees your{" "}
            <b>viewing key</b> — it can watch your balance and history. Run your own <code>zkas-walletd</code>{" "}
            (it talks to our public node; no full node needed) and point this at it to remove that too.
          </p>
          <label>Daemon URL</label>
          <div className="row">
            <input value={base} onChange={(e) => setB(e.target.value)} className="mono" placeholder="http://127.0.0.1:8501" />
            <button
              className="btn small"
              style={{ flex: "0 0 auto" }}
              onClick={() => {
                setBase(base);
                location.reload();
              }}
            >
              Save
            </button>
          </div>
          <button
            className="btn ghost small"
            style={{ marginTop: 10 }}
            onClick={() => {
              setBase("");
              location.reload();
            }}
          >
            Reset to hosted default
          </button>
        </>
      )}
    </div>
  );
}

/// Desktop only: which ZKas node the EMBEDDED wallet engine scans through.
/// The engine itself always runs in-app (seed never leaves this machine) —
/// this only picks where chain data comes from.
function NodeSourceSetting() {
  const [cfg, setCfg] = useState<DesktopConfig | null>(null);
  const [addr, setAddr] = useState("");
  const [binary, setBinary] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  useEffect(() => {
    initDesktop().then((c) => {
      if (c) {
        setCfg(c);
        setAddr(c.node_addr);
        setBinary(c.node_binary ?? "");
      }
    });
  }, []);
  if (!cfg) return null;
  const pick = async (mode: "remote" | "custom" | "local") => {
    setBusy(true);
    setErr("");
    try {
      setCfg(await setNodeSource(mode, addr || undefined, binary || undefined));
    } catch (e) {
      setErr(String(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="card">
      <h2>Node</h2>
      <p className="muted small" style={{ marginTop: 0 }}>
        Your wallet engine runs inside this app — your seed and viewing key never leave this machine. Choose which
        node it reads the chain through:
      </p>
      <div className="row" style={{ flexWrap: "wrap", gap: 8 }}>
        {(["remote", "custom", "local"] as const).map((m) => (
          <button
            key={m}
            disabled={busy}
            className={"btn small" + (cfg.mode === m ? "" : " ghost")}
            onClick={() => pick(m)}
          >
            {m === "remote" ? "ZKas public node" : m === "custom" ? "Custom node" : "Local node"}
          </button>
        ))}
      </div>
      {cfg.mode === "custom" && (
        <>
          <label style={{ marginTop: 10 }}>Node gRPC (host:port)</label>
          <div className="row">
            <input value={addr} onChange={(e) => setAddr(e.target.value)} className="mono" placeholder="192.168.1.10:16110" />
            <button className="btn small" style={{ flex: "0 0 auto" }} disabled={busy} onClick={() => pick("custom")}>
              Apply
            </button>
          </div>
        </>
      )}
      {cfg.mode === "local" && (
        <>
          <label style={{ marginTop: 10 }}>zkas-node binary path</label>
          <div className="row">
            <input value={binary} onChange={(e) => setBinary(e.target.value)} className="mono" placeholder="/usr/local/bin/zkas-node" />
            <button className="btn small" style={{ flex: "0 0 auto" }} disabled={busy} onClick={() => pick("local")}>
              Apply
            </button>
          </div>
          <p className="muted small" style={{ marginTop: 8 }}>
            {cfg.node_running
              ? "Local node is running — the app supervises it and stops it on exit."
              : "Node not running yet — set the binary path and Apply. It syncs the chain into this app's data folder."}
          </p>
        </>
      )}
      {err && <div className="msg warn">{err}</div>}
    </div>
  );
}

function Setup() {
  const [base, setB] = useState(getBase());
  return (
    <div className="card setup">
      <h2>Can't reach the wallet service</h2>
      <div className="msg warn">
        The hosted wallet service isn't responding right now. It normally runs on our side, connected to ZKas's
        public node — you don't need to run anything. Try again shortly.
      </div>
      <p className="muted small">
        Prefer full <b>non-custodial</b> control? Run your own <code>zkas-walletd</code> locally (it uses our public
        node, no full node required) and point this URL at it — then your seed never leaves your machine.
      </p>
      <label>Daemon URL</label>
      <div className="row">
        <input value={base} onChange={(e) => setB(e.target.value)} className="mono" placeholder="http://127.0.0.1:8501" />
        <button
          className="btn small"
          style={{ flex: "0 0 auto" }}
          onClick={() => {
            setBase(base);
            location.reload();
          }}
        >
          Save
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
