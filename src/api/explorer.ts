// Public ZKas explorer client.
//
// Browser/mobile builds call the public HTTPS API. Tauri's CSP deliberately does
// not allow arbitrary internet hosts, so desktop sends the same allow-listed path
// through a tiny native relay. Keeping the contract here (instead of copying the
// explorer website's React Query internals) gives every platform identical data.

const DEFAULT_EXPLORER_BASE = "https://wallet.zkas.info/chain";

function isDesktop(): boolean {
  return "__TAURI_INTERNALS__" in globalThis;
}

function getExplorerBase(): string {
  const configured = localStorage.getItem("explorer_base");
  if (configured) return configured;
  // The hosted web wallet already exposes the explorer through /chain. Using
  // that same-origin route keeps the strict wallet CSP intact and avoids a
  // second CORS/network dependency. Native mobile has no web origin proxy and
  // Tauri has its allow-listed Rust relay, so both retain the public API URL.
  if (!isDesktop() && typeof window !== "undefined" && window.location.hostname === "wallet.zkas.info") {
    return `${window.location.origin}/chain`;
  }
  return DEFAULT_EXPLORER_BASE;
}

export function setExplorerBase(url: string): void {
  const normalized = url.trim().replace(/\/+$/, "");
  if (normalized) localStorage.setItem("explorer_base", normalized);
  else localStorage.removeItem("explorer_base");
}

export function explorerBase(): string {
  return getExplorerBase();
}

async function explorerGet<T>(path: string, timeoutMs = 10_000): Promise<T> {
  if (isDesktop() && getExplorerBase() === DEFAULT_EXPLORER_BASE) {
    const { invoke } = await import("@tauri-apps/api/core");
    return invoke<T>("public_explorer_get", { path });
  }
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const response = await fetch(`${getExplorerBase()}${path}`, {
      signal: ctrl.signal,
      headers: { Accept: "application/json" },
    });
    const text = await response.text();
    let body: unknown = null;
    if (text) {
      try {
        body = JSON.parse(text);
      } catch {
        throw new Error(`Explorer returned an invalid response (${response.status}).`);
      }
    }
    if (!response.ok) {
      const message = body && typeof body === "object" && "error" in body ? String((body as { error: unknown }).error) : response.statusText;
      throw new Error(message || `Explorer request failed (${response.status}).`);
    }
    return body as T;
  } finally {
    clearTimeout(timer);
  }
}

export interface BlockdagInfo {
  networkName: string;
  blockCount: string;
  headerCount: string;
  tipHashes: string[];
  difficulty: number;
  pastMedianTime: string;
  virtualParentHashes: string[];
  pruningPointHash: string[];
  virtualDaaScore: string;
  sink: string;
}

export interface NetworkInfo {
  nodes: number;
  connectedPeers: number;
  peerNets: string[];
  userAgents: string[];
}

export interface MapNode {
  id: string;
  country: string | null;
  countryName: string | null;
  lat: number | null;
  lon: number | null;
  self: boolean;
}

export interface NodesInfo {
  updatedAt: number;
  totals: { nodes: number; peers: number; countries: number; located: number; inbound: number; outbound: number };
  nodes: MapNode[];
  countries: { code: string; name: string; count: number; share: number; lat: number; lon: number }[];
}

export interface RelayInfo {
  mempoolSize: number | null;
  activePeers: number | null;
  blocksIngested: number | null;
  transactionsProcessed: number | null;
}

export interface BlockSummary {
  block_hash: string;
  difficulty: number;
  daaScore: string;
  blueScore: string;
  timestamp: string;
  txCount: number;
  txs: { txId: string; outputs: [string, string][] }[];
}

export interface BlockDetail {
  block_hash: string;
  header: {
    hash: string;
    version: number;
    timestamp: number;
    daaScore: string;
    blueScore: string;
    blueWork: string;
    bits: number;
    nonce: string;
    pruningPoint: string;
    hashMerkleRoot: string;
    acceptedIdMerkleRoot: string;
    utxoCommitment: string;
    parents: { parentHashes: string[] }[];
  };
  verboseData: {
    difficulty: number;
    selectedParentHash: string;
    transactionIds: string[];
    isChainBlock: boolean;
    childrenHashes: string[];
    mergeSetBluesHashes: string[];
    mergeSetRedsHashes: string[];
  };
  transactions: {
    shielded?: boolean;
    verboseData?: { transactionId?: string; hash?: string; mass?: number };
  }[];
}

export interface TransactionDetail {
  transaction_id: string;
  hash: string;
  mass: string;
  block_hash: string[];
  block_time: number;
  is_accepted: boolean;
  confirmations: number;
  accepting_block_hash?: string;
  accepting_block_blue_score: number;
  outputs: null | {
    index: number;
    amount: number;
    script_public_key_address: string;
    script_public_key_type: string;
  }[];
}

export interface ShieldedPoolInfo {
  anchor: string | null;
  nullifierCount: number;
  noteCount: number;
  /** Exact sompi, not ZKAS. */
  turnstileIn: string;
  turnstileOut: string;
  emissionPerBlock: number;
  blueScore: string;
}

export interface HalvingInfo {
  nextHalvingTimestamp: number;
  nextHalvingDate: string;
  nextHalvingAmount: number;
}

export interface CoinSupplyInfo {
  /** Exact sompi. */
  circulatingSupply: string;
  maxSupply: null;
  emissionModel: "perpetual-tail";
}

export interface PulseInfo {
  blocks15m: number;
  bps15m: number;
  averageBlockTime15m: number;
  transactions15m: number;
  transactions1h: number;
  workWindowSeconds: number;
  workBinSeconds: number;
  workDifficultyBins: number[];
  workHashrateBins: number[];
  timestamp: number;
}

export const explorerApi = {
  blockdag: () => explorerGet<BlockdagInfo>("/info/blockdag"),
  network: () => explorerGet<NetworkInfo>("/info/network"),
  nodes: () => explorerGet<NodesInfo>("/info/nodes"),
  relay: () => explorerGet<RelayInfo>("/info/relay"),
  recentBlocks: () => explorerGet<BlockSummary[]>("/blocks/recent"),
  block: (id: string) => explorerGet<BlockDetail>(`/blocks/${encodeURIComponent(id)}`),
  transaction: (id: string) => explorerGet<TransactionDetail>(`/transactions/${encodeURIComponent(id)}`),
  shieldedPool: () => explorerGet<ShieldedPoolInfo>("/info/shielded"),
  halving: () => explorerGet<HalvingInfo>("/info/halving"),
  coinSupply: () => explorerGet<CoinSupplyInfo>("/info/coinsupply"),
  pulse: (window = "15m") => explorerGet<PulseInfo>(`/info/pulse?window=${encodeURIComponent(window)}`),
};
