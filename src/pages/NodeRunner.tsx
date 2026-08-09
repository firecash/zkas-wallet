import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Archive, Database, Pickaxe, X } from "lucide-react";
import { initDesktop, isDesktop, setNodeSource } from "../desktop";
import { ServiceLogsDialog } from "../components/ServiceLogsDialog";
import {
  desktopServices,
  type ControlConfig,
  type DownloadProgress,
  type NodeStatus,
  type WalletdStatus,
} from "../desktop-services";

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
  if (preset === "mining") return "Mining";
  if (preset === "archival") return "Archive";
  if (preset === "shielded") return "Shielded history";
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
          <div><span className="eyebrow">Local node</span><h2 id="node-start-title">Choose how to run it</h2></div>
          <button className="dialog-close" aria-label="Close node setup" title="Close" disabled={busy} onClick={onClose}><X size={19} /></button>
        </header>

        <div className="node-mode-list" role="radiogroup" aria-label="Node mode">
          <button className={`node-mode-option ${preset === "mining" ? "selected" : ""}`} role="radio" aria-checked={preset === "mining"} autoFocus onClick={() => onPreset("mining")}>
            <span className="node-mode-icon"><Pickaxe size={20} /></span>
            <span><strong>Mining</strong><small>Smallest. Validates the chain and serves miners, but does not keep old wallet notes.</small></span>
            <i aria-hidden="true" />
          </button>
          <button className={`node-mode-option ${preset === "shielded" ? "selected" : ""}`} role="radio" aria-checked={preset === "shielded"} onClick={() => onPreset("shielded")}>
            <span className="node-mode-icon"><Database size={20} /></span>
            <span><strong>Shielded history</strong><small>Keeps complete wallet history while pruning old full block bodies.</small></span>
            <i aria-hidden="true" />
          </button>
          <button className={`node-mode-option ${preset === "archival" ? "selected" : ""}`} role="radio" aria-checked={preset === "archival"} onClick={() => onPreset("archival")}>
            <span className="node-mode-icon"><Archive size={20} /></span>
            <span><strong>Archive</strong><small>Keeps complete wallet history and every block body. Uses the most disk.</small></span>
            <i aria-hidden="true" />
          </button>
        </div>

        <label className="check-row node-public-toggle">
          <input type="checkbox" checked={publicP2p} onChange={(event) => onPublicP2p(event.target.checked)} />
          <span><strong>Accept inbound peers</strong><small>Optional. Other nodes can connect to this computer on TCP port 16811.</small></span>
        </label>

        <div className={`node-network-note ${publicP2p ? "public" : "private"}`}>
          <strong>{publicP2p ? "Firewall setup" : "No firewall changes needed"}</strong>
          <span>{publicP2p
            ? "Allow inbound TCP 16811 in the operating-system firewall. If this machine is behind a router, forward 16811 only if you want public inbound peers."
            : "The node makes outbound peer connections and will sync normally. Its P2P listener stays on this device."}</span>
          <small>RPC always stays private at 127.0.0.1:16810. Never expose that port to the internet.</small>
        </div>

        {miningConflict && <div className="dialog-inline-error">This wallet currently uses the local node. Switch the wallet to its public service before running the history-free Mining mode.</div>}
        {error && <div className="dialog-inline-error">{error}</div>}
        {dataDir && <p className="node-data-path">Chain data: <code>{dataDir}/node</code></p>}

        <footer className="service-dialog-footer">
          <button className="btn ghost" disabled={busy} onClick={onClose}>Cancel</button>
          <button className="btn" disabled={busy || miningConflict} onClick={onRun}>{busy ? "Starting…" : "Run node"}</button>
        </footer>
      </section>
    </div>,
    document.body,
  );
}

