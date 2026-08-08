import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { initDesktop, isDesktop, setNodeSource } from "../desktop";
import { ServiceLogs } from "../components/ServiceLogs";
import {
  desktopServices,
  type ControlConfig,
  type DownloadProgress,
  type NodeStatus,
  type ServiceLog,
  type WalletdStatus,
} from "../desktop-services";

function formatBytes(value: number): string {
  if (!value) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  const index = Math.min(units.length - 1, Math.floor(Math.log(value) / Math.log(1024)));
  return `${(value / 1024 ** index).toFixed(index > 2 ? 1 : 0)} ${units[index]}`;
}

function formatCount(value: number | null): string {
  return value == null ? "—" : value.toLocaleString();
}

export function NodeRunner() {
  const desktop = isDesktop();
  const [config, setConfig] = useState<ControlConfig | null>(null);
  const [node, setNode] = useState<NodeStatus | null>(null);
  const [walletd, setWalletd] = useState<WalletdStatus | null>(null);
  const [logs, setLogs] = useState<ServiceLog[]>([]);
  const [showLogs, setShowLogs] = useState(false);
  const [busy, setBusy] = useState<"install" | "start" | "stop" | "attach" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [progress, setProgress] = useState<DownloadProgress | null>(null);
  const [preset, setPreset] = useState<"shielded" | "archival" | "mining">("shielded");
  const [publicP2p, setPublicP2p] = useState(false);
  const [optionsHydrated, setOptionsHydrated] = useState(false);
  const refreshInFlight = useRef(false);

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
    if (!config || optionsHydrated) return;
    setPreset(config.settings.node_preset);
    setPublicP2p(config.settings.node_public_p2p);
    setOptionsHydrated(true);
  }, [config, optionsHydrated]);

  useEffect(() => {
    if (!desktop) return;
    let unlisten: (() => void)[] = [];
    void (async () => {
      const { listen } = await import("@tauri-apps/api/event");
      unlisten = [
        await listen<ServiceLog>("service-log", ({ payload }) => {
          setLogs((old) => [...old.slice(-1_999), payload]);
        }),
        await listen<DownloadProgress>("download-progress", ({ payload }) => setProgress(payload)),
        await listen("service-state", () => refresh().catch(() => undefined)),
      ];
    })();
    return () => unlisten.forEach((fn) => fn());
  }, [desktop, refresh]);

  useEffect(() => {
    if (!showLogs || !desktop) return;
    desktopServices.logs(undefined, 1_500).then(setLogs).catch(() => undefined);
  }, [desktop, showLogs]);

  const syncLabel = useMemo(() => {
    if (!node) return "Checking…";
    if (!node.running) return "Stopped";
    if (node.is_synced === true) return "Synced";
    if (node.sync_progress != null) return `Syncing · ${node.sync_progress.toFixed(1)}%`;
    return "Starting…";
  }, [node]);

  const run = async (name: typeof busy, task: () => Promise<unknown>) => {
    setBusy(name);
    setError(null);
    try {
      await task();
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
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
        {node?.error && node.running && <p className="inline-warning">The process is running but RPC is not ready yet: {node.error}</p>}
        {!node?.running && node?.last_exit && <p className="inline-warning">Last run: {node.last_exit}</p>}
        <div className="control-actions">
          <button className="btn" disabled={!installed || busy !== null || !!node?.running} onClick={() => run("start", () => desktopServices.startNode(preset, publicP2p))}>
            {busy === "start" ? "Starting…" : "Start local node"}
          </button>
          <button className="btn ghost" disabled={busy !== null || !node?.running || !node.managed} onClick={() => run("stop", async () => { await desktopServices.stopNode(); await initDesktop(); location.reload(); })}>
            {busy === "stop" ? "Stopping…" : "Stop"}
          </button>
          <button className="btn ghost" onClick={() => setShowLogs((v) => !v)}>{showLogs ? "Hide logs" : "View logs"}</button>
        </div>
      </section>

      <section className="control-card">
        <h2>Storage</h2>
        <div className="choice-row three node-presets">
          <button className={`choice-button ${preset === "shielded" ? "selected" : ""}`} onClick={() => setPreset("shielded")} disabled={!!node?.running}>
            <strong>Shielded history</strong><span>Recommended · full wallet history, old block bodies pruned</span>
          </button>
          <button className={`choice-button ${preset === "archival" ? "selected" : ""}`} onClick={() => setPreset("archival")} disabled={!!node?.running}>
            <strong>Archive</strong><span>Full wallet history and every block body · highest disk use</span>
          </button>
          <button className={`choice-button ${preset === "mining" ? "selected" : ""}`} onClick={() => setPreset("mining")} disabled={!!node?.running || walletd?.node_source === "local"}>
            <strong>Mining only</strong><span>Smallest · validates and mines, but cannot recover an old wallet balance</span>
          </button>
        </div>
        <label className="check-row"><input type="checkbox" checked={publicP2p} onChange={(e) => setPublicP2p(e.target.checked)} /><span><strong>Accept inbound peers</strong><small>Exposes P2P port 16811 only. RPC stays on this device.</small></span></label>
        <p className="subtle">Starting a node does not interrupt the wallet. It syncs in the background and starts with the app until you press Stop.</p>
        <button className="btn ghost compact" onClick={() => run(null, () => desktopServices.setNodeOptions(publicP2p, preset))}>Save options</button>
        {node?.running && (preset !== config?.settings.node_preset || publicP2p !== config?.settings.node_public_p2p) && <p className="subtle">Restart the node to apply storage or P2P changes.</p>}
      </section>

      <section className="control-card compact-card">
        <div className="card-title-row"><div><h2>Wallet connection</h2><p>The wallet is separate from the node process above.</p></div><span className={`status-pill ${walletd?.running && walletd.node_connected ? "good" : "off"}`}>{walletd?.node_source === "local" ? "Local node" : walletd?.node_source === "custom" ? "My node" : "Public node"}</span></div>
        <div className="metric-grid three">
          <Metric label="Wallet scan" value={walletd?.scanning_progress == null ? "—" : `${walletd.scanning_progress.toFixed(1)}%`} />
          <Metric label="Balance" value={walletd?.balance == null ? "—" : `${walletd.balance} ZKAS`} />
          <Metric label="RPC" value={walletd?.node_rpc ?? "—"} />
        </div>
        <div className="control-actions">
          {walletd?.node_source !== "local" && preset !== "mining" && node?.is_synced === true && (
            <button className="btn" disabled={busy !== null} onClick={() => run("attach", async () => { await setNodeSource("local"); location.reload(); })}>{busy === "attach" ? "Connecting…" : "Use this node for wallet"}</button>
          )}
          {walletd?.node_source === "local" && (
            <button className="btn ghost" disabled={busy !== null} onClick={() => run("attach", async () => { await setNodeSource("remote"); location.reload(); })}>Use public node</button>
          )}
        </div>
        {node?.running && node.is_synced !== true && <p className="inline-warning">Local node is syncing. Your wallet stays on {walletd?.node_source === "custom" ? "your existing node" : "the public node"} with its current balance until the local node is complete.</p>}
        {preset === "mining" && <p className="inline-warning">Mining-only mode is never offered to walletd because it does not retain complete historical notes.</p>}
      </section>

      {showLogs && (
        <section className="control-card log-card">
          <div className="card-title-row"><div><h2>Diagnostics</h2><p>Filter, pause, copy, or save what you need.</p></div></div>
          <ServiceLogs logs={logs} onClear={() => setLogs([])} preferredService="zkas-node" />
        </section>
      )}
    </main>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return <div className="metric"><span>{label}</span><strong>{value}</strong></div>;
}
