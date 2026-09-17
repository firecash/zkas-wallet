import { useCallback, useEffect, useState } from "react";
import QRCode from "qrcode";
import { useNavigate } from "react-router-dom";
import { Trans, useTranslation } from "react-i18next";
import { desktopServices, type SelfHostStatus } from "../desktop-services";
import { initDesktop, isDesktop, openPath } from "../desktop";
import { setExplorerBase } from "../api/explorer";
import { MANAGED_ZKAS_P2P_PORT, MANAGED_ZKAS_RPC_PORT, WALLET_SERVICE_PORT } from "../ports";

export function SelfHost() {
  const { t } = useTranslation();
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
  const [pairingCopied, setPairingCopied] = useState(false);
  const [pairingQr, setPairingQr] = useState("");
  // The first reachable address is the one the QR encodes: it is ranked to prefer an
  // ordinary home network over a VPN interface, which is the address a phone on the
  // same Wi-Fi can actually reach.
  const pairing = status?.wallet_pairing_uris?.[0] ?? "";
  useEffect(() => {
    if (!pairing) {
      setPairingQr("");
      return;
    }
    let live = true;
    QRCode.toDataURL(pairing, { margin: 1, width: 440 })
      .then((url) => { if (live) setPairingQr(url); })
      .catch(() => { if (live) setPairingQr(""); });
    return () => { live = false; };
  }, [pairing]);
  const copyPairing = useCallback(async () => {
    if (!pairing) return;
    try {
      await navigator.clipboard.writeText(pairing);
      setPairingCopied(true);
      setTimeout(() => setPairingCopied(false), 1500);
    } catch {
      // Clipboard access can be refused; the QR is still on screen.
    }
  }, [pairing]);
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
        // Cleared BEFORE the stop, not after: if `stopExplorer` throws, the local
        // explorer is going away regardless and an override that outlives it strands the
        // whole Explorer tab on a dead port (it then shows a cached snapshot, hours old,
        // with no sign anything is wrong). Pointing at the public API when a local one is
        // still up costs nothing; the reverse costs the user their explorer.
        setExplorerBase("");
        await desktopServices.stopExplorer();
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
        <div className="control-heading"><div><span className="eyebrow">{t("selfHost.webEyebrow")}</span><h1>{t("selfHost.webTitle")}</h1><p>{t("selfHost.webIntro")}</p></div></div>
        <section className="control-card"><h2>{t("selfHost.webUse")}</h2><p>{t("selfHost.webNote")}</p><a className="btn" href="https://github.com/firecash/zkas-wallet/releases" target="_blank" rel="noreferrer">{t("selfHost.webDownload")}</a></section>
      </main>
    );
  }

  return (
    <main className="control-page selfhost-page">
      <div className="control-heading"><div><span className="eyebrow">{t("selfHost.eyebrow")}</span><h1>{t("selfHost.title")}</h1><p>{t("selfHost.intro")}</p></div><span className={`status-pill ${status?.wallet_access === "device" ? "good" : "warm"}`}>{status?.wallet_access === "wan" ? t("selfHost.internetAccess") : status?.wallet_access === "lan" ? t("selfHost.lanAccess") : t("selfHost.deviceOnly")}</span></div>
      {error && <div className="control-error">{error}</div>}
      {!status ? <div className="control-card empty-state"><span className="spin" /> {t("selfHost.reading")}</div> : (
        <>
          <section className="control-card safety-card host-access-card">
            <div className="card-title-row">
              <div><h2>{t("selfHost.networkAccess")}</h2><p>{t("selfHost.networkIntro")}</p></div>
              {!accessEditing && <button className="btn compact" onClick={editAccess}>{t("selfHost.configure")}</button>}
            </div>

            {!accessEditing ? (
              <>
                <div className="node-runtime-summary">
                  <span><small>{t("selfHost.walletService")}</small><strong>{status.wallet_access === "device" ? t("selfHost.thisDeviceOnly") : status.wallet_access === "lan" ? t("selfHost.lanAuthenticated") : t("selfHost.internetProxy")}</strong></span>
                  <span><small>{t("selfHost.nodeRpc")}</small><strong>{status.node_lan_rpc ? t("selfHost.trustedLan") : t("selfHost.thisDeviceOnly")}</strong></span>
                  <span><small>{t("selfHost.nodeP2p")}</small><strong>{status.node_public_p2p ? t("selfHost.publicTcp", { port: MANAGED_ZKAS_P2P_PORT }) : t("selfHost.outboundOnly")}</strong></span>
                </div>
                {!!status.wallet_access_urls?.length && (
                  <div className="detail-row">
                    <span className="k">{t("selfHost.walletUrls", { count: status.wallet_access_urls.length })}</span>
                    <span className="v mono host-url-list">
                      {status.wallet_access_urls.map((url, index) => <span key={url}>{index === 0 && status.wallet_access_urls.length > 1 ? t("selfHost.urlPreferred", { url }) : url}</span>)}
                    </span>
                  </div>
                )}
                {status.wallet_access !== "device" && (
                  <>
                    {/* Pairing first, because it is the way this is meant to be done.
                        Connecting needs the address, the access token AND the wallet
                        token — and typing the last one wrong does not fail loudly, it
                        opens a different, empty wallet on this machine. One scan
                        carries all three. The raw values stay below for anyone
                        configuring a client by hand. */}
                    {!!pairing && (
                      <div className="pairing-block">
                        <div className="detail-row"><span className="k">{t("selfHost.pairPhone")}</span><span className="v">{t("selfHost.pairNote")}</span></div>
                        {pairingQr && <img className="pairing-qr" src={pairingQr} alt={t("selfHost.pairingAlt")} width={220} height={220} />}
                        <div className="control-actions">
                          <button className="btn ghost compact" onClick={() => void copyPairing()}>{pairingCopied ? t("selfHost.copied") : t("selfHost.copyPairing")}</button>
                        </div>
                        <p className="muted small">
                          {t("selfHost.pairingWarning")}
                        </p>
                      </div>
                    )}
                    {/* A 64-character hex string cannot share a line with its label: as a
                        right-aligned flex cell it either overflowed the card or wrapped
                        into a ragged column. It gets its own full-width block, which is
                        also the only shape you can reliably select and copy by hand. */}
                    <div className="detail-row stacked">
                      <span className="k">{t("selfHost.accessToken")}</span>
                      <span className="v mono host-token">{tokenVisible ? status.wallet_access_token ?? t("selfHost.unavailable") : "•".repeat(32)}</span>
                    </div>
                    <div className="control-actions">
                      <button className="btn ghost compact" onClick={() => setTokenVisible((value) => !value)}>{tokenVisible ? t("selfHost.hideToken") : t("selfHost.showToken")}</button>
                      <button className="btn ghost compact" onClick={() => void copyToken()}>{copied ? t("selfHost.copied") : t("selfHost.copyToken")}</button>
                    </div>
                  </>
                )}
              </>
            ) : (
              <>
                <h3>{t("selfHost.walletServiceHeading")}</h3>
                <div className="choice-row three host-mode-list" role="radiogroup" aria-label={t("selfHost.accessAria")}>
                  <button className={`choice-button ${walletAccess === "device" ? "selected" : ""}`} role="radio" aria-checked={walletAccess === "device"} onClick={() => setWalletAccess("device")}><strong>{t("selfHost.optDevice")}</strong><span>{t("selfHost.optDeviceNote")}</span></button>
                  <button className={`choice-button ${walletAccess === "lan" ? "selected" : ""}`} role="radio" aria-checked={walletAccess === "lan"} onClick={() => setWalletAccess("lan")}><strong>{t("selfHost.optLan")}</strong><span>{t("selfHost.optLanNote")}</span></button>
                  <button className={`choice-button ${walletAccess === "wan" ? "selected" : ""}`} role="radio" aria-checked={walletAccess === "wan"} onClick={() => setWalletAccess("wan")}><strong>{t("selfHost.optWan")}</strong><span>{t("selfHost.optWanNote")}</span></button>
                </div>
                {walletAccess !== "device" && <label className="host-field">{t("selfHost.walletPort")}<input className="control-input" type="number" min={1024} max={65535} value={walletPort} onChange={(event) => setWalletPort(Number(event.target.value))} /></label>}
                {walletAccess === "wan" && <label className="host-field">{t("selfHost.publicUrl")}<input className="control-input mono" type="url" value={publicUrl} onChange={(event) => setPublicUrl(event.target.value)} placeholder="https://wallet.example.com" /></label>}{/* i18n-ignore: example URL */}
                {walletAccess === "lan" && <p className="inline-warning">{t("selfHost.lanFirewall", { port: walletPort })}</p>}
                {walletAccess === "wan" && <p className="inline-warning">{t("selfHost.wanForward")}</p>}

                <h3>{t("selfHost.nodeAccess")}</h3>
                <label className="check-row"><input type="checkbox" checked={nodeLanRpc} onChange={(event) => setNodeLanRpc(event.target.checked)} /><span><strong>{t("selfHost.nodeRpcLan")}</strong><small>{t("selfHost.nodeRpcLanNote", { port: MANAGED_ZKAS_RPC_PORT })}</small></span></label>
                <label className="check-row"><input type="checkbox" checked={nodePublicP2p} onChange={(event) => setNodePublicP2p(event.target.checked)} /><span><strong>{t("selfHost.publicP2p")}</strong><small>{t("selfHost.publicP2pNote", { port: MANAGED_ZKAS_P2P_PORT })}</small></span></label>
                {status.node_running && (nodeLanRpc !== status.node_lan_rpc || nodePublicP2p !== status.node_public_p2p) && <p className="inline-warning">{t("selfHost.stopBeforeApply")}</p>}
                <div className="control-actions">
                  <button className="btn ghost compact" disabled={busy === "access"} onClick={() => setAccessEditing(false)}>{t("selfHost.cancel")}</button>
                  <button className="btn compact" disabled={busy === "access" || (status.node_running && (nodeLanRpc !== status.node_lan_rpc || nodePublicP2p !== status.node_public_p2p))} onClick={() => void saveAccess()}>{busy === "access" ? t("selfHost.applying") : t("selfHost.apply")}</button>
                </div>
              </>
            )}
          </section>

          <div className="selfhost-grid">
            <section className="control-card service-runtime-card">
              <div className="card-title-row"><div><h2>{t("selfHost.walletEngine")}</h2><p>{t("selfHost.walletEngineNote")}</p></div><span className={`status-pill ${status.wallet_engine_running ? "good" : "warm"}`}>{status.wallet_engine_running ? t("selfHost.running") : t("selfHost.stopped")}</span></div>
              <code>{status.wallet_engine_url || t("selfHost.locked")}</code>
              <p className="subtle">{t("selfHost.boundNote")}</p>
            </section>
            <section className="control-card service-runtime-card">
              <div className="card-title-row"><div><h2>{t("selfHost.nodeConnection")}</h2><p>{status.node_mode === "local" ? t("selfHost.nodeLocal") : status.node_mode === "custom" ? t("selfHost.nodeCustom") : t("selfHost.nodePublic")}</p></div><span className="status-pill good">{status.node_mode === "local" ? t("selfHost.modeLocal") : status.node_mode === "custom" ? t("selfHost.modeCustom") : t("selfHost.modeRemote")}</span></div>
              <code>{status.node_rpc}</code>
              <button className="btn ghost compact" onClick={() => navigate("/node")}>{t("selfHost.nodeControls")}</button>
            </section>
            <section className="control-card service-runtime-card">
              <div className="card-title-row"><div><h2>{t("selfHost.explorerApi")}</h2><p>{t("selfHost.explorerNote")}</p></div><span className={`status-pill ${status.explorer_running ? "good" : status.explorer_installed ? "" : "warm"}`}>{status.explorer_running ? t("selfHost.running") : status.explorer_installed ? t("selfHost.stopped") : t("selfHost.notInstalled")}</span></div>
              <code>{status.explorer_url}</code>
              {/* Opening this in a browser returns 404, because the service answers
                  /info/… and /blocks/… and has no page at the root. Saying so here is
                  the difference between "healthy" and "apparently broken". */}
              <p className="subtle"><Trans i18nKey="selfHost.dataApiNote" values={{ url: status.explorer_url }} components={{ code: <code /> }} /></p>
              {status.explorer_last_exit && (
                <div className="inline-warning">
                  {t("selfHost.lastExit", { exit: status.explorer_last_exit })}
                  {/* An exit code alone sent people hunting. The overwhelmingly common
                      cause is that the port was already taken by a copy still running,
                      which ALSO answers the wallet — so the service looks broken and
                      working at once. */}
                </div>
              )}
              <div className="control-actions">
                {!status.explorer_installed ? <button className="btn compact" disabled={!!busy} onClick={() => void installExplorer()}>{busy === "install" ? t("selfHost.downloading") : t("selfHost.installBackend")}</button> : <button className="btn compact" disabled={!!busy} onClick={() => void toggleExplorer()}>{busy === "explorer" ? t("selfHost.working") : status.explorer_running ? t("selfHost.stop") : t("selfHost.start")}</button>}
                {status.explorer_running && <button className="btn ghost compact" onClick={() => navigate("/explore")}>{t("selfHost.openExplorer")}</button>}
              </div>
            </section>
            {/* The payment gateway card lived here to explain why the app would not
                one-click install it: there is no signed, hashed gateway release to
                verify. That is a true statement and a useless one on a screen for
                controlling services that ARE running — a permanently inert card whose
                only action was a link to build instructions. It belongs in the Services
                directory with the rest of the ecosystem, not in local service control.
                Put it back here when a pinned, digest-verified binary exists. */}
          </div>

          <section className="control-card">
            <h2>{t("selfHost.dataBackup")}</h2>
            <p>{t("selfHost.dataBackupNote")}</p>
            <div className="detail-row"><span className="k">{t("selfHost.appData")}</span><span className="v mono">{status.data_dir}</span></div>
            <div className="detail-row"><span className="k">{t("selfHost.walletBackups")}</span><span className="v mono">{status.backup_dir}</span></div>
            <div className="control-actions"><button className="btn ghost compact" onClick={() => void openPath(status.data_dir)}>{t("selfHost.openAppData")}</button><button className="btn ghost compact" onClick={() => void openPath(status.backup_dir)}>{t("selfHost.openBackups")}</button><button className="btn compact" onClick={() => navigate("/")}>{t("selfHost.backUpWallet")}</button></div>
          </section>


          <section className="control-card safety-card">
            <div className="card-title-row">
              <div><h2>{t("selfHost.desktopStartup")}</h2><p>{t("selfHost.startupNote")}</p></div>
              <label className="switch-row"><input type="checkbox" checked={status.autostart_enabled} disabled={busy === "autostart"} onChange={(event) => void setAutostart(event.target.checked)} /><span>{t("selfHost.startOnBoot")}</span></label>
            </div>
            <p className="subtle">{t("selfHost.trayNote")}</p>
          </section>
        </>
      )}
    </main>
  );
}
