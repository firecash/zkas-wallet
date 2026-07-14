import { useCallback, useEffect, useRef, useState } from "react";
import QRCode from "qrcode";
import jsQR from "jsqr";
import { api, chainTx, getBase, setBase, isNative, type Status } from "./api";
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
import { sendNonCustodial } from "./noncustodial";
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

type Tab = "receive" | "send" | "history" | "sign" | "verify" | "local";
const TAB_LABEL: Record<Tab, string> = {
  receive: "Receive",
  send: "Send",
  history: "History",
  sign: "Sign",
  verify: "Verify",
  local: "Local",
};

export default function App() {
  const [status, setStatus] = useState<Status | null>(null);
  const [reachable, setReachable] = useState<boolean | null>(null);
  const [tab, setTab] = useState<Tab>("receive");
  // A freshly created seed, held at the top level so the 4-second status poll
  // (which flips has_wallet true) can never unmount the backup screen mid-copy.
  const [freshSeed, setFreshSeed] = useState<{ seed: string; address: string } | null>(null);
  // On-device send history; drives the optimistic (0-conf) balance and History tab.
  const [txs, setTxs] = useState<LocalTx[]>(() => loadTxs());

  const refresh = useCallback(async () => {
    try {
      const s = await api.status();
      setStatus(s);
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

  // Called by Send the instant a tx is broadcast: record it and refresh so the
  // 0-conf balance drops immediately.
  const onSent = useCallback(
    (tx: Omit<LocalTx, "pending">) => {
      setTxs(recordSend(tx));
      refresh();
    },
    [refresh],
  );

  useEffect(() => {
    refresh();
    const t = setInterval(refresh, 4000);
    return () => clearInterval(t);
  }, [refresh]);

  return (
    <div className="wrap">
      <Header status={status} reachable={reachable} />
      <HostedNotice />
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
            {(["receive", "send", "history", "sign", "verify", "local"] as Tab[]).map((t) => (
              <button key={t} className={tab === t ? "active" : ""} onClick={() => setTab(t)}>
                {TAB_LABEL[t]}
              </button>
            ))}
          </div>
          {tab === "receive" && <Receive status={status} />}
          {tab === "send" && <Send status={status} onSent={onSent} />}
          {tab === "history" && <History txs={txs} />}
          {tab === "sign" && <Sign status={status} />}
          {tab === "verify" && <Verify />}
          {tab === "local" && <LocalTools />}
        </>
      )}
      <DaemonSetting />
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
  return (
    <div className="warnbar" role="note">
      <span className="warnbar-icon" aria-hidden="true">🔒</span>
      <div>
        Sends are signed on your device — <b>your seed never leaves it</b>. Still, for maximum security prefer{" "}
        <a href="https://github.com/firecash/firecash-rusty#zkas-walletd--wallet-daemon-rest-powers-the-web-wallet"
           target="_blank" rel="noreferrer">running your own daemon</a>{" "}
        or a{" "}
        <a href="https://zkas.info/paper-wallet.html" target="_blank" rel="noreferrer">paper wallet</a>{" "}
        for cold storage.
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
// 0-conf value the chain has already confirmed but the wallet's own tree has not
// ingested yet (it holds back SYNC_TIP_MARGIN blocks from the tip). Showing these is
// what makes a payment appear seconds after it is mined rather than ~3 minutes later.
function pendingInFc(status: Status | null): number {
  return status?.pending_in_fc != null ? parseFloat(status.pending_in_fc) : 0;
}
function pendingOutFc(status: Status | null): number {
  return status?.pending_out_fc != null ? parseFloat(status.pending_out_fc) : 0;
}

function BalanceHero({ status, txs }: { status: Status; txs: LocalTx[] }) {
  const syncing = !status.synced;
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
  // The displayed balance folds in what the CHAIN has already confirmed but the
  // wallet's tree has not ingested yet (the daemon's 0-conf preview of the unsettled
  // window), so a received payment lands here seconds after it is mined.
  const pendingIn = pendingInFc(status);
  const pendingOut = pendingOutFc(status);
  // Outflow is known two ways: this device's own record of a just-broadcast send, and
  // the daemon seeing our nullifier on-chain. Take the larger rather than the sum —
  // they describe the same spend, and adding them would debit it twice.
  const localOut = pendingTotal(txs);
  const outflow = Math.max(pendingOut, localOut);
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
            <span className="spin" style={{ width: 11, height: 11 }} /> syncing {pct}%
          </>
        ) : (
          " · synced"
        )}
      </div>
      {pendingIn > 0.00000001 && (
        <div className="sub" style={{ marginTop: 6, color: "var(--ember)" }}>
          +{trimFc(pendingIn.toFixed(8))} ZKAS incoming — confirmed on-chain, settling into your wallet
        </div>
      )}
      {outflow > 0.00000001 && (
        <div className="sub" style={{ marginTop: 6, color: "var(--ember)" }}>
          {trimFc(outflow.toFixed(8))} ZKAS{" "}
          {pendingOut > 0
            ? "sent — confirmed on-chain, settling into your wallet"
            : pendingCount > 0
              ? `pending · ${pendingCount} unconfirmed send${pendingCount === 1 ? "" : "s"} (0-conf)`
              : "sent — settling into your wallet"}
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
          again anytime under the <b>Recovery</b> tab.
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

function Receive({ status }: { status: Status }) {
  const [qr, setQr] = useState("");
  const [copied, setCopied] = useState(false);
  const addr = status.address || "";
  useEffect(() => {
    if (addr) QRCode.toDataURL(addr, { margin: 1, width: 440 }).then(setQr).catch(() => setQr(""));
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

// A ~0.03 FC network fee is added on top of the amount (matches the daemon default).
const FEE_FC = 0.03;

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
  const [error, setError] = useState("");
  const [sent, setSent] = useState<{ txid: string; amount: string } | null>(null);
  const [unlock, setUnlock] = useState("");
  const [needSeed, setNeedSeed] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [scanning, setScanning] = useState(false);

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
  const overspend = amtValid && amt + FEE_FC > spendable + 1e-9;
  // The maturing balance would cover it — the shortfall is just not-yet-matured funds.
  const blockedByMaturing = overspend && amtValid && amt + FEE_FC <= spendable + maturing + 1e-9;
  // The send is possible only once the wallet is synced (spends need a matured anchor).
  const canProceed = addrOk && amtValid && !overspend && !!status?.synced;

  const setMax = () => {
    const max = Math.max(0, spendable - FEE_FC);
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
      const r = await sendNonCustodial(seed.trim(), networkOf(status), to.trim(), amt);
      const toAddr = to.trim();
      setSent({ txid: r.txid, amount });
      setTo("");
      setAmount("");
      setConfirming(false);
      // Record on-device so the balance drops to a 0-conf figure immediately and
      // the send shows up in History even before the daemon has scanned it.
      onSent({
        txid: r.txid,
        to: toAddr,
        amountFc: amt,
        feeFc: FEE_FC,
        ts: Date.now(),
        preFc: parseFloat(status?.balance_fc || "0"),
        spentFc: amt + FEE_FC,
      });
    } catch (e) {
      setError((e as Error).message);
      setConfirming(false);
    } finally {
      setBusy(false);
    }
  };

  // Success screen — clear confirmation with a link to the transaction.
  if (sent) {
    return (
      <div className="card center">
        <div style={{ fontSize: 42, lineHeight: 1 }}>✓</div>
        <h2 style={{ marginTop: 10 }}>Sent privately</h2>
        <p className="muted" style={{ marginTop: 0 }}>
          <b>{trimFc(sent.amount)}</b> ZKAS is on its way — broadcast now, unconfirmed (0-conf) until the next
          block. Your balance already reflects it and it's in your History.
        </p>
        <a className="btn ghost small" href={`${EXPLORER}/txs/${sent.txid}`} target="_blank" rel="noreferrer">
          View transaction ↗
        </a>
        <button className="btn" onClick={() => setSent(null)}>
          Send another
        </button>
      </div>
    );
  }

  // Confirmation step — show exactly what will happen before the proof is built.
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
          <span className="mono">{FEE_FC} ZKAS</span>
        </div>
        <div className="confirm-row total">
          <span>Total</span>
          <span className="mono">{Number((amt + FEE_FC).toFixed(8))} ZKAS</span>
        </div>
        <label>To</label>
        <div className="addr">{to.trim()}</div>
        {needSeed && (
          <>
            <label>Recovery seed (unlocks signing on this device — stored only here)</label>
            <textarea value={unlock} onChange={(e) => setUnlock(e.target.value)} placeholder="64 hex characters" />
          </>
        )}
        <div className="msg ok small">
          This is verified and signed <b>on your device</b>, then broadcast. Building the private zero-knowledge proof
          takes about <b>15–20 seconds</b> — the tx is sent the moment it completes.
        </div>
        {error && <div className="msg err">{error}</div>}
        <div className="row">
          <button className="btn ghost" disabled={busy} onClick={() => { setConfirming(false); setError(""); }}>
            Back
          </button>
          <button className="btn" disabled={busy} onClick={doSend}>
            {busy ? (
              <>
                <span className="spin" /> Sending…
              </>
            ) : (
              "Confirm & send"
            )}
          </button>
        </div>
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
        <button type="button" className="linkbtn" onClick={setMax}>
          Max
        </button>
      </div>
      <input
        value={amount}
        onChange={(e) => setAmount(e.target.value.replace(/[^0-9.]/g, ""))}
        placeholder="0.00"
        inputMode="decimal"
        style={overspend ? { borderColor: "var(--bad)" } : undefined}
      />
      {overspend && blockedByMaturing && (
        <div className="fieldhint bad">
          Only {trimFc(spendable.toFixed(8))} is spendable right now — {trimFc(maturing.toFixed(8))} is still maturing
          (shielded coins can be spent ~10 min after they arrive, incl. your change from a recent send). It'll be
          available shortly.
        </div>
      )}
      {overspend && !blockedByMaturing && (
        <div className="fieldhint bad">
          Not enough funds: {trimFc(spendable.toFixed(8))} spendable, need {trimFc((amt + FEE_FC).toFixed(8))} incl. the{" "}
          {FEE_FC} fee.
        </div>
      )}
      {amtValid && !overspend && (
        <div className="fieldhint muted">
          + {FEE_FC} fee = {Number((amt + FEE_FC).toFixed(8))} total
        </div>
      )}

      {!status?.synced && (
        <div className="msg warn small">Wallet is still syncing — you can send once it finishes.</div>
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

// Fully client-side, server-independent key tools. Everything here runs in this
// page's WebAssembly — no daemon, and the seed never leaves the device.
function LocalTools() {
  const [network, setNetwork] = useState<Network>("mainnet");

  // Cold wallet generator
  const [gen, setGen] = useState<{ seedHex: string; address: string } | null>(null);
  const [revealSeed, setRevealSeed] = useState(false);
  const [genBusy, setGenBusy] = useState(false);

  // Sign with a seed
  const [seedIn, setSeedIn] = useState("");
  const [message, setMessage] = useState("");
  const [sig, setSig] = useState<{ address: string; signatureHex: string } | null>(null);
  const [signBusy, setSignBusy] = useState(false);
  const [err, setErr] = useState("");

  const doGenerate = async () => {
    setGenBusy(true);
    setErr("");
    setRevealSeed(false);
    try {
      setGen(await generateWallet(network));
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setGenBusy(false);
    }
  };

  const doSign = async () => {
    setSignBusy(true);
    setErr("");
    setSig(null);
    try {
      setSig(await signLocal(seedIn, network, message));
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setSignBusy(false);
    }
  };

  return (
    <div className="card">
      <h2>Local tools (self-custody)</h2>
      <p className="muted small" style={{ marginTop: 0 }}>
        These run <b>entirely in this page</b> (WebAssembly) — no server, and your seed
        never leaves this device. Use them to create a cold wallet or to sign without
        trusting the daemon. Balance and sending still use the daemon (a shielded spend
        needs a zero-knowledge proof).
      </p>

      <label>Network</label>
      <select
        className="mono"
        value={network}
        onChange={(e) => setNetwork(e.target.value as Network)}
      >
        <option value="mainnet">mainnet (zkas:)</option>
        <option value="testnet">testnet (zkastest:)</option>
      </select>

      <h3 style={{ marginBottom: 6 }}>Generate a cold wallet</h3>
      <p className="muted small" style={{ marginTop: 0 }}>
        Creates a fresh seed + address on-device. Back up the seed offline — it is the
        only way to restore, and anyone who sees it can spend.
      </p>
      <button className="btn" disabled={genBusy} onClick={doGenerate}>
        {genBusy ? <span className="spin" /> : "Generate new wallet"}
      </button>
      {gen && (
        <>
          <label>Address (safe to share)</label>
          <div className="addr">{gen.address}</div>
          <label>Recovery seed — SECRET</label>
          {revealSeed ? (
            <div className="addr">{gen.seedHex}</div>
          ) : (
            <button className="btn ghost small" onClick={() => setRevealSeed(true)}>
              Reveal seed
            </button>
          )}
          {revealSeed && (
            <button
              className="btn ghost small"
              style={{ marginTop: 8 }}
              onClick={() => copyText(gen.seedHex)}
            >
              Copy seed
            </button>
          )}
        </>
      )}

      <h3 style={{ marginBottom: 6, marginTop: 22 }}>Sign with a seed</h3>
      <p className="muted small" style={{ marginTop: 0 }}>
        Prove control of an address (e.g. to claim a mining-pool payout) without spending.
        The seed is used locally and never transmitted.
      </p>
      <label>Seed (64 hex chars)</label>
      <input
        className="mono"
        value={seedIn}
        onChange={(e) => setSeedIn(e.target.value)}
        placeholder="your 32-byte seed, hex…"
        autoComplete="off"
        spellCheck={false}
      />
      <label>Message</label>
      <textarea value={message} onChange={(e) => setMessage(e.target.value)} placeholder="Message to sign…" />
      <button className="btn" disabled={signBusy || !seedIn || !message} onClick={doSign}>
        {signBusy ? <span className="spin" /> : "Sign locally"}
      </button>
      {sig && (
        <>
          <label>Address</label>
          <div className="addr">{sig.address}</div>
          <label>Signature (fvk‖sig, hex)</label>
          <div className="addr" style={{ maxHeight: 120, overflow: "auto" }}>
            {sig.signatureHex}
          </div>
          <button
            className="btn ghost small"
            style={{ marginTop: 12 }}
            onClick={() => copyText(sig.signatureHex)}
          >
            Copy signature
          </button>
        </>
      )}

      {err && <div className="msg err">{err}</div>}
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
function History({ txs }: { txs: LocalTx[] }) {
  if (txs.length === 0) {
    return (
      <div className="card">
        <h2>History</h2>
        <p className="muted small" style={{ marginTop: 0 }}>
          No sends yet from this device. Sends you make here show up instantly — even before the network confirms
          them. This list is kept on this device only.
        </p>
      </div>
    );
  }
  return (
    <div className="card">
      <h2>History</h2>
      <div className="txlist">
        {txs.map((t) => (
          <a
            key={t.txid}
            className="txrow"
            href={`${EXPLORER}/txs/${t.txid}`}
            target="_blank"
            rel="noreferrer"
          >
            <div className="txrow-main">
              <span className="txrow-amt">− {trimFc(t.amountFc.toFixed(8))} ZKAS</span>
              <span className={"txrow-badge " + (t.pending ? "pending" : "done")}>
                {t.pending
                  ? "0-conf"
                  : t.confs != null
                    ? `${t.confs} conf${t.confs === 1 ? "" : "s"}`
                    : "sent"}
              </span>
            </div>
            <div className="txrow-sub">
              <span className="mono">to {shortAddr(t.to)}</span>
              <span>{fmtTime(t.ts)}</span>
            </div>
          </a>
        ))}
      </div>
      <p className="muted small" style={{ marginTop: 14 }}>
        Sends performed on this device (this wallet keeps no history server-side). Tap a row to view it on the explorer.
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
