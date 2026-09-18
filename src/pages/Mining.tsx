import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Check, ChevronDown, Copy, Cpu, ExternalLink, Globe2, Network, Server, Square, Zap } from "lucide-react";
import { useTranslation } from "react-i18next";
import { api, loadStatusCache } from "../api";
import { kaspaNodeProfiles, miningNodeProfiles } from "../connection-profiles";
import { isDesktop } from "../desktop";
import {
  desktopServices,
  type ControlConfig,
  type DownloadProgress,
  type MiningStatus,
  type NodeStatus,
} from "../desktop-services";
import { ServiceLogsDialog } from "../components/ServiceLogsDialog";
import {
  BRIDGE_DASHBOARD_PORT,
  MANAGED_KASPA_RPC,
  MANAGED_ZKAS_RPC,
  STANDALONE_ZKAS_RPC_EXAMPLE,
  STRATUM_PORT,
} from "../ports";

type Mode = "solo" | "dual";
type NodeMode = "local" | "custom";
type Busy = "start" | "stop" | "cpu" | null;

const DEFAULT_ZKAS_RPC = MANAGED_ZKAS_RPC;
const DEFAULT_KASPA_RPC = MANAGED_KASPA_RPC;

function cleanHost(raw: string): string {
  return raw.trim().replace(/^stratum\+tcp:\/\//i, "").replace(/^https?:\/\//i, "").replace(/\/$/, "");
}

async function copy(value: string) {
  try {
    await navigator.clipboard.writeText(value);
  } catch {
    const element = document.createElement("textarea");
    element.value = value;
    element.style.position = "fixed";
    element.style.opacity = "0";
    document.body.appendChild(element);
    element.select();
    document.execCommand("copy");
    element.remove();
  }
}

export function Mining() {
  const { t } = useTranslation();
  const desktop = isDesktop();
  // The bridge serves its own dashboard on loopback. Opening it in a new tab drops
  // the user out of the app (and on desktop `target="_blank"` may open nothing at
  // all), so it is shown inside a panel here instead.
  const [dashboardOpen, setDashboardOpen] = useState(false);
  const [mode, setMode] = useState<Mode>("solo");
  const [config, setConfig] = useState<ControlConfig | null>(null);
  const [configHydrated, setConfigHydrated] = useState(false);
  const [status, setStatus] = useState<MiningStatus | null>(null);
  const [node, setNode] = useState<NodeStatus | null>(null);
  const [walletAddress, setWalletAddress] = useState(loadStatusCache()?.address ?? "");
  const [zkasMode, setZkasMode] = useState<NodeMode>("local");
  const [zkasRpc, setZkasRpc] = useState(DEFAULT_ZKAS_RPC);
  const [kaspaMode, setKaspaMode] = useState<NodeMode>("local");
  const [kaspaAddress, setKaspaAddress] = useState("");
  const [kaspaRpc, setKaspaRpc] = useState(DEFAULT_KASPA_RPC);
  const [stratumPort, setStratumPort] = useState(STRATUM_PORT);
  const [shareDifficulty, setShareDifficulty] = useState(8192);
  const [lanIps, setLanIps] = useState<string[]>([]);
  const [externalHost, setExternalHost] = useState(() => localStorage.getItem("mining_external_host") ?? "");
  const [busy, setBusy] = useState<Busy>(null);
  const [stage, setStage] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [progress, setProgress] = useState<DownloadProgress | null>(null);
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [showConnect, setShowConnect] = useState(false);
  // Mining asks one question — which chains — and answers the rest itself. The
  // choice lives in a step you reach by pressing Start, not in a tab strip you must
  // understand before you can do anything.
  const [chooser, setChooser] = useState(false);
  // Everything the app can decide for you stays folded away. It is still all here
  // for the people who need a custom node or a different Stratum port.
  const [advanced, setAdvanced] = useState(false);
  const [showCpu, setShowCpu] = useState(false);
  const [showLogs, setShowLogs] = useState(false);
  const [cpuThreads, setCpuThreads] = useState(Math.max(1, Math.floor((navigator.hardwareConcurrency || 2) / 2)));
  const [copied, setCopied] = useState("");
  const refreshInFlight = useRef(false);

  const refreshLocal = useCallback(async () => {
    if (!desktop || refreshInFlight.current) return;
    refreshInFlight.current = true;
    try {
      const [nextConfig, nextStatus, nextNode] = await Promise.all([
        desktopServices.config(),
        desktopServices.miningStatus(),
        desktopServices.nodeStatus(),
      ]);
      setConfig(nextConfig);
      setStatus(nextStatus);
      setNode(nextNode);
    } finally {
      refreshInFlight.current = false;
    }
  }, [desktop]);

  useEffect(() => {
    api.status().then((next) => next.address && setWalletAddress(next.address)).catch(() => undefined);
  }, []);

  useEffect(() => {
    if (!desktop) return;
    refreshLocal().catch((e) => setError(e.message));
    desktopServices.localNetworkInfo()
      .then((info) => setLanIps(info.lan_ips?.length ? info.lan_ips : info.lan_ip ? [info.lan_ip] : []))
      .catch(() => undefined);
    // Polling pauses while the page is hidden (one poll the moment it comes back)
    // and relaxes to 5 s once the window has been out of focus for half a minute.
    let alive = true;
    let blurredAt: number | null = document.hasFocus() ? null : Date.now();
    let timer = 0;
    const cadence = () => (blurredAt != null && Date.now() - blurredAt > 30_000 ? 5_000 : 2_000);
    const tick = () => {
      if (!alive) return;
      timer = window.setTimeout(tick, cadence());
      if (document.hidden) return;
      refreshLocal().catch(() => undefined);
    };
    timer = window.setTimeout(tick, cadence());
    const onVisibility = () => {
      if (!document.hidden) refreshLocal().catch(() => undefined);
    };
    const onFocus = () => { blurredAt = null; };
    const onBlur = () => { blurredAt = Date.now(); };
    document.addEventListener("visibilitychange", onVisibility);
    window.addEventListener("focus", onFocus);
    window.addEventListener("blur", onBlur);
    return () => {
      alive = false;
      clearTimeout(timer);
      document.removeEventListener("visibilitychange", onVisibility);
      window.removeEventListener("focus", onFocus);
      window.removeEventListener("blur", onBlur);
    };
  }, [desktop, refreshLocal]);

  useEffect(() => {
    if (!config || configHydrated) return;
    setStratumPort(config.settings.stratum_port);
    setShareDifficulty(config.settings.min_share_diff);
    setZkasMode(config.settings.mining_node_mode === "custom" ? "custom" : "local");
    setZkasRpc(config.settings.mining_node_addr || DEFAULT_ZKAS_RPC);
    setKaspaMode(config.settings.kaspa_mode === "custom" ? "custom" : "local");
    setKaspaAddress(config.settings.kaspa_payout);
    setKaspaRpc(config.settings.kaspa_node_addr || DEFAULT_KASPA_RPC);
    setConfigHydrated(true);
  }, [config, configHydrated]);

  useEffect(() => {
    if (status?.bridge_running && (status.mode === "solo" || status.mode === "dual")) setMode(status.mode);
  }, [status?.bridge_running, status?.mode]);

  useEffect(() => {
    if (!desktop) return;
    let unlisten: (() => void)[] = [];
    void (async () => {
      const { listen } = await import("@tauri-apps/api/event");
      unlisten = [
        await listen<DownloadProgress>("download-progress", ({ payload }) => setProgress(payload)),
        await listen("service-state", () => refreshLocal().catch(() => undefined)),
      ];
    })();
    return () => unlisten.forEach((fn) => fn());
  }, [desktop, refreshLocal]);

  const missing = useMemo(() => {
    if (!config) return [] as string[];
    const result: string[] = [];
    if (zkasMode === "local" && (!config.components.zkas_node || config.components.zkas_node_update_available)) {
      result.push(config.components.zkas_node ? t("mining.installZkasNodeUpdate") : t("mining.installZkasNode"));
    }
    if (!config.components.bridge || config.components.bridge_update_available) {
      result.push(config.components.bridge ? t("mining.installBridgeUpdate") : t("mining.installBridge"));
    }
    if (mode === "dual" && kaspaMode === "local" && !config.components.kaspa_node) result.push(t("mining.installKaspaNode"));
    return result;
  }, [config, kaspaMode, mode, t, zkasMode]);

  const valid = walletAddress.startsWith("zkas:")
    && (mode === "solo" || kaspaAddress.startsWith("kaspa:"))
    && (zkasMode === "local" || !!zkasRpc.trim())
    && (mode === "solo" || kaspaMode === "local" || !!kaspaRpc.trim())
    && stratumPort >= 1024 && stratumPort <= 65535
    && Number.isFinite(shareDifficulty) && shareDifficulty >= 1;

  const start = async () => {
    if (!config || !valid) return;
    setBusy("start");
    setError(null);
    setProgress(null);
    try {
      let current = config;
      const selection = {
        zkas: zkasMode === "local" && (!current.components.zkas_node || current.components.zkas_node_update_available),
        bridge: !current.components.bridge || current.components.bridge_update_available,
        kaspa: mode === "dual" && kaspaMode === "local" && !current.components.kaspa_node,
      };
      if (selection.zkas || selection.bridge || selection.kaspa) {
        setStage(t("mining.stageInstalling"));
        await desktopServices.install(selection);
        current = await desktopServices.config();
        setConfig(current);
      }

      setStage(zkasMode === "local" ? t("mining.stageStartingNode") : t("mining.stageCheckingNode"));
      if (zkasMode === "local") {
        await desktopServices.startNode(current.settings.node_preset || "shielded", current.settings.node_public_p2p);
        const deadline = Date.now() + 20_000;
        let ready = false;
        while (Date.now() < deadline) {
          const status = await desktopServices.nodeStatus();
          setNode(status);
          if (status.running && !status.error) { ready = true; break; }
          await new Promise((resolve) => window.setTimeout(resolve, 500));
        }
        if (!ready) throw new Error(t("mining.nodeNotReady"));
      } else {
        if (!miningNodeProfiles.load().some((profile) => profile.address === zkasRpc.trim())) miningNodeProfiles.save("Mining node", zkasRpc.trim());
      }

      setStage(mode === "dual" ? t("mining.stageStartingDual") : t("mining.stageStartingSolo"));
      if (mode === "dual") {
        await desktopServices.startDual(stratumPort, walletAddress, kaspaAddress, kaspaMode, kaspaMode === "custom" ? kaspaRpc : undefined, shareDifficulty, zkasMode, zkasMode === "custom" ? zkasRpc : undefined);
        if (kaspaMode === "custom" && !kaspaNodeProfiles.load().some((profile) => profile.address === kaspaRpc.trim())) kaspaNodeProfiles.save("Kaspa mining node", kaspaRpc.trim());
      } else {
        await desktopServices.startSolo(stratumPort, walletAddress, shareDifficulty, zkasMode, zkasMode === "custom" ? zkasRpc : undefined);
      }
      setShowConnect(true);
      setStage("");
      await refreshLocal();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setStage("");
    } finally {
      setBusy(null);
    }
  };

  const stop = async () => {
    setBusy("stop");
    setError(null);
    try {
      await desktopServices.stopMining();
      await refreshLocal();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };

  const copyEndpoint = async (id: string, value: string) => {
    await copy(value);
    setCopied(id);
    window.setTimeout(() => setCopied(""), 1_400);
  };

  const external = cleanHost(externalHost);
  const endpoint = (host: string) => {
    const value = host.trim();
    if (/^\[[^\]]+\]:\d+$/.test(value) || (/^[^:]+:\d+$/.test(value) && !value.includes("//"))) return `stratum+tcp://${value}`;
    if (value.startsWith("[") && value.endsWith("]")) return `stratum+tcp://${value}:${stratumPort}`;
    if ((value.match(/:/g) || []).length > 1) return `stratum+tcp://[${value}]:${stratumPort}`;
    return `stratum+tcp://${value}:${stratumPort}`;
  };
  const downloadPercent = progress?.total ? Math.round(progress.received / progress.total * 100) : null;
  const live = !!status?.bridge_running;
  const nodeLabel = status?.zkas_rpc_connected ? status.zkas_synced ? t("mining.nodeSynced") : t("mining.nodeSyncing") : node?.running ? t("mining.nodeStarting") : zkasMode === "custom" ? t("mining.nodeUnavailable") : t("mining.nodeStopped");

  if (!desktop) {
    return (
      <main className="control-page mining-page">
        <header className="control-heading"><div><span className="eyebrow">{t("mining.webEyebrow")}</span><h1>{t("mining.webTitle")}</h1><p>{t("mining.webIntro")}</p></div></header>
        <section className="control-card empty-state"><Server size={28} /><h2>{t("mining.webGetApp")}</h2><p>{t("mining.webNoBackground")}</p><a className="btn" href="https://github.com/firecash/zkas-wallet/releases" target="_blank" rel="noreferrer">{t("mining.webDownload")}</a></section>
      </main>
    );
  }

  return (
    <main className="control-page mining-page">
      <header className="control-heading">
        <div><span className="eyebrow">{t("mining.eyebrow")}</span><h1>{t("mining.title")}</h1><p>{t("mining.intro")}</p></div>
        <span className={`status-pill ${live ? "good" : ""}`} title={live ? t("mining.listening") : t("mining.stopped")}>{live ? t("mining.listening") : t("mining.stopped")}</span>
      </header>

      {!live && (
        <section className="control-card mining-hero">
          <div>
            <h2>{t("mining.heroTitle")}</h2>
            <p>
              {t("mining.heroText")}
            </p>
          </div>
          <div className="mining-hero-action">
            <button className="btn mining-start" disabled={busy !== null || !config} onClick={() => setChooser(true)}>
              <Zap size={17} />
              {busy === "start" ? stage || t("mining.starting") : t("mining.startMining")}
            </button>
          </div>
          {busy === "start" && progress && (
            <div className="download-line">
              <span>{progress.component} · {progress.phase}</span>
              {downloadPercent != null && <><b>{downloadPercent}%</b><i><span style={{ width: `${downloadPercent}%` }} /></i></>}
            </div>
          )}
        </section>
      )}
      {live && (
        <div className="mode-tabs two" role="tablist">
          <button className={mode === "solo" ? "active" : ""} disabled>{t("mining.tabZkas")}</button>
          <button className={mode === "dual" ? "active" : ""} disabled>{t("mining.tabDual")}</button>
        </div>
      )}
      {config?.dual_mining_supported === false && <p className="subtle mining-platform-note">{t("mining.noDualBridge")}</p>}
      {error && <div className="control-error">{error}</div>}

      {live && <section className="control-card mining-setup-card">
        <div className="card-title-row">
          <div><h2>{live ? t("mining.serviceTitle") : t("mining.setupTitle")}</h2><p>{live ? t("mining.serviceIntro") : t("mining.setupIntro")}</p></div>
          {missing.length > 0 && !live && <span className="status-pill" title={t("mining.installs", { n: missing.length })}>{t("mining.installs", { n: missing.length })}</span>}
        </div>

        <div className="setup-section">
          <div className="setup-section-title"><span>1</span><div><b>{t("mining.rewards")}</b><small>{t("mining.rewardsNote")}</small></div></div>
          <label className="field-label">{t("mining.zkasAddress")}<input className="control-input mono" value={walletAddress} onChange={(event) => setWalletAddress(event.target.value.trim())} placeholder={t("mining.zkasPlaceholder")} disabled={live} /></label>
          {mode === "dual" && <label className="field-label">{t("mining.kaspaAddress")}<input className="control-input mono" value={kaspaAddress} onChange={(event) => setKaspaAddress(event.target.value.trim())} placeholder={t("mining.kaspaPlaceholder")} disabled={live} /></label>}
        </div>

        <div className="setup-section">
          <div className="setup-section-title"><span>2</span><div><b>{t("mining.zkasNode")}</b><small>{t("mining.zkasNodeNote")}</small></div></div>
          <div className="choice-row">
            <button className={`choice-button ${zkasMode === "local" ? "selected" : ""}`} onClick={() => setZkasMode("local")} disabled={live}><strong>{t("mining.automatic")}</strong><span>{t("mining.automaticNote")}</span></button>
            <button className={`choice-button ${zkasMode === "custom" ? "selected" : ""}`} onClick={() => setZkasMode("custom")} disabled={live}><strong>{t("mining.existingNode")}</strong><span>{t("mining.existingNodeNote")}</span></button>
          </div>
          {zkasMode === "custom" && <EndpointField label={t("mining.zkasGrpc")} value={zkasRpc} onChange={setZkasRpc} placeholder={STANDALONE_ZKAS_RPC_EXAMPLE} disabled={live} kind="zkas" />}
        </div>

        {mode === "dual" && <div className="setup-section">
          <div className="setup-section-title"><span>3</span><div><b>{t("mining.kaspaNode")}</b><small>{t("mining.kaspaNodeNote")}</small></div></div>
          <div className="choice-row">
            <button className={`choice-button ${kaspaMode === "local" ? "selected" : ""}`} onClick={() => setKaspaMode("local")} disabled={live}><strong>{t("mining.automatic")}</strong><span>{t("mining.kaspaAutomaticNote")}</span></button>
            <button className={`choice-button ${kaspaMode === "custom" ? "selected" : ""}`} onClick={() => setKaspaMode("custom")} disabled={live}><strong>{t("mining.existingNode")}</strong><span>{t("mining.kaspaExistingNote")}</span></button>
          </div>
          {kaspaMode === "custom" && <EndpointField label={t("mining.kaspaGrpc")} value={kaspaRpc} onChange={setKaspaRpc} placeholder={DEFAULT_KASPA_RPC} disabled={live} kind="kaspa" />}
        </div>}

        <button className="mining-advanced-toggle" onClick={() => setShowAdvanced((value) => !value)} aria-expanded={showAdvanced}>
          {/* Named for what it holds. It sits INSIDE "Advanced settings", and a
              second control called "Advanced" one level down says nothing about
              which of the two a person is looking for. */}
          <span>{t("mining.stratumDifficulty")}</span><ChevronDown size={16} className={showAdvanced ? "open" : ""} />
        </button>
        {showAdvanced && <div className="advanced-grid">
          <label className="field-label">{t("mining.stratumPort")}<input className="control-input" type="number" min={1024} max={65535} value={stratumPort} onChange={(event) => setStratumPort(Number(event.target.value))} disabled={live} /></label>
          <label className="field-label">{t("mining.startingShareDifficulty")}<input className="control-input" type="number" min={1} step={1} value={shareDifficulty} onChange={(event) => setShareDifficulty(Number(event.target.value))} disabled={live} /></label>
          <p>{t("mining.vardiffNote")}</p>
        </div>}

        {/* Starting lives on the card above; this one only ever stops. Two Start
            buttons on one screen is two answers to the same question. */}
        {live && (
          <div className="mining-primary-action">
            <button className="btn ghost mining-start" disabled={busy !== null} onClick={() => void stop()}>
              <Square size={15} />{busy === "stop" ? t("mining.stopping") : t("mining.stopMining")}
            </button>
          </div>
        )}
      </section>}

      {(live || showConnect) && <section className="control-card connect-miner-card">
        <div className="card-title-row"><div><h2>{t("mining.connectTitle")}</h2><p>{t("mining.connectIntro")}</p></div><span className={`status-pill ${live ? "good" : ""}`} title={live ? t("mining.portOpen", { port: stratumPort }) : t("mining.startFirst")}>{live ? t("mining.portOpen", { port: stratumPort }) : t("mining.startFirst")}</span></div>
        <div className="endpoint-grid">
          <EndpointCard icon={<Cpu size={18} />} title={t("mining.thisComputer")} note={t("mining.thisComputerNote")} value={endpoint("127.0.0.1")} id="local" copied={copied} onCopy={copyEndpoint} />
          {lanIps.length ? lanIps.map((ip, index) => (
            <EndpointCard
              key={ip}
              icon={<Network size={18} />}
              title={index === 0 ? t("mining.localNetwork") : t("mining.localNetworkN", { n: index + 1 })}
              note={index === 0 && lanIps.length > 1 ? t("mining.lanPreferred") : t("mining.lanSameRouter")}
              value={endpoint(ip)}
              id={`lan-${index}`}
              copied={copied}
              onCopy={copyEndpoint}
            />
          )) : (
            <EndpointCard icon={<Network size={18} />} title={t("mining.localNetwork")} note={t("mining.lanNotDetected")} value="" id="lan" copied={copied} onCopy={copyEndpoint} />
          )}
          <div className="endpoint-card external-endpoint">
            <div className="endpoint-title"><Globe2 size={18} /><span><b>{t("mining.remoteAsic")}</b><small>{t("mining.remoteNote")}</small></span></div>
            <input value={externalHost} onChange={(event) => { setExternalHost(event.target.value); localStorage.setItem("mining_external_host", event.target.value); }} placeholder="mine.example.com" />{/* i18n-ignore: example hostname */}
            {external && <button onClick={() => void copyEndpoint("external", endpoint(external))}><code>{endpoint(external)}</code>{copied === "external" ? <Check size={15} /> : <Copy size={15} />}</button>}
          </div>
        </div>
        <div className="asic-credentials">
          <span>{t("mining.username")} <code>{walletAddress || t("mining.yourAddress")}</code></span>
          <span>{t("mining.password")} <code>x</code></span>{/* i18n-ignore: literal Stratum password */}
          {live && (
            <button className="btn ghost compact" onClick={() => setDashboardOpen(true)}>
              <ExternalLink size={14} />{t("mining.minerDashboard")}
            </button>
          )}
        </div>
        <p className="subtle">{t("mining.lanReady", { port: stratumPort })}</p>
      </section>}

      <section className="control-card mining-live-card">
        <div className="card-title-row"><div><h2>{t("mining.liveStatus")}</h2><p>{live ? t("mining.updatesEvery") : t("mining.startToReceive")}</p></div><div className="mining-live-actions">{live && <button className="btn ghost compact" onClick={() => setDashboardOpen(true)}><ExternalLink size={14} />{t("mining.fullDashboard")}</button>}<span className={`status-dot ${live ? "on" : ""}`} /></div></div>
        <div className="metric-grid mining-metrics">
          <Metric label={t("mining.metricBridge")} value={live ? t("mining.running") : t("mining.stopped")} />
          <Metric label={t("mining.metricZkasNode")} value={nodeLabel} />
          <Metric label={t("mining.metricAsics")} value={String(status?.active_workers ?? 0)} />
          <Metric label={t("mining.metricAccepted")} value={(status?.shares_accepted ?? 0).toLocaleString()} />
          <Metric label={t("mining.metricZkasBlocks")} value={(status?.blocks_found ?? 0).toLocaleString()} />
          {mode === "dual" && <Metric label={t("mining.metricKasBlocks")} value={(status?.kas_blocks_found ?? 0).toLocaleString()} />}
          <Metric label={t("mining.metricKaspaParent")} value={mode === "solo" ? t("mining.off") : status?.kaspa_rpc_connected ? status.kaspa_synced ? t("mining.nodeSynced") : t("mining.nodeSyncing") : status?.kaspa_node_running ? t("mining.nodeStarting") : t("mining.nodeStopped")} />
        </div>
        {node?.running && node.is_synced === false && <p className="inline-warning">{t("mining.nodeSyncingWarning")}</p>}
        {status?.zkas_rpc_error && <p className="inline-warning">{t("mining.zkasRpcError", { error: status.zkas_rpc_error })}</p>}
        {mode === "dual" && status?.kaspa_rpc_error && <p className="inline-warning">{t("mining.kaspaRpcError", { error: status.kaspa_rpc_error })}</p>}
        {status?.bridge_error && <p className="inline-warning">{t("mining.bridgeStopped", { error: status.bridge_error })}</p>}
        <button className="text-button disclosure" onClick={() => setShowLogs(true)}>{t("mining.viewBridgeLogs")}</button>
      </section>

      {mode === "solo" && <section className="control-card compact-card cpu-card">
        <button className="text-button disclosure" onClick={() => setShowCpu((value) => !value)}>{status?.cpu_miner_running ? t("mining.cpuTestMinerRunning") : t("mining.cpuTestMiner")}</button>
        {showCpu && <div className="advanced-row"><p>{t("mining.cpuNote")}</p><label>{t("mining.threads")} <input className="control-input" type="number" min={1} max={256} value={cpuThreads} onChange={(event) => setCpuThreads(Number(event.target.value))} /></label><button className="btn ghost compact" disabled={busy !== null || !config?.components.zkas_miner || !walletAddress || !!status?.cpu_miner_running} onClick={() => { setBusy("cpu"); desktopServices.startCpuMiner(cpuThreads, walletAddress).then(refreshLocal).catch((e) => setError(e.message)).finally(() => setBusy(null)); }}>{t("mining.start")}</button><button className="btn ghost compact" disabled={!status?.cpu_miner_running} onClick={() => { setBusy("cpu"); desktopServices.stopCpuMiner().then(refreshLocal).finally(() => setBusy(null)); }}>{t("mining.stop")}</button></div>}
      </section>}
      {chooser && (
        <div className="modalwrap" onClick={() => busy === null && setChooser(false)}>
          <div className="card modalcard mining-chooser" onClick={(event) => event.stopPropagation()}>
            <h2 style={{ marginTop: 0 }}>{t("mining.chooserTitle")}</h2>
            <p className="muted small">
              {t("mining.chooserIntro")}
            </p>

            {/* 1 — what to mine */}
            <div className="setup-section-title"><span>1</span><div><b>{t("mining.whatToMine")}</b><small>{t("mining.whatToMineNote")}</small></div></div>
            <div className="choice-grid">
              <button className={`choice-button ${mode === "solo" ? "selected" : ""}`} onClick={() => setMode("solo")} disabled={busy !== null}>
                <strong>{t("mining.zkasOnly")}</strong>
                <span>{t("mining.zkasOnlyNote")}</span>
              </button>
              <button className={`choice-button ${mode === "dual" ? "selected" : ""}`} onClick={() => setMode("dual")} disabled={busy !== null || config?.dual_mining_supported === false}>
                <strong>{t("mining.tabDual")}</strong>
                <span>{t("mining.dualNote")}</span>
              </button>
            </div>
            {config?.dual_mining_supported === false && (
              <p className="subtle">{t("mining.noDualBuild")}</p>
            )}

            {/* 2 — payouts */}
            <div className="setup-section-title" style={{ marginTop: 16 }}><span>2</span><div><b>{t("mining.payouts")}</b><small>{t("mining.payoutsNote")}</small></div></div>
            <div className={mode === "dual" ? "pay-row" : undefined}>
              <label className="field-label">
                {t("mining.zkasAddress")}
                <input className="control-input mono" value={walletAddress} onChange={(event) => setWalletAddress(event.target.value.trim())} placeholder={t("mining.zkasPlaceholder")} autoCapitalize="none" autoCorrect="off" spellCheck={false} disabled={busy !== null} />
              </label>
              {mode === "dual" && (
                <label className="field-label">
                  {t("mining.kaspaAddress")}
                  <input className="control-input mono" value={kaspaAddress} onChange={(event) => setKaspaAddress(event.target.value.trim())} placeholder={t("mining.kaspaPlaceholder")} autoCapitalize="none" autoCorrect="off" spellCheck={false} disabled={busy !== null} />
                </label>
              )}
            </div>

            {/* 3 & 4 — nodes, side by side when merged */}
            <div className={mode === "dual" ? "node-columns" : undefined} style={{ marginTop: 16 }}>
              <div>
                <div className="setup-section-title"><span>3</span><div><b>{t("mining.zkasNode")}</b><small>{t("mining.zkasNodeChooserNote")}</small></div></div>
                <div className="choice-row">
                  <button className={`choice-button ${zkasMode === "local" ? "selected" : ""}`} onClick={() => setZkasMode("local")} disabled={busy !== null}><strong>{t("mining.runForMe")}</strong><span>{t("mining.runForMeNote")}</span></button>
                  <button className={`choice-button ${zkasMode === "custom" ? "selected" : ""}`} onClick={() => setZkasMode("custom")} disabled={busy !== null}><strong>{t("mining.connectMyNode")}</strong><span>{t("mining.connectMyNodeNote")}</span></button>
                </div>
                {zkasMode === "custom" && <EndpointField label={t("mining.zkasGrpcHostPort")} value={zkasRpc} onChange={setZkasRpc} placeholder={STANDALONE_ZKAS_RPC_EXAMPLE} disabled={busy !== null} kind="zkas" />}
              </div>
              {mode === "dual" && (
                <div>
                  <div className="setup-section-title"><span>4</span><div><b>{t("mining.kaspaNode")}</b><small>{t("mining.kaspaNodeChooserNote")}</small></div></div>
                  <div className="choice-row">
                    <button className={`choice-button ${kaspaMode === "local" ? "selected" : ""}`} onClick={() => setKaspaMode("local")} disabled={busy !== null}><strong>{t("mining.runForMe")}</strong><span>{t("mining.kaspaRunForMeNote")}</span></button>
                    <button className={`choice-button ${kaspaMode === "custom" ? "selected" : ""}`} onClick={() => setKaspaMode("custom")} disabled={busy !== null}><strong>{t("mining.connectMyNode")}</strong><span>{t("mining.kaspaConnectNote")}</span></button>
                  </div>
                  {kaspaMode === "custom" && <EndpointField label={t("mining.kaspaGrpcHostPort")} value={kaspaRpc} onChange={setKaspaRpc} placeholder={DEFAULT_KASPA_RPC} disabled={busy !== null} kind="kaspa" />}
                </div>
              )}
            </div>

            {/* advanced — one inline disclosure, no separate screen */}
            <button className="btn ghost compact" style={{ marginTop: 14 }} onClick={() => setAdvanced((on) => !on)}>{advanced ? t("mining.hideAdvanced") : t("mining.advanced")}</button>
            {advanced && (
              <div className="setup-section" style={{ marginTop: 8 }}>
                <label className="field-label">{t("mining.stratumPort")}<input className="control-input mono" type="number" value={stratumPort} onChange={(event) => setStratumPort(Number(event.target.value))} disabled={busy !== null} /></label>
                <label className="field-label">{t("mining.startDifficulty")}<input className="control-input mono" type="number" value={shareDifficulty} onChange={(event) => setShareDifficulty(Number(event.target.value))} disabled={busy !== null} /></label>
              </div>
            )}
            {missing.length > 0 && (
              <p className="subtle">{t("mining.firstRunInstalls", { list: missing.join(", ") })}</p>
            )}
            {error && <div className="msg err">{error}</div>}
            <div className="row">
              <button className="btn ghost" disabled={busy !== null} onClick={() => setChooser(false)}>{t("mining.cancel")}</button>
              <button
                className="btn"
                disabled={busy !== null || !config || !valid}
                onClick={() => void (async () => { await start(); setChooser(false); })()}
              >
                <Zap size={16} />
                {busy === "start" ? stage || t("mining.starting") : missing.length > 0 ? t("mining.installStart") : t("mining.startMining")}
              </button>
            </div>
          </div>
        </div>
      )}
      <ServiceLogsDialog open={showLogs} onClose={() => setShowLogs(false)} service="stratum-bridge" title={t("mining.bridgeLogsTitle")} />
      {dashboardOpen && (
        <div className="modalwrap" onClick={() => setDashboardOpen(false)}>
          <div className="card modalcard dashboard-modal" onClick={(event) => event.stopPropagation()}>
            <div className="card-title-row">
              <div>
                <h2>{t("mining.dashboardTitle")}</h2>
                <p className="mono">http://127.0.0.1:{BRIDGE_DASHBOARD_PORT}/</p>
              </div>
              <button className="btn ghost compact" onClick={() => setDashboardOpen(false)}>{t("mining.close")}</button>
            </div>
            {/* Served by the bridge on loopback. Sandboxed: it is a local service the
                app supervises, not app code, and it has no business reaching this
                page's storage or scripts. */}
            <iframe
              className="dashboard-frame"
              title={t("mining.dashboardFrameTitle")}
              src={`http://127.0.0.1:${BRIDGE_DASHBOARD_PORT}/`}
              sandbox="allow-scripts allow-same-origin"
            />
            <p className="subtle">
              {t("mining.dashboardNote")}
            </p>
          </div>
        </div>
      )}
    </main>
  );
}

function EndpointField({ label, value, onChange, placeholder, disabled, kind }: { label: string; value: string; onChange: (value: string) => void; placeholder: string; disabled: boolean; kind: "zkas" | "kaspa" }) {
  const { t } = useTranslation();
  const profiles = (kind === "zkas" ? miningNodeProfiles : kaspaNodeProfiles).load();
  return (
    <label className="field-label">
      {label}
      {/* The text box IS the field: type any node's IP:port, on this machine or not.
          Saved nodes are optional shortcuts below, never a replacement for typing. */}
      <input
        className="control-input mono"
        value={value}
        onChange={(event) => onChange(event.target.value)}
        placeholder={placeholder}
        disabled={disabled}
        autoCapitalize="none"
        autoCorrect="off"
        spellCheck={false}
        autoComplete="off"
      />
      <span className="fieldhint muted">{t("endpointField.hint")}</span>
      {profiles.length > 0 && (
        <div className="saved-chips">
          <span className="saved-chips-label">{t("endpointField.saved")}</span>
          {profiles.map((profile) => (
            <button type="button" key={profile.id} className="chip" disabled={disabled} onClick={() => onChange(profile.address)} title={profile.address}>
              {profile.name}
            </button>
          ))}
        </div>
      )}
    </label>
  );
}

function EndpointCard({ icon, title, note, value, id, copied, onCopy }: { icon: React.ReactNode; title: string; note: string; value: string; id: string; copied: string; onCopy: (id: string, value: string) => void }) {
  const { t } = useTranslation();
  return <div className="endpoint-card"><div className="endpoint-title">{icon}<span><b>{title}</b><small>{note}</small></span></div>{value ? <button onClick={() => void onCopy(id, value)}><code>{value}</code>{copied === id ? <Check size={15} /> : <Copy size={15} />}</button> : <span className="endpoint-unavailable">{t("endpointCard.unavailable")}</span>}</div>;
}

function Metric({ label, value }: { label: string; value: string }) {
  return <div className="metric"><span title={label}>{label}</span><strong>{value}</strong></div>;
}
