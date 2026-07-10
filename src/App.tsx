import { useCallback, useEffect, useState } from "react";
import QRCode from "qrcode";
import { api, getBase, setBase, type Status } from "./api";
import logo from "./assets/firecash-logo.jpg";

type Tab = "receive" | "send" | "sign" | "verify";
const TAB_LABEL: Record<Tab, string> = {
  receive: "Receive",
  send: "Send",
  sign: "Sign",
  verify: "Verify",
};

export default function App() {
  const [status, setStatus] = useState<Status | null>(null);
  const [reachable, setReachable] = useState<boolean | null>(null);
  const [tab, setTab] = useState<Tab>("receive");
  // A freshly created seed, held at the top level so the 4-second status poll
  // (which flips has_wallet true) can never unmount the backup screen mid-copy.
  const [freshSeed, setFreshSeed] = useState<{ seed: string; address: string } | null>(null);

  const refresh = useCallback(async () => {
    try {
      const s = await api.status();
      setStatus(s);
      setReachable(true);
    } catch {
      setReachable(false);
    }
  }, []);

  useEffect(() => {
    refresh();
    const t = setInterval(refresh, 4000);
    return () => clearInterval(t);
  }, [refresh]);

  return (
    <div className="wrap">
      <Header status={status} reachable={reachable} />
      {reachable === false && <Setup />}
      {/* Seed backup takes priority and stays until dismissed — independent of has_wallet. */}
      {reachable && freshSeed && (
        <SeedBackup seed={freshSeed.seed} address={freshSeed.address} onDone={() => setFreshSeed(null)} />
      )}
      {reachable && !freshSeed && status && !status.has_wallet && (
        <Onboard onCreated={(seed, address) => setFreshSeed({ seed, address })} onImported={refresh} />
      )}
      {reachable && !freshSeed && status && status.has_wallet && (
        <>
          <BalanceHero status={status} />
          <div className="tabs">
            {(["receive", "send", "sign", "verify"] as Tab[]).map((t) => (
              <button key={t} className={tab === t ? "active" : ""} onClick={() => setTab(t)}>
                {TAB_LABEL[t]}
              </button>
            ))}
          </div>
          {tab === "receive" && <Receive status={status} />}
          {tab === "send" && <Send onSent={refresh} />}
          {tab === "sign" && <Sign />}
          {tab === "verify" && <Verify />}
        </>
      )}
      <div className="footer">
        FireCash Wallet · shielded by default · connected to FireCash's public node.
        <br />
        This wallet lives in this browser — back up your recovery seed to open it on another device or in incognito.
        <br />
        Daemon: <span className="mono">{getBase()}</span>
        {getBase().includes("127.0.0.1") || getBase().includes("localhost") ? " · self-hosted (non-custodial)" : " · hosted"}
        <br />
        <a href="https://github.com/firecash/firecash-wallet" target="_blank" rel="noreferrer" className="ghlink">
          GitHub
        </a>
      </div>
    </div>
  );
}

function Header({ status, reachable }: { status: Status | null; reachable: boolean | null }) {
  const node = reachable && status?.node_connected;
  return (
    <div className="brand">
      <img src={logo} alt="FireCash" />
      <h1>
        Fire<span className="em">Cash</span> Wallet
      </h1>
      <span className="tag">
        <span className={"dot " + (node ? "on" : "off")} />
        {reachable === false ? "daemon offline" : node ? `${status?.network} · node live` : "node offline"}
      </span>
    </div>
  );
}

function BalanceHero({ status }: { status: Status }) {
  const syncing = !status.synced;
  const pct =
    status.chain_len > 0 ? Math.min(100, Math.round((status.scanned_blocks / status.chain_len) * 100)) : 0;
  return (
    <div className="card balance">
      <div className="amt">
        {trimFc(status.balance_fc)}
        <span className="unit">FC</span>
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
      await navigator.clipboard.writeText(seed);
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

function Onboard({
  onCreated,
  onImported,
}: {
  onCreated: (seed: string, address: string) => void;
  onImported: () => void;
}) {
  const [mode, setMode] = useState<"choose" | "import">("choose");
  const [importHex, setImportHex] = useState("");
  const [birthday, setBirthday] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const create = async () => {
    setBusy(true);
    setError("");
    try {
      const r = await api.create();
      onCreated(r.seed_hex, r.address);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const doImport = async () => {
    setBusy(true);
    setError("");
    try {
      await api.import(importHex.trim(), birthday.trim() ? Number(birthday.trim()) : undefined);
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
        Create a fresh shielded wallet, or restore one from a seed. Every FireCash transfer is a private Orchard
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
  const addr = status.address || "";
  useEffect(() => {
    if (addr) QRCode.toDataURL(addr, { margin: 1, width: 440 }).then(setQr).catch(() => setQr(""));
  }, [addr]);
  return (
    <div className="card">
      <h2>Receive</h2>
      <div className="qr">{qr && <img src={qr} alt="address QR" />}</div>
      <label>Your shielded address</label>
      <div className="addr">{addr}</div>
      <button className="btn ghost small" style={{ marginTop: 12 }} onClick={() => navigator.clipboard.writeText(addr)}>
        Copy address
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
      const r = await api.reveal();
      setSeed(r.seed_hex);
      setShown(true);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(seed);
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

function Send({ onSent }: { onSent: () => void }) {
  const [to, setTo] = useState("");
  const [amount, setAmount] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [txid, setTxid] = useState("");

  const submit = async () => {
    setBusy(true);
    setError("");
    setTxid("");
    try {
      const r = await api.send(to.trim(), parseFloat(amount));
      setTxid(r.txid);
      setTo("");
      setAmount("");
      onSent();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="card">
      <h2>Send</h2>
      <label>Recipient shielded address</label>
      <input value={to} onChange={(e) => setTo(e.target.value)} placeholder="firecash:…" className="mono" />
      <label>Amount (FC)</label>
      <input value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="0.00" inputMode="decimal" />
      <div className="msg warn small">
        Spends prove into a matured anchor (~10&nbsp;min old), then build a real Halo&nbsp;2 proof on your machine — sending
        can take a few seconds.
      </div>
      {error && <div className="msg err">{error}</div>}
      {txid && (
        <div className="msg ok">
          Sent. Transaction id:
          <br />
          <span className="mono">{txid}</span>
        </div>
      )}
      <button className="btn" disabled={busy || !to || !amount} onClick={submit}>
        {busy ? (
          <>
            <span className="spin" /> Building proof…
          </>
        ) : (
          "Send privately"
        )}
      </button>
    </div>
  );
}

function Sign() {
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [result, setResult] = useState<{ address: string; signature: string } | null>(null);

  const submit = async () => {
    setBusy(true);
    setError("");
    setResult(null);
    try {
      const r = await api.sign(message);
      setResult({ address: r.address, signature: r.signature });
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
            onClick={() => navigator.clipboard.writeText(result.signature)}
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
      setResult(await api.verify(address.trim(), message, signature.trim()));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="card">
      <h2>Verify message</h2>
      <label>Signer's address</label>
      <input value={address} onChange={(e) => setAddress(e.target.value)} placeholder="firecash:…" className="mono" />
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

function Setup() {
  const [base, setB] = useState(getBase());
  return (
    <div className="card setup">
      <h2>Can't reach the wallet service</h2>
      <div className="msg warn">
        The hosted wallet service isn't responding right now. It normally runs on our side, connected to FireCash's
        public node — you don't need to run anything. Try again shortly.
      </div>
      <p className="muted small">
        Prefer full <b>non-custodial</b> control? Run your own <code>firecash-walletd</code> locally (it uses our public
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
