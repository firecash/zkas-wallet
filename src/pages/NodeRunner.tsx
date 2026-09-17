import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Archive, Database, Pickaxe, X } from "lucide-react";
import { Trans, useTranslation } from "react-i18next";
import i18n from "../i18n";
import { initDesktop, isDesktop, setNodeSource } from "../desktop";
import { ServiceLogsDialog } from "../components/ServiceLogsDialog";
import {
  desktopServices,
  type ControlConfig,
  type DownloadProgress,
  type NodeStatus,
  type WalletdStatus,
} from "../desktop-services";
import { MANAGED_ZKAS_P2P_PORT, MANAGED_ZKAS_RPC, MANAGED_ZKAS_RPC_PORT } from "../ports";

type NodePreset = "shielded" | "archival" | "mining";

function formatBytes(value: number): string {
  if (!value) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  const index = Math.min(units.length - 1, Math.floor(Math.log(value) / Math.log(1024)));
  return `${(value / 1024 ** index).toFixed(index > 2 ? 1 : 0)} ${units[index]}`;
}

function formatCount(value: number | null): string {
  return value == null ? "—" : value.toLocaleString();
}

function presetLabel(preset: NodePreset | undefined): string {
  if (preset === "mining") return i18n.t("nodeRunner.presetMining");
  if (preset === "archival") return i18n.t("nodeRunner.presetArchival");
  if (preset === "shielded") return i18n.t("nodeRunner.presetShielded");
  return "—";
}

