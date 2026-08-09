import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Check, ChevronDown, Copy, Cpu, ExternalLink, Globe2, Network, Server, Square, Zap } from "lucide-react";
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
  const desktop = isDesktop();
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
  const [lanIp, setLanIp] = useState<string | null>(null);
  const [externalHost, setExternalHost] = useState(() => localStorage.getItem("mining_external_host") ?? "");
  const [busy, setBusy] = useState<Busy>(null);
  const [stage, setStage] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [progress, setProgress] = useState<DownloadProgress | null>(null);
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [showConnect, setShowConnect] = useState(false);
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
    desktopServices.localNetworkInfo().then((info) => setLanIp(info.lan_ip)).catch(() => undefined);
    const timer = window.setInterval(() => refreshLocal().catch(() => undefined), 2_000);
    return () => clearInterval(timer);
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
      result.push(config.components.zkas_node ? "ZKAS node update" : "ZKAS node");
    }
    if (!config.components.bridge || config.components.bridge_update_available) {
      result.push(config.components.bridge ? "mining bridge update" : "mining bridge");
    }
    if (mode === "dual" && kaspaMode === "local" && !config.components.kaspa_node) result.push("Kaspa node");
    return result;
  }, [config, kaspaMode, mode, zkasMode]);

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
        setStage("Installing verified releases");
        await desktopServices.install(selection);
        current = await desktopServices.config();
        setConfig(current);
      }

      setStage(zkasMode === "local" ? "Starting your ZKAS node" : "Checking your ZKAS node");
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
        if (!ready) throw new Error("The ZKAS node started but its RPC is not ready yet. Keep it running and press Start mining again shortly.");
      } else {
        if (!miningNodeProfiles.load().some((profile) => profile.address === zkasRpc.trim())) miningNodeProfiles.save("Mining node", zkasRpc.trim());
      }

      setStage(mode === "dual" ? "Starting KAS + ZKAS mining" : "Starting ZKAS mining");
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
  const nodeLabel = status?.zkas_rpc_connected ? status.zkas_synced ? "Synced" : "Syncing" : node?.running ? "Starting" : zkasMode === "custom" ? "Unavailable" : "Stopped";

  if (!desktop) {
    return (
      <main className="control-page mining-page">
        <header className="control-heading"><div><span className="eyebrow">Mining</span><h1>Direct mining</h1><p>The desktop app installs and supervises the nodes and Stratum bridge.</p></div></header>
        <section className="control-card empty-state"><Server size={28} /><h2>Get the desktop app</h2><p>Browser and mobile wallets cannot run mining services in the background.</p><a className="btn" href="https://github.com/firecash/zkas-wallet/releases" target="_blank" rel="noreferrer">Download</a></section>
      </main>
    );
  }

  return (
    <main className="control-page mining-page">
      <header className="control-heading">
        <div><span className="eyebrow">Direct mining</span><h1>Mine to your wallet</h1><p>The app installs, connects, and keeps every required service running.</p></div>
        <span className={`status-pill ${live ? "good" : ""}`}>{live ? "Listening" : "Stopped"}</span>
      </header>

      <div className="mode-tabs two" role="tablist">
        <button className={mode === "solo" ? "active" : ""} onClick={() => setMode("solo")} disabled={live}>ZKAS</button>
        <button className={mode === "dual" ? "active" : ""} onClick={() => setMode("dual")} disabled={live || config?.dual_mining_supported === false}>KAS + ZKAS</button>
      </div>
      {config?.dual_mining_supported === false && <p className="subtle mining-platform-note">No verified merged-mining bridge is published for this device. ZKAS-only mining remains available.</p>}
      {error && <div className="control-error">{error}</div>}

      <section className="control-card mining-setup-card">
        <div className="card-title-row">
          <div><h2>{live ? "Mining service" : "Setup"}</h2><p>{live ? "Your ASIC can connect now." : "Recommended choices are ready. Change only what you need."}</p></div>
          {missing.length > 0 && !live && <span className="status-pill">Installs {missing.length}</span>}
        </div>

        <div className="setup-section">
          <div className="setup-section-title"><span>1</span><div><b>Rewards</b><small>Paid directly; no pool account.</small></div></div>
          <label className="field-label">ZKAS address<input className="control-input mono" value={walletAddress} onChange={(event) => setWalletAddress(event.target.value.trim())} placeholder="zkas:…" disabled={live} /></label>
          {mode === "dual" && <label className="field-label">Kaspa address<input className="control-input mono" value={kaspaAddress} onChange={(event) => setKaspaAddress(event.target.value.trim())} placeholder="kaspa:…" disabled={live} /></label>}
        </div>

        <div className="setup-section">
          <div className="setup-section-title"><span>2</span><div><b>ZKAS node</b><small>Supplies work and receives solved blocks.</small></div></div>
          <div className="choice-row">
            <button className={`choice-button ${zkasMode === "local" ? "selected" : ""}`} onClick={() => setZkasMode("local")} disabled={live}><strong>Automatic</strong><span>Install, run, and sync on this computer.</span></button>
            <button className={`choice-button ${zkasMode === "custom" ? "selected" : ""}`} onClick={() => setZkasMode("custom")} disabled={live}><strong>Existing node</strong><span>Use mining gRPC on your LAN or server.</span></button>
          </div>
          {zkasMode === "custom" && <EndpointField label="ZKAS gRPC" value={zkasRpc} onChange={setZkasRpc} placeholder={STANDALONE_ZKAS_RPC_EXAMPLE} disabled={live} kind="zkas" />}
        </div>

        {mode === "dual" && <div className="setup-section">
          <div className="setup-section-title"><span>3</span><div><b>Kaspa node</b><small>The parent node for the same ASIC work.</small></div></div>
          <div className="choice-row">
            <button className={`choice-button ${kaspaMode === "local" ? "selected" : ""}`} onClick={() => setKaspaMode("local")} disabled={live}><strong>Automatic</strong><span>Install and run Kaspa on this computer.</span></button>
            <button className={`choice-button ${kaspaMode === "custom" ? "selected" : ""}`} onClick={() => setKaspaMode("custom")} disabled={live}><strong>Existing node</strong><span>Connect to a Kaspa mining gRPC endpoint.</span></button>
          </div>
          {kaspaMode === "custom" && <EndpointField label="Kaspa gRPC" value={kaspaRpc} onChange={setKaspaRpc} placeholder={DEFAULT_KASPA_RPC} disabled={live} kind="kaspa" />}
        </div>}

        <button className="mining-advanced-toggle" onClick={() => setShowAdvanced((value) => !value)} aria-expanded={showAdvanced}>
          <span>Advanced</span><ChevronDown size={16} className={showAdvanced ? "open" : ""} />
        </button>
        {showAdvanced && <div className="advanced-grid">
          <label className="field-label">Stratum port<input className="control-input" type="number" min={1024} max={65535} value={stratumPort} onChange={(event) => setStratumPort(Number(event.target.value))} disabled={live} /></label>
          <label className="field-label">Starting share difficulty<input className="control-input" type="number" min={1} step={1} value={shareDifficulty} onChange={(event) => setShareDifficulty(Number(event.target.value))} disabled={live} /></label>
          <p>Vardiff adjusts after the ASIC connects. This starting value changes share reporting, not block probability or rewards.</p>
        </div>}

        <div className="mining-primary-action">
          {!live ? <button className="btn mining-start" disabled={busy !== null || !config || !valid} onClick={() => void start()}><Zap size={17} />{busy === "start" ? stage || "Starting…" : missing.length > 0 ? "Install & start" : "Start mining"}</button>
            : <button className="btn ghost mining-start" disabled={busy !== null} onClick={() => void stop()}><Square size={15} />{busy === "stop" ? "Stopping…" : "Stop mining"}</button>}
          {busy === "start" && progress && <div className="download-line"><span>{progress.component} · {progress.phase}</span>{downloadPercent != null && <><b>{downloadPercent}%</b><i><span style={{ width: `${downloadPercent}%` }} /></i></>}</div>}
        </div>
      </section>

      {(live || showConnect) && <section className="control-card connect-miner-card">
        <div className="card-title-row"><div><h2>Connect your ASIC</h2><p>Use the address that reaches this computer.</p></div><span className={`status-pill ${live ? "good" : ""}`}>{live ? `Port ${stratumPort} open` : "Start first"}</span></div>
        <div className="endpoint-grid">
          <EndpointCard icon={<Cpu size={18} />} title="This computer" note="Miner software running here" value={endpoint("127.0.0.1")} id="local" copied={copied} onCopy={copyEndpoint} />
          <EndpointCard icon={<Network size={18} />} title="Local network" note={lanIp ? "ASIC on the same router" : "LAN address not detected"} value={lanIp ? endpoint(lanIp) : ""} id="lan" copied={copied} onCopy={copyEndpoint} />
          <div className="endpoint-card external-endpoint">
            <div className="endpoint-title"><Globe2 size={18} /><span><b>Remote ASIC</b><small>Public IP, DNS, or VPN hostname</small></span></div>
            <input value={externalHost} onChange={(event) => { setExternalHost(event.target.value); localStorage.setItem("mining_external_host", event.target.value); }} placeholder="mine.example.com" />
            {external && <button onClick={() => void copyEndpoint("external", endpoint(external))}><code>{endpoint(external)}</code>{copied === "external" ? <Check size={15} /> : <Copy size={15} />}</button>}
          </div>
        </div>
        <div className="asic-credentials"><span>Username <code>{walletAddress || "zkas:your-address"}</code></span><span>Password <code>x</code></span></div>
        <p className="subtle">LAN is ready automatically. For an internet ASIC, forward TCP {stratumPort} to this computer or use a VPN, and restrict the firewall to your miner’s IP. Never forward node RPC to the internet.</p>
      </section>}

      <section className="control-card mining-live-card">
        <div className="card-title-row"><div><h2>Live status</h2><p>{live ? "Updates every two seconds." : "Start mining to receive ASIC work."}</p></div><div className="mining-live-actions">{live && <a className="btn ghost compact" href={`http://127.0.0.1:${BRIDGE_DASHBOARD_PORT}/`} target="_blank" rel="noreferrer"><ExternalLink size={14} />Full dashboard</a>}<span className={`status-dot ${live ? "on" : ""}`} /></div></div>
        <div className="metric-grid mining-metrics">
          <Metric label="Bridge" value={live ? "Running" : "Stopped"} />
          <Metric label="ZKAS node" value={nodeLabel} />
          <Metric label="ASICs" value={String(status?.active_workers ?? 0)} />
          <Metric label="Accepted shares" value={(status?.shares_accepted ?? 0).toLocaleString()} />
          <Metric label="ZKAS blocks" value={(status?.blocks_found ?? 0).toLocaleString()} />
          {mode === "dual" && <Metric label="KAS blocks" value={(status?.kas_blocks_found ?? 0).toLocaleString()} />}
          <Metric label="Kaspa parent" value={mode === "solo" ? "Off" : status?.kaspa_rpc_connected ? status.kaspa_synced ? "Synced" : "Syncing" : status?.kaspa_node_running ? "Starting" : "Stopped"} />
        </div>
        {node?.running && node.is_synced === false && <p className="inline-warning">The ZKAS node is syncing. Keep the app running; the bridge is supervised and mining becomes ready when the node catches up.</p>}
        {status?.zkas_rpc_error && <p className="inline-warning">ZKAS RPC: {status.zkas_rpc_error}</p>}
        {mode === "dual" && status?.kaspa_rpc_error && <p className="inline-warning">Kaspa RPC: {status.kaspa_rpc_error}</p>}
        {status?.bridge_error && <p className="inline-warning">Bridge stopped: {status.bridge_error}</p>}
        <button className="text-button disclosure" onClick={() => setShowLogs(true)}>View bridge logs</button>
      </section>

      {mode === "solo" && <section className="control-card compact-card cpu-card">
        <button className="text-button disclosure" onClick={() => setShowCpu((value) => !value)}>CPU test miner {status?.cpu_miner_running ? "· running" : ""}</button>
        {showCpu && <div className="advanced-row"><p>For setup testing only; ASICs are vastly faster.</p><label>Threads <input className="control-input" type="number" min={1} max={256} value={cpuThreads} onChange={(event) => setCpuThreads(Number(event.target.value))} /></label><button className="btn ghost compact" disabled={busy !== null || !config?.components.zkas_miner || !walletAddress || !!status?.cpu_miner_running} onClick={() => { setBusy("cpu"); desktopServices.startCpuMiner(cpuThreads, walletAddress).then(refreshLocal).catch((e) => setError(e.message)).finally(() => setBusy(null)); }}>Start</button><button className="btn ghost compact" disabled={!status?.cpu_miner_running} onClick={() => { setBusy("cpu"); desktopServices.stopCpuMiner().then(refreshLocal).finally(() => setBusy(null)); }}>Stop</button></div>}
      </section>}
      <ServiceLogsDialog open={showLogs} onClose={() => setShowLogs(false)} service="stratum-bridge" title="Mining bridge logs" />
    </main>
  );
}