export function NodeRunner() {
  const desktop = isDesktop();
  const [config, setConfig] = useState<ControlConfig | null>(null);
  const [node, setNode] = useState<NodeStatus | null>(null);
  const [walletd, setWalletd] = useState<WalletdStatus | null>(null);
  const [showLogs, setShowLogs] = useState(false);
  const [showStart, setShowStart] = useState(false);
  const [busy, setBusy] = useState<"install" | "start" | "stop" | "attach" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [progress, setProgress] = useState<DownloadProgress | null>(null);
  const [preset, setPreset] = useState<NodePreset>("mining");
  const [publicP2p, setPublicP2p] = useState(false);
  const refreshInFlight = useRef(false);
  const closeStartDialog = useCallback(() => setShowStart(false), []);
  const closeLogsDialog = useCallback(() => setShowLogs(false), []);

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
    if (!node) return "Checking…";
    if (!node.running) return "Stopped";
    if (node.is_synced === true) return "Synced";
    if (node.sync_progress != null) return `Syncing · ${node.sync_progress.toFixed(1)}%`;
    return "Starting…";
  }, [node]);

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
        <header className="control-heading"><div><span className="eyebrow">Node</span><h1>Run ZKAS yourself</h1></div></header>
        <section className="control-card empty-state">
          <h2>Desktop app required</h2>
          <p>A phone or browser cannot safely keep a full node running. The wallet still works through its selected node.</p>
        </section>
      </main>
    );
  }

  const installed = !!config?.components.zkas_node;
  const updateAvailable = !!config?.components.zkas_node_update_available;
  const downloadPercent = progress?.total ? Math.round((progress.received / progress.total) * 100) : null;

  return (
    <main className="control-page">
      <header className="control-heading">
        <div><span className="eyebrow">Node</span><h1>Your ZKAS node</h1><p>Private wallet access and direct mining, managed by this app.</p></div>
        <span className={`status-pill ${node?.running ? node.is_synced ? "good" : "warm" : "off"}`}>{syncLabel}</span>
      </header>

      {error && <div className="control-error">{error}</div>}

      {!installed && (
        <section className="control-card install-card">
          <div><span className="step-number">1</span><h2>Install node software</h2><p>The verified ZKAS release is downloaded into the app's private data folder.</p></div>
          <button className="btn" disabled={busy !== null} onClick={() => run("install", () => desktopServices.install({ zkas: true, bridge: false, kaspa: false }))}>
            {busy === "install" ? progress ? `${progress.phase}${downloadPercent != null ? ` · ${downloadPercent}%` : ""}` : "Preparing…" : "Install ZKAS node"}
          </button>
        </section>
      )}

      {installed && updateAvailable && (
        <section className="control-card install-card node-update-card">
          <div><h2>Node update available</h2><p>{config?.zkas_release} fixes fresh-node synchronization and shielded-history transfer.</p></div>
          <button className="btn" disabled={busy !== null || !!node?.running} onClick={() => run("install", () => desktopServices.install({ zkas: true, bridge: false, kaspa: false }))}>
            {node?.running
              ? "Stop node to update"
              : busy === "install"
                ? progress ? `${progress.phase}${downloadPercent != null ? ` · ${downloadPercent}%` : ""}` : "Preparing…"
                : `Update to ${config?.zkas_release ?? "latest"}`}
          </button>
        </section>
      )}

      <section className="control-card">
        <div className="card-title-row">
          <div><span className="step-number">{installed ? "1" : "2"}</span><h2>Node</h2><p className="mono subtle">{node?.rpc_addr ?? "127.0.0.1:16810"}</p></div>
          <span className={`status-dot ${node?.running ? "on" : ""}`} aria-label={node?.running ? "running" : "stopped"} />
        </div>
        <div className="metric-grid">
          <Metric label="Blocks" value={formatCount(node?.block_count ?? null)} />
          <Metric label="DAA score" value={formatCount(node?.daa_score ?? null)} />
          <Metric label="Peers" value={formatCount(node?.peer_count ?? null)} />
          <Metric label="Mempool" value={formatCount(node?.mempool_size ?? null)} />
          <Metric label="Chain data" value={formatBytes(node?.disk_bytes ?? 0)} />
          <Metric label="Process" value={node?.pid ? `PID ${node.pid}` : "—"} />
        </div>
        <div className="node-runtime-summary">
          <span><small>Mode</small><strong>{presetLabel(config?.settings.node_preset)}</strong></span>
          <span><small>Peer access</small><strong>{config?.settings.node_public_p2p ? "Public · TCP 16811" : "Outbound only"}</strong></span>
          <span><small>RPC</small><strong>Private · 127.0.0.1:16810</strong></span>
        </div>
        {node?.error && node.running && <p className="inline-warning">The process is running but RPC is not ready yet: {node.error}</p>}
        {!node?.running && node?.last_exit && <p className="inline-warning">Last run: {node.last_exit}</p>}
        <div className="control-actions">
          <button className="btn" disabled={!installed || busy !== null || !!node?.running} onClick={openStartDialog}>
            Run node
          </button>
          <button className="btn ghost" disabled={busy !== null || !node?.running || !node.managed} onClick={() => run("stop", async () => { await desktopServices.stopNode(); await initDesktop(); location.reload(); })}>
            {busy === "stop" ? "Stopping…" : "Stop"}
          </button>
          <button className="btn ghost" onClick={() => setShowLogs(true)}>View logs</button>
        </div>
      </section>

      <section className="control-card compact-card">
        <div className="card-title-row"><div><h2>Wallet connection</h2><p>The wallet is separate from the node process above.</p></div><span className={`status-pill ${walletd?.running && walletd.node_connected ? "good" : "off"}`}>{walletd?.node_source === "local" ? "Local node" : walletd?.node_source === "custom" ? "My node" : "Public node"}</span></div>
        <div className="metric-grid three">
          <Metric label="Wallet scan" value={walletd?.scanning_progress == null ? "—" : `${walletd.scanning_progress.toFixed(1)}%`} />
          <Metric label="Balance" value={walletd?.balance == null ? "—" : `${walletd.balance} ZKAS`} />
          <Metric label="RPC" value={walletd?.node_rpc ?? "—"} />
        </div>
        <div className="control-actions">
          {walletd?.node_source !== "local" && config?.settings.node_preset !== "mining" && node?.is_synced === true && (
            <button className="btn" disabled={busy !== null} onClick={() => run("attach", async () => { await setNodeSource("local"); location.reload(); })}>{busy === "attach" ? "Connecting…" : "Use this node for wallet"}</button>
          )}
          {walletd?.node_source === "local" && (
            <button className="btn ghost" disabled={busy !== null} onClick={() => run("attach", async () => { await setNodeSource("remote"); location.reload(); })}>Use public node</button>
          )}
        </div>
        {node?.running && node.is_synced !== true && <p className="inline-warning">Local node is syncing. Your wallet stays on {walletd?.node_source === "custom" ? "your existing node" : "the public node"} with its current balance until the local node is complete.</p>}
        {config?.settings.node_preset === "mining" && <p className="inline-warning">Mining mode is never offered to the wallet because it does not retain complete historical notes.</p>}
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
      <ServiceLogsDialog open={showLogs} onClose={closeLogsDialog} service="zkas-node" title="ZKAS node logs" />
    </main>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return <div className="metric"><span>{label}</span><strong>{value}</strong></div>;
}