function NodeStartDialog({
  open,
  preset,
  publicP2p,
  walletUsesLocal,
  dataDir,
  busy,
  error,
  onPreset,
  onPublicP2p,
  onClose,
  onRun,
}: {
  open: boolean;
  preset: NodePreset;
  publicP2p: boolean;
  walletUsesLocal: boolean;
  dataDir: string | undefined;
  busy: boolean;
  error: string | null;
  onPreset: (preset: NodePreset) => void;
  onPublicP2p: (enabled: boolean) => void;
  onClose: () => void;
  onRun: () => void;
}) {
  const { t } = useTranslation();
  useEffect(() => {
    if (!open) return;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !busy) onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => {
      document.body.style.overflow = previousOverflow;
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [busy, onClose, open]);

  if (!open) return null;
  const miningConflict = preset === "mining" && walletUsesLocal;

  return createPortal(
    <div className="service-dialog-backdrop" role="presentation" onMouseDown={(event) => {
      if (event.target === event.currentTarget && !busy) onClose();
    }}>
      <section className="service-dialog node-start-dialog" role="dialog" aria-modal="true" aria-labelledby="node-start-title">
        <header className="service-dialog-header">
          <div><span className="eyebrow">{t("nodeStartDialog.eyebrow")}</span><h2 id="node-start-title">{t("nodeStartDialog.title")}</h2></div>
          <button className="dialog-close" aria-label={t("nodeStartDialog.closeAria")} title={t("nodeStartDialog.closeTitle")} disabled={busy} onClick={onClose}><X size={19} /></button>
        </header>

        <div className="node-mode-list" role="radiogroup" aria-label={t("nodeStartDialog.modeAria")}>
          <button className={`node-mode-option ${preset === "mining" ? "selected" : ""}`} role="radio" aria-checked={preset === "mining"} autoFocus onClick={() => onPreset("mining")}>
            <span className="node-mode-icon"><Pickaxe size={20} /></span>
            <span><strong>{t("nodeStartDialog.mining")}</strong><small>{t("nodeStartDialog.miningNote")}</small></span>
            <i aria-hidden="true" />
          </button>
          <button className={`node-mode-option ${preset === "shielded" ? "selected" : ""}`} role="radio" aria-checked={preset === "shielded"} onClick={() => onPreset("shielded")}>
            <span className="node-mode-icon"><Database size={20} /></span>
            <span><strong>{t("nodeStartDialog.shielded")}</strong><small>{t("nodeStartDialog.shieldedNote")}</small></span>
            <i aria-hidden="true" />
          </button>
          <button className={`node-mode-option ${preset === "archival" ? "selected" : ""}`} role="radio" aria-checked={preset === "archival"} onClick={() => onPreset("archival")}>
            <span className="node-mode-icon"><Archive size={20} /></span>
            <span><strong>{t("nodeStartDialog.archive")}</strong><small>{t("nodeStartDialog.archiveNote")}</small></span>
            <i aria-hidden="true" />
          </button>
        </div>

        <label className="check-row node-public-toggle">
          <input type="checkbox" checked={publicP2p} onChange={(event) => onPublicP2p(event.target.checked)} />
          <span><strong>{t("nodeStartDialog.inbound")}</strong><small>{t("nodeStartDialog.inboundNote", { port: MANAGED_ZKAS_P2P_PORT })}</small></span>
        </label>

        <div className={`node-network-note ${publicP2p ? "public" : "private"}`}>
          <strong>{publicP2p ? t("nodeStartDialog.firewallSetup") : t("nodeStartDialog.noFirewall")}</strong>
          <span>{publicP2p
            ? t("nodeStartDialog.firewallPublic", { port: MANAGED_ZKAS_P2P_PORT })
            : t("nodeStartDialog.firewallPrivate")}</span>
          <small>{t("nodeStartDialog.rpcPrivate", { port: MANAGED_ZKAS_RPC_PORT })}</small>
        </div>

        {miningConflict && <div className="dialog-inline-error">{t("nodeStartDialog.miningConflict")}</div>}
        {error && <div className="dialog-inline-error">{error}</div>}
        {dataDir && <p className="node-data-path"><Trans i18nKey="nodeStartDialog.chainData" values={{ dir: dataDir }} components={{ code: <code /> }} /></p>}

        <footer className="service-dialog-footer">
          <button className="btn ghost" disabled={busy} onClick={onClose}>{t("nodeStartDialog.cancel")}</button>
          <button className="btn" disabled={busy || miningConflict} onClick={onRun}>{busy ? t("nodeStartDialog.starting") : t("nodeStartDialog.runNode")}</button>
        </footer>
      </section>
    </div>,
    document.body,
  );
}

export function NodeRunner() {
  const { t } = useTranslation();
  const desktop = isDesktop();
  const [config, setConfig] = useState<ControlConfig | null>(null);
  const [node, setNode] = useState<NodeStatus | null>(null);
  const [walletd, setWalletd] = useState<WalletdStatus | null>(null);
  const [logService, setLogService] = useState<"zkas-node" | "wallet-engine" | null>(null);
  const [showStart, setShowStart] = useState(false);
  const [busy, setBusy] = useState<"install" | "start" | "stop" | "attach" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [progress, setProgress] = useState<DownloadProgress | null>(null);
  const [preset, setPreset] = useState<NodePreset>("mining");
  const [publicP2p, setPublicP2p] = useState(false);
  const refreshInFlight = useRef(false);
  const closeStartDialog = useCallback(() => setShowStart(false), []);
  const closeLogsDialog = useCallback(() => setLogService(null), []);

  const refresh = useCallback(async () => {
    if (!desktop || refreshInFlight.current) return;
    refreshInFlight.current = true;
    try {
      const [nextConfig, nextNode, nextWalletd] = await Promise.all([
        desktopServices.config(),
        desktopServices.nodeStatus(),
        desktopServices.walletdStatus(),
      ]);
      setConfig(nextConfig);
      setNode(nextNode);
      setWalletd(nextWalletd);
    } finally {
      refreshInFlight.current = false;
    }
  }, [desktop]);

  useEffect(() => {
    if (!desktop) return;
    let alive = true;
    refresh().catch((e) => alive && setError(e.message));
    const timer = window.setInterval(() => refresh().catch(() => undefined), 3_000);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, [desktop, refresh]);

  // Default the run-mode dialog to the node's LAST-USED mode, not a hardcoded
  // "Mining" (which keeps no wallet notes). A wallet user who ran the node in
  // "Shielded history" was made to re-pick it on every launch (#3).
  useEffect(() => {
    if (showStart && config?.settings.node_preset) setPreset(config.settings.node_preset);
  }, [showStart, config?.settings.node_preset]);

  useEffect(() => {
    if (!desktop) return;
    let alive = true;
    let unlisten: (() => void)[] = [];
    void (async () => {
      const { listen } = await import("@tauri-apps/api/event");
      const listeners = [
        await listen<DownloadProgress>("download-progress", ({ payload }) => setProgress(payload)),
        await listen("service-state", () => refresh().catch(() => undefined)),
      ];
      if (alive) unlisten = listeners;
      else listeners.forEach((stop) => stop());
    })().catch(() => undefined);
    return () => {
      alive = false;
      unlisten.forEach((stop) => stop());
    };
  }, [desktop, refresh]);

  const syncLabel = useMemo(() => {
    if (!node) return t("nodeRunner.checking");
    if (!node.running) return t("nodeRunner.stopped");
    // A node still filling in shielded history from peers is not done from the wallet's
    // point of view: on a first sync the block count does not move for the whole backfill
    // (bodies wait for it), so a bare percentage reads as a stuck sync.
    const filling = node.history_complete === false;
    const fillingLabel = node.history_from_daa != null ? t("nodeRunner.fillingFrom", { daa: node.history_from_daa.toLocaleString() }) : t("nodeRunner.filling");
    if (node.is_synced === true) return filling ? fillingLabel : t("nodeRunner.synced");
    if (node.sync_progress != null) return filling ? t("nodeRunner.syncingPctFilling", { pct: node.sync_progress.toFixed(1) }) : t("nodeRunner.syncingPct", { pct: node.sync_progress.toFixed(1) });
    return filling ? fillingLabel : t("nodeRunner.starting");
  }, [node, t]);
  // `false` gates the attach; unknown (older backend / node did not answer) keeps
  // today's behaviour of trusting `is_synced` alone.
  const fillingHistory = node?.running === true && node.history_complete === false;

  const run = async (name: typeof busy, task: () => Promise<unknown>): Promise<boolean> => {
    setBusy(name);
    setError(null);
    try {
      await task();
      await refresh();
      return true;
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      return false;
    } finally {
      setBusy(null);
    }
  };

  const openStartDialog = () => {
    // Starting is an explicit choice each time. Mining is the requested safe
    // default for a standalone node; a user who wants wallet history opts in.
    setPreset("mining");
    setPublicP2p(config?.settings.node_public_p2p ?? false);
    setError(null);
    setShowStart(true);
  };

  const startNode = async () => {
    const started = await run("start", () => desktopServices.startNode(preset, publicP2p));
    if (started) setShowStart(false);
  };

  if (!desktop) {
    return (
      <main className="control-page">
        <header className="control-heading"><div><span className="eyebrow">{t("nodeRunner.webEyebrow")}</span><h1>{t("nodeRunner.webTitle")}</h1></div></header>
        <section className="control-card empty-state">
          <h2>{t("nodeRunner.webRequired")}</h2>
          <p>{t("nodeRunner.webNote")}</p>
        </section>
      </main>
    );
  }

  const installed = !!config?.components.zkas_node;
  const updateAvailable = !!config?.components.zkas_node_update_available;
  const downloadPercent = progress?.total ? Math.round((progress.received / progress.total) * 100) : null;
  const walletSource = walletd?.node_source === "local" ? t("nodeRunner.sourceLocal") : walletd?.node_source === "custom" ? t("nodeRunner.sourceCustom") : t("nodeRunner.sourcePublic");
  const walletConnectionLabel = walletd?.node_connected === false ? t("nodeRunner.reconnecting", { source: walletSource }) : walletSource;

  return (
    <main className="control-page">
      <header className="control-heading">
        <div><span className="eyebrow">{t("nodeRunner.eyebrow")}</span><h1>{t("nodeRunner.title")}</h1><p>{t("nodeRunner.intro")}</p></div>
        <span className={`status-pill ${node?.running ? node.is_synced ? "good" : "warm" : "off"}`}>{syncLabel}</span>
      </header>

      {error && <div className="control-error">{error}</div>}

      {!installed && (
        <section className="control-card install-card">
          <div><span className="step-number">1</span><h2>{t("nodeRunner.installTitle")}</h2><p>{t("nodeRunner.installNote")}</p></div>
          <button className="btn" disabled={busy !== null} onClick={() => run("install", () => desktopServices.install({ zkas: true, bridge: false, kaspa: false }))}>
            {busy === "install" ? progress ? downloadPercent != null ? t("nodeRunner.phasePercent", { phase: progress.phase, pct: downloadPercent }) : progress.phase : t("nodeRunner.preparing") : t("nodeRunner.installNode")}
          </button>
        </section>
      )}

      {installed && updateAvailable && (
        <section className="control-card install-card node-update-card">
          <div><h2>{t("nodeRunner.updateTitle")}</h2><p>{t("nodeRunner.updateNote", { release: config?.zkas_release })}</p></div>
          <button className="btn" disabled={busy !== null || !!node?.running} onClick={() => run("install", () => desktopServices.install({ zkas: true, bridge: false, kaspa: false }))}>
            {node?.running
              ? t("nodeRunner.stopToUpdate")
              : busy === "install"
                ? progress ? downloadPercent != null ? t("nodeRunner.phasePercent", { phase: progress.phase, pct: downloadPercent }) : progress.phase : t("nodeRunner.preparing")
                : t("nodeRunner.updateTo", { version: config?.zkas_release ?? t("nodeRunner.latest") })}
          </button>
        </section>
      )}

      <section className="control-card">
        <div className="card-title-row">
          <div><span className="step-number">{installed ? "1" : "2"}</span><h2>{t("nodeRunner.nodeHeading")}</h2><p className="mono subtle">{node?.rpc_addr ?? MANAGED_ZKAS_RPC}</p></div>
          <span className={`status-dot ${node?.running ? "on" : ""}`} aria-label={node?.running ? t("nodeRunner.ariaRunning") : t("nodeRunner.ariaStopped")} />
        </div>
        <div className="metric-grid">
          <Metric label={t("nodeRunner.metricBlocks")} value={formatCount(node?.block_count ?? null)} />
          <Metric label={t("nodeRunner.metricDaa")} value={formatCount(node?.daa_score ?? null)} />
          <Metric label={t("nodeRunner.metricPeers")} value={formatCount(node?.peer_count ?? null)} />
          <Metric label={t("nodeRunner.metricMempool")} value={formatCount(node?.mempool_size ?? null)} />
          <Metric label={t("nodeRunner.metricChainData")} value={formatBytes(node?.disk_bytes ?? 0)} />
          <Metric label={t("nodeRunner.metricProcess")} value={node?.pid ? t("nodeRunner.pid", { pid: node.pid }) : "—"} />
        </div>
        <div className="node-runtime-summary">
          <span><small>{t("nodeRunner.mode")}</small><strong>{presetLabel(config?.settings.node_preset)}</strong></span>
          <span><small>{t("nodeRunner.peerAccess")}</small><strong>{config?.settings.node_public_p2p ? t("nodeRunner.publicTcp", { port: MANAGED_ZKAS_P2P_PORT }) : t("nodeRunner.outboundOnly")}</strong></span>
          <span><small>{t("nodeRunner.rpc")}</small><strong>{config?.settings.node_lan_rpc ? t("nodeRunner.trustedLan", { port: MANAGED_ZKAS_RPC_PORT }) : t("nodeRunner.privateRpc", { addr: MANAGED_ZKAS_RPC })}</strong></span>
        </div>
        {node?.error && node.running && <p className="inline-warning">{t("nodeRunner.rpcNotReady", { error: node.error })}</p>}
        {!node?.running && node?.last_exit && <p className="inline-warning">{t("nodeRunner.lastRun", { exit: node.last_exit })}</p>}
        <div className="control-actions">
          <button className="btn" disabled={!installed || updateAvailable || busy !== null || !!node?.running} onClick={openStartDialog}>
            {updateAvailable ? t("nodeRunner.updateBeforeRunning") : t("nodeRunner.runNode")}
          </button>
          <button className="btn ghost" disabled={busy !== null || !node?.running || !node.managed} onClick={() => run("stop", async () => { await desktopServices.stopNode(); await initDesktop(); location.reload(); })}>
            {busy === "stop" ? t("nodeRunner.stopping") : t("nodeRunner.stop")}
          </button>
          <button className="btn ghost" onClick={() => setLogService("zkas-node")}>{t("nodeRunner.viewNodeLogs")}</button>
        </div>
      </section>

      <section className="control-card compact-card">
        <div className="card-title-row"><div><h2>{t("nodeRunner.walletConnection")}</h2><p>{t("nodeRunner.walletSeparate")}</p></div><span className={`status-pill ${walletd?.running && walletd.node_connected ? "good" : "off"}`}>{walletConnectionLabel}</span></div>
        <div className="metric-grid three">
          <Metric label={t("nodeRunner.metricWalletScan")} value={walletd?.scanning_progress == null ? "—" : `${walletd.scanning_progress.toFixed(1)}%`} />
          <Metric label={t("nodeRunner.metricBalance")} value={walletd?.balance == null ? "—" : t("nodeRunner.balanceZkas", { balance: walletd.balance })} />
          <Metric label={t("nodeRunner.metricRpc")} value={walletd?.node_rpc ?? "—"} />
        </div>
        <div className="control-actions">
          {walletd?.node_source !== "local" && config?.settings.node_preset !== "mining" && node?.is_synced === true && !fillingHistory && (
            <button className="btn" disabled={busy !== null} onClick={() => run("attach", async () => { await setNodeSource("local"); location.reload(); })}>{busy === "attach" ? t("nodeRunner.connecting") : t("nodeRunner.useThisNode")}</button>
          )}
          {walletd?.node_source === "local" && (
            <button className="btn ghost" disabled={busy !== null} onClick={() => run("attach", async () => { await setNodeSource("remote"); location.reload(); })}>{t("nodeRunner.usePublicNode")}</button>
          )}
          <button className="btn ghost" onClick={() => setLogService("wallet-engine")}>{t("nodeRunner.viewWalletLogs")}</button>
        </div>
        {node?.running && node.is_synced !== true && !fillingHistory && <p className="inline-warning">{t("nodeRunner.localSyncing", { source: walletd?.node_source === "custom" ? t("nodeRunner.yourExistingNode") : t("nodeRunner.thePublicNode") })}</p>}
        {fillingHistory && (
          <p className="inline-warning">
            {node?.is_synced === true
              ? t("nodeRunner.fillingSynced", {
                from: node?.history_from_daa != null ? t("nodeRunner.currentlyFromDaa", { daa: node.history_from_daa.toLocaleString() }) : "",
                source: walletd?.node_source === "custom" ? t("nodeRunner.yourExistingNode") : t("nodeRunner.thePublicNode"),
              })
              : t("nodeRunner.fillingSyncing", {
                from: node?.history_from_daa != null ? t("nodeRunner.currentlyFromDaa", { daa: node.history_from_daa.toLocaleString() }) : "",
                source: walletd?.node_source === "custom" ? t("nodeRunner.yourExistingNode") : t("nodeRunner.thePublicNode"),
              })}
          </p>
        )}
        {walletd?.running && walletd.node_connected === false && <p className="inline-warning">{t("nodeRunner.walletNotAnswering")}</p>}
        {walletd?.error && <p className="inline-warning">{t("nodeRunner.walletEngineError", { error: walletd.error })}</p>}
        {config?.settings.node_preset === "mining" && <p className="inline-warning">{t("nodeRunner.miningNeverOffered")}</p>}
      </section>

      <NodeStartDialog
        open={showStart}
        preset={preset}
        publicP2p={publicP2p}
        walletUsesLocal={walletd?.node_source === "local"}
        dataDir={config?.data_dir}
        busy={busy === "start"}
        error={showStart ? error : null}
        onPreset={setPreset}
        onPublicP2p={setPublicP2p}
        onClose={closeStartDialog}
        onRun={() => void startNode()}
      />
      <ServiceLogsDialog
        open={logService !== null}
        onClose={closeLogsDialog}
        service={logService ?? "wallet-engine"}
        title={logService === "zkas-node" ? t("nodeRunner.nodeLogsTitle") : t("nodeRunner.walletLogsTitle")}
      />
    </main>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return <div className="metric"><span>{label}</span><strong>{value}</strong></div>;
}