function EndpointField({ label, value, onChange, placeholder, disabled, kind }: { label: string; value: string; onChange: (value: string) => void; placeholder: string; disabled: boolean; kind: "zkas" | "kaspa" }) {
  const profiles = (kind === "zkas" ? miningNodeProfiles : kaspaNodeProfiles).load();
  return <label className="field-label">{label}<div className="endpoint-input-row"><input className="control-input mono" value={value} onChange={(event) => onChange(event.target.value)} placeholder={placeholder} disabled={disabled} />{profiles.length > 0 && <select aria-label={`Saved ${label}`} value="" disabled={disabled} onChange={(event) => event.target.value && onChange(event.target.value)}><option value="">Saved…</option>{profiles.map((profile) => <option value={profile.address} key={profile.id}>{profile.name}</option>)}</select>}</div></label>;
}

function EndpointCard({ icon, title, note, value, id, copied, onCopy }: { icon: React.ReactNode; title: string; note: string; value: string; id: string; copied: string; onCopy: (id: string, value: string) => void }) {
  return <div className="endpoint-card"><div className="endpoint-title">{icon}<span><b>{title}</b><small>{note}</small></span></div>{value ? <button onClick={() => void onCopy(id, value)}><code>{value}</code>{copied === id ? <Check size={15} /> : <Copy size={15} />}</button> : <span className="endpoint-unavailable">Unavailable</span>}</div>;
}

function Metric({ label, value }: { label: string; value: string }) {
  return <div className="metric"><span>{label}</span><strong>{value}</strong></div>;
}
