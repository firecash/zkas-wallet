import { useCallback, useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { desktopServices, type SelfHostStatus } from "../desktop-services";
import { isDesktop, openPath } from "../desktop";
import { setExplorerBase } from "../api/explorer";

export function SelfHost() {
  const navigate = useNavigate();
  const [status, setStatus] = useState<SelfHostStatus | null>(null);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
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
      <div className="control-heading"><div><span className="eyebrow">Self-host</span><h1>Local services</h1><p>Private, supervised services on this computer.</p></div><span className="status-pill good">Loopback only</span></div>
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

          <section className="control-card safety-card">
            <h2>Public access</h2>
            <p>RPC, walletd, and the local explorer stay on <code>127.0.0.1</code>. Automatic UPnP is disabled. If you publish a merchant checkout, place only the gateway behind authenticated TLS or Tor—never expose node RPC or walletd.</p>
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
