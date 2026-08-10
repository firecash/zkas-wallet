import { useCallback, useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { desktopServices, type SelfHostStatus } from "../desktop-services";
import { initDesktop, isDesktop, openPath } from "../desktop";
import { setExplorerBase } from "../api/explorer";
import { MANAGED_ZKAS_P2P_PORT, MANAGED_ZKAS_RPC_PORT, WALLET_SERVICE_PORT } from "../ports";

export function SelfHost() {
  const navigate = useNavigate();
  const [status, setStatus] = useState<SelfHostStatus | null>(null);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [accessEditing, setAccessEditing] = useState(false);
  const [walletAccess, setWalletAccess] = useState<"device" | "lan" | "wan">("device");
  const [walletPort, setWalletPort] = useState(WALLET_SERVICE_PORT);
  const [publicUrl, setPublicUrl] = useState("");
  const [nodeLanRpc, setNodeLanRpc] = useState(false);
  const [nodePublicP2p, setNodePublicP2p] = useState(false);
  const [tokenVisible, setTokenVisible] = useState(false);
  const [copied, setCopied] = useState(false);
  const refresh = useCallback(async () => {
    if (!isDesktop()) return;
    try {
      setStatus(await desktopServices.selfHostStatus());
      setError("");
    } catch (e) {
      setError((e as Error).message);
    }
  }, []);
  useEffect(() => {
    void refresh();
    const timer = window.setInterval(() => void refresh(), 3_000);
    return () => clearInterval(timer);
  }, [refresh]);

  const installExplorer = async () => {
    setBusy("install");
    setError("");
    try {
      await desktopServices.install({ zkas: true, bridge: false, kaspa: false });
      await refresh();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy("");
    }
  };
  const toggleExplorer = async () => {
    if (!status) return;
    setBusy("explorer");
    setError("");
    try {
      if (status.explorer_running) {
        await desktopServices.stopExplorer();
        setExplorerBase("");
      } else {
        await desktopServices.startExplorer();
        setExplorerBase(status.explorer_url);
      }
      await refresh();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy("");
    }
  };
  const setAutostart = async (enabled: boolean) => {
    setBusy("autostart");
    setError("");
    try {
      await desktopServices.setAutostart(enabled);
      await refresh();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy("");
    }
  };
  const editAccess = () => {
    if (!status) return;
    setWalletAccess(status.wallet_access);
    setWalletPort(status.wallet_access_port);
    setPublicUrl(status.wallet_public_url);
    setNodeLanRpc(status.node_lan_rpc);
    setNodePublicP2p(status.node_public_p2p);
    setError("");
    setAccessEditing(true);
  };
  const saveAccess = async () => {
    setBusy("access");
    setError("");
    try {
      await desktopServices.setHostAccess({
        walletAccess,
        walletAccessPort: walletPort,
        walletPublicUrl: publicUrl,
        nodeLanRpc,
        nodePublicP2p,
      });
      // The engine may have moved from a random loopback port to the stable
      // shared port. Refresh the SPA's base URL + bearer immediately.
      await initDesktop();
      setAccessEditing(false);
      await refresh();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy("");
    }
  };
  const copyToken = async () => {
    if (!status?.wallet_access_token) return;
    try {
      await navigator.clipboard.writeText(status.wallet_access_token);
    } catch {
      const input = document.createElement("textarea");
      input.value = status.wallet_access_token;
      input.style.position = "fixed";
      input.style.opacity = "0";
      document.body.appendChild(input);
      input.select();
      document.execCommand("copy");
      input.remove();
    }
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1_500);
  };

  if (!isDesktop()) {
    return (
      <main className="control-page">
        <div className="control-heading"><div><span className="eyebrow">Self-host</span><h1>Desktop services</h1><p>Local process control belongs in the desktop app.</p></div></div>
        <section className="control-card"><h2>Use the desktop wallet</h2><p>The browser cannot install or supervise programs on your computer. The desktop build keeps services on loopback and restarts managed processes if they fail.</p><a className="btn" href="https://github.com/firecash/zkas-wallet/releases" target="_blank" rel="noreferrer">Download desktop app</a></section>
      </main>
    );
  }

  return (
    <main className="control-page selfhost-page">
      <div className="control-heading"><div><span className="eyebrow">Self-host</span><h1>Local services</h1><p>Private, supervised services on this computer.</p></div><span className={`status-pill ${status?.wallet_access === "device" ? "good" : "warm"}`}>{status?.wallet_access === "wan" ? "Internet access" : status?.wallet_access === "lan" ? "LAN access" : "Device only"}</span></div>
      {error && <div className="control-error">{error}</div>}
      {!status ? <div className="control-card empty-state"><span className="spin" /> Reading service state…</div> : (
        <>
          <div className="selfhost-grid">
            <section className="control-card service-runtime-card">
              <div className="card-title-row"><div><h2>Wallet engine</h2><p>Sync and proving API embedded in this app.</p></div><span className={`status-pill ${status.wallet_engine_running ? "good" : "warm"}`}>{status.wallet_engine_running ? "Running" : "Stopped"}</span></div>
              <code>{status.wallet_engine_url || "locked"}</code>
              <p className="subtle">Bound to this device. The app token is never shown or forwarded.</p>
            </section>
            <section className="control-card service-runtime-card">
              <div className="card-title-row"><div><h2>Node connection</h2><p>{status.node_mode === "local" ? "Managed local ZKAS node." : status.node_mode === "custom" ? "Your configured node." : "ZKAS public node."}</p></div><span className="status-pill good">{status.node_mode}</span></div>
              <code>{status.node_rpc}</code>
              <button className="btn ghost compact" onClick={() => navigate("/node")}>Node controls</button>
            </section>
            <section className="control-card service-runtime-card">
              <div className="card-title-row"><div><h2>Explorer API</h2><p>Local chain REST API and transaction index.</p></div><span className={`status-pill ${status.explorer_running ? "good" : status.explorer_installed ? "" : "warm"}`}>{status.explorer_running ? "Running" : status.explorer_installed ? "Stopped" : "Not installed"}</span></div>
              <code>{status.explorer_url}</code>
              {status.explorer_last_exit && <div className="inline-warning">Last exit: {status.explorer_last_exit}</div>}
              <div className="control-actions">
                {!status.explorer_installed ? <button className="btn compact" disabled={!!busy} onClick={() => void installExplorer()}>{busy === "install" ? "Downloading & verifying…" : "Install verified backend"}</button> : <button className="btn compact" disabled={!!busy} onClick={() => void toggleExplorer()}>{busy === "explorer" ? "Working…" : status.explorer_running ? "Stop" : "Start"}</button>}
                {status.explorer_running && <button className="btn ghost compact" onClick={() => navigate("/explore")}>Open explorer</button>}
              </div>
            </section>
            <section className="control-card service-runtime-card">
              <div className="card-title-row"><div><h2>Payment gateway</h2><p>Invoices, unique addresses, and webhooks.</p></div><span className="status-pill warm">Source build</span></div>
              <p className="subtle">No signed gateway binary release exists yet, so the app will not download or execute an unverified build. The current source is ready for operators, but not honest one-click installation.</p>
              <a className="btn ghost compact" href="https://github.com/firecash/zkas-payment-gateway" target="_blank" rel="noreferrer">Build instructions ↗</a>
            </section>
          </div>

          <section className="control-card">
            <h2>Data & backup</h2>
            <p>Wallet backups contain the irreplaceable key. Node chain data and the explorer index are intentionally not copied—they are large, public, and can be rebuilt.</p>
            <div className="detail-row"><span className="k">App data</span><span className="v mono">{status.data_dir}</span></div>
            <div className="detail-row"><span className="k">Wallet backups</span><span className="v mono">{status.backup_dir}</span></div>
            <div className="control-actions"><button className="btn ghost compact" onClick={() => void openPath(status.data_dir)}>Open app data</button><button className="btn ghost compact" onClick={() => void openPath(status.backup_dir)}>Open backups</button><button className="btn compact" onClick={() => navigate("/")}>Back up wallet</button></div>
          </section>

          <section className="control-card safety-card host-access-card">
            <div className="card-title-row">
              <div><h2>Network access</h2><p>Use the wallet service from another device and choose how the node participates.</p></div>
              {!accessEditing && <button className="btn compact" onClick={editAccess}>Configure</button>}
            </div>

            {!accessEditing ? (
              <>
                <div className="node-runtime-summary">
                  <span><small>Wallet service</small><strong>{status.wallet_access === "device" ? "This device only" : status.wallet_access === "lan" ? "LAN · authenticated" : "Internet · HTTPS proxy"}</strong></span>
                  <span><small>Node RPC</small><strong>{status.node_lan_rpc ? "Trusted LAN" : "This device only"}</strong></span>
                  <span><small>Node P2P</small><strong>{status.node_public_p2p ? `Public · TCP ${MANAGED_ZKAS_P2P_PORT}` : "Outbound only"}</strong></span>
                </div>
                {!!status.wallet_access_urls?.length && (
                  <div className="detail-row">
                    <span className="k">Wallet URL{status.wallet_access_urls.length > 1 ? "s" : ""}</span>
                    <span className="v mono host-url-list">
                      {status.wallet_access_urls.map((url, index) => <span key={url}>{url}{index === 0 && status.wallet_access_urls.length > 1 ? " · preferred" : ""}</span>)}
                    </span>
                  </div>
                )}
                {status.wallet_access !== "device" && (
                  <>
                    <div className="detail-row"><span className="k">Access token</span><span className="v mono">{tokenVisible ? status.wallet_access_token ?? "Unavailable" : "••••••••••••••••••••••••"}</span></div>
                    <div className="control-actions">
                      <button className="btn ghost compact" onClick={() => setTokenVisible((value) => !value)}>{tokenVisible ? "Hide token" : "Show token"}</button>
                      <button className="btn ghost compact" onClick={() => void copyToken()}>{copied ? "Copied" : "Copy token"}</button>
                    </div>
                  </>
                )}
              </>
            ) : (
              <>
                <h3>Wallet service</h3>
                <div className="choice-row three host-mode-list" role="radiogroup" aria-label="Wallet service access">
                  <button className={`choice-button ${walletAccess === "device" ? "selected" : ""}`} role="radio" aria-checked={walletAccess === "device"} onClick={() => setWalletAccess("device")}><strong>Device only</strong><span>Random loopback port. Nothing else can connect.</span></button>
                  <button className={`choice-button ${walletAccess === "lan" ? "selected" : ""}`} role="radio" aria-checked={walletAccess === "lan"} onClick={() => setWalletAccess("lan")}><strong>Local network</strong><span>Authenticated service for desktop and mobile apps on a trusted LAN.</span></button>
                  <button className={`choice-button ${walletAccess === "wan" ? "selected" : ""}`} role="radio" aria-checked={walletAccess === "wan"} onClick={() => setWalletAccess("wan")}><strong>Internet</strong><span>Authenticated backend for a trusted HTTPS reverse proxy or VPN.</span></button>
                </div>
                {walletAccess !== "device" && <label className="host-field">Wallet port<input className="control-input" type="number" min={1024} max={65535} value={walletPort} onChange={(event) => setWalletPort(Number(event.target.value))} /></label>}
                {walletAccess === "wan" && <label className="host-field">Public HTTPS URL<input className="control-input mono" type="url" value={publicUrl} onChange={(event) => setPublicUrl(event.target.value)} placeholder="https://wallet.example.com" /></label>}
                {walletAccess === "lan" && <p className="inline-warning">Allow inbound TCP {walletPort} in the firewall for Private/Home networks only. The app does not change firewall rules or enable UPnP.</p>}
                {walletAccess === "wan" && <p className="inline-warning">Forward the public HTTPS URL through Caddy, nginx, Tailscale, or Tor to this computer. Do not expose the plain backend port directly to the internet.</p>}

                <h3>Node access</h3>
                <label className="check-row"><input type="checkbox" checked={nodeLanRpc} onChange={(event) => setNodeLanRpc(event.target.checked)} /><span><strong>Node RPC on trusted LAN</strong><small>Lets another wallet or miner use TCP {MANAGED_ZKAS_RPC_PORT}. No authentication—never forward it to the internet.</small></span></label>
                <label className="check-row"><input type="checkbox" checked={nodePublicP2p} onChange={(event) => setNodePublicP2p(event.target.checked)} /><span><strong>Public P2P node</strong><small>Accept peers on TCP {MANAGED_ZKAS_P2P_PORT}. This does not expose wallet data or RPC.</small></span></label>
                {status.node_running && (nodeLanRpc !== status.node_lan_rpc || nodePublicP2p !== status.node_public_p2p) && <p className="inline-warning">Stop the managed node before applying changed node access. Wallet-service changes do not require stopping it.</p>}
                <div className="control-actions">
                  <button className="btn ghost compact" disabled={busy === "access"} onClick={() => setAccessEditing(false)}>Cancel</button>
                  <button className="btn compact" disabled={busy === "access" || (status.node_running && (nodeLanRpc !== status.node_lan_rpc || nodePublicP2p !== status.node_public_p2p))} onClick={() => void saveAccess()}>{busy === "access" ? "Applying…" : "Apply"}</button>
                </div>
              </>
            )}
          </section>

          <section className="control-card safety-card">
            <div className="card-title-row">
              <div><h2>Desktop startup</h2><p>Start the app with your computer. An encrypted wallet still opens locked.</p></div>
              <label className="switch-row"><input type="checkbox" checked={status.autostart_enabled} disabled={busy === "autostart"} onChange={(event) => void setAutostart(event.target.checked)} /><span>Start on boot</span></label>
            </div>
            <p className="subtle">Closing the window keeps active node or mining services in the tray, but immediately locks the spending engine. Use “Quit and stop services” in the tray to stop every child process.</p>
          </section>
        </>
      )}
    </main>
  );
}
