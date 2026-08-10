import { isDesktop } from "./desktop";

export interface ControlSettings {
  mode: "remote" | "custom" | "local";
  node_addr: string;
  node_binary: string | null;
  node_release: string | null;
  node_preset: "shielded" | "archival" | "mining";
  node_public_p2p: boolean;
  node_lan_rpc: boolean;
  node_auto_start: boolean;
  bridge_binary: string | null;
  bridge_release: string | null;
  miner_binary: string | null;
  explorer_binary: string | null;
  kaspa_mode: "disabled" | "local" | "custom";
  kaspa_node_addr: string;
  kaspa_node_binary: string | null;
  kaspa_public_p2p: boolean;
  kaspa_payout: string;
  mining_node_mode: "local" | "custom";
  mining_node_addr: string;
  stratum_port: number;
  min_share_diff: number;
  mining_auto_start: boolean;
  mining_mode: "solo" | "dual";
}

export interface ControlConfig {
  settings: ControlSettings;
  components: {
    zkas_node: boolean;
    zkas_node_update_available: boolean;
    bridge: boolean;
    bridge_update_available: boolean;
    zkas_miner: boolean;
    kaspa_node: boolean;
    explorer: boolean;
  };
  zkas_release: string;
  bridge_release: string;
  dual_mining_supported: boolean;
  data_dir: string;
}

export interface NodeStatus {
  running: boolean;
  managed: boolean;
  pid: number | null;
  rpc_addr: string;
  block_count: number | null;
  header_count: number | null;
  daa_score: number | null;
  peer_count: number | null;
  is_synced: boolean | null;
  mempool_size: number | null;
  sync_progress: number | null;
  difficulty: number | null;
  disk_bytes: number;
  error: string | null;
  last_exit: string | null;
}

export interface WalletdStatus {
  running: boolean;
  port: number;
  node_source: "remote" | "custom" | "local";
  node_rpc: string;
  node_connected: boolean | null;
  synced: boolean | null;
  scanning_progress: number | null;
  note_count: number | null;
  anchor_daa: number | null;
  balance: string | null;
  error: string | null;
}

export interface MiningStatus {
  mode: "solo" | "dual";
  bridge_running: boolean;
  bridge_pid: number | null;
  cpu_miner_running: boolean;
  cpu_miner_pid: number | null;
  kaspa_node_running: boolean;
  kaspa_node_pid: number | null;
  zkas_rpc: string;
  zkas_rpc_connected: boolean;
  zkas_synced: boolean | null;
  zkas_rpc_error: string | null;
  kaspa_rpc: string | null;
  kaspa_rpc_connected: boolean;
  kaspa_synced: boolean | null;
  kaspa_rpc_error: string | null;
  stratum_port: number;
  active_workers: number;
  shares_accepted: number;
  blocks_found: number;
  kas_blocks_found: number;
  network_hashrate: number;
  bridge_error: string | null;
}

export interface LocalNetworkInfo {
  lan_ip: string | null;
  lan_ips: string[];
}

export interface ServiceLog {
  at_unix_ms: number;
  service: string;
  stream: string;
  line: string;
}

export interface DownloadProgress {
  component: string;
  received: number;
  total: number | null;
  phase: string;
}

export interface SelfHostStatus {
  wallet_engine_running: boolean;
  wallet_engine_url: string | null;
  node_mode: "remote" | "custom" | "local";
  node_rpc: string;
  explorer_installed: boolean;
  explorer_running: boolean;
  explorer_pid: number | null;
  explorer_url: string;
  explorer_last_exit: string | null;
  gateway_release_available: boolean;
  data_dir: string;
  backup_dir: string;
  autostart_enabled: boolean;
  wallet_access: "device" | "lan" | "wan";
  wallet_access_port: number;
  wallet_public_url: string;
  wallet_access_url: string | null;
  wallet_access_token: string | null;
  lan_ip: string | null;
  lan_ips: string[];
  wallet_access_urls: string[];
  node_running: boolean;
  node_public_p2p: boolean;
  node_lan_rpc: boolean;
}

async function invoke<T>(command: string, args?: Record<string, unknown>): Promise<T> {
  if (!isDesktop()) throw new Error("This control is available in the desktop app.");
  const { invoke: tauriInvoke } = await import("@tauri-apps/api/core");
  try {
    return await tauriInvoke<T>(command, args);
  } catch (error) {
    throw new Error(typeof error === "string" ? error : error instanceof Error ? error.message : String(error));
  }
}

export const desktopServices = {
  config: () => invoke<ControlConfig>("control_config"),
  nodeStatus: () => invoke<NodeStatus>("node_status"),
  walletdStatus: () => invoke<WalletdStatus>("walletd_status"),
  miningStatus: () => invoke<MiningStatus>("mining_status"),
  logs: (service?: string, limit = 200) => invoke<ServiceLog[]>("service_logs", { service, limit }),
  install: (selection: { zkas: boolean; bridge: boolean; kaspa: boolean }) =>
    invoke("install_local_components", { selection }),
  startNode: (preset: "shielded" | "archival" | "mining", publicP2p: boolean) =>
    invoke<number>("start_node_preset", { preset, publicP2p }),
  stopNode: () => invoke<void>("stop_node"),
  setNodeOptions: (publicP2p: boolean, preset: "shielded" | "archival" | "mining") =>
    invoke<void>("set_node_options", { publicP2p, preset }),
  startSolo: (stratumPort: number, payoutAddress: string, minShareDiff: number, zkasMode: "local" | "custom", zkasNodeAddr?: string) =>
    invoke<number>("start_solo_mining", { stratumPort, payoutAddress, minShareDiff, zkasMode, zkasNodeAddr }),
  startDual: (
    stratumPort: number,
    zkasPayout: string,
    kaspaPayout: string,
    kaspaMode: "local" | "custom",
    kaspaNodeAddr?: string,
    minShareDiff = 8192,
    zkasMode: "local" | "custom" = "local",
    zkasNodeAddr?: string,
  ) => invoke<number>("start_dual_mining", { stratumPort, zkasPayout, kaspaPayout, kaspaMode, kaspaNodeAddr, minShareDiff, zkasMode, zkasNodeAddr }),
  stopMining: () => invoke<void>("stop_mining"),
  localNetworkInfo: () => invoke<LocalNetworkInfo>("local_network_info"),
  startCpuMiner: (threads: number, miningAddress: string) =>
    invoke<number>("start_cpu_miner", { threads, miningAddress }),
  stopCpuMiner: () => invoke<void>("stop_cpu_miner"),
  selfHostStatus: () => invoke<SelfHostStatus>("self_host_status"),
  setHostAccess: (options: {
    walletAccess: "device" | "lan" | "wan";
    walletAccessPort: number;
    walletPublicUrl: string;
    nodeLanRpc: boolean;
    nodePublicP2p: boolean;
  }) => invoke<void>("set_host_access", options),
  startExplorer: () => invoke<number>("start_explorer_backend"),
  stopExplorer: () => invoke<void>("stop_explorer_backend"),
  setAutostart: (enabled: boolean) => invoke<void>("set_desktop_autostart", { enabled }),
};
