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

/**
 * Is this base a locally-run explorer — something that only exists while the user's own
 * machine is serving it?
 *
 * Such a base is allowed to disappear, and when it does the wallet must go back to the
 * public API on its own. A remote base the user typed deliberately is NOT second-guessed.
 */
function isLocalBase(base: string): boolean {
  try {
    const host = new URL(base).hostname.replace(/^\[|\]$/g, "").toLowerCase();
    return host === "localhost" || host === "::1" || /^127\./.test(host);
  } catch {
    return false;
  }
}

/// Consecutive failures of a locally-configured explorer, reset by any success.
let localMisses = 0;
/// The dashboard fires eight requests per refresh, so this is well under one refresh —
/// deliberately: a base that cannot answer a single panel is not serving the wallet.
const LOCAL_MISSES_BEFORE_GIVING_UP = 12;

async function explorerGet<T>(path: string, timeoutMs = 10_000): Promise<T> {
  if (isDesktop() && getExplorerBase() === DEFAULT_EXPLORER_BASE) {
    const { invoke } = await import("@tauri-apps/api/core");
    return invoke<T>("public_explorer_get", { path });
  }
  // A locally-served explorer that has stopped answering must not strand the app on it.
  //
  // Running a node in the desktop app points `explorer_base` at that local explorer, and
  // the only code that cleared it ran AFTER `stopExplorer()` returned — so quitting the
  // app, stopping the node any other way, or an error inside that call left the override
  // in localStorage permanently. Every panel then failed against a dead port and the
  // dashboard fell back to its cached snapshot: blocks 40 HOURS old, on a wallet whose
  // phone showed the same screen up to date, because the phone never had a local node.
  //
  // Correctness cannot depend on one toggle's happy path completing. If the local base is
  // unreachable and the public API answers, the override is stale by demonstration —
  // drop it and carry on there.
  const configured = getExplorerBase();
  if (isLocalBase(configured)) {
    try {
      const live = await explorerFetch<T>(configured, path, timeoutMs);
      localMisses = 0;
      return live;
    } catch {
      // Serve from the public API immediately, but do NOT discard the user's setting on
      // one failure: a local explorer restarting, or briefly busy, is not a local
      // explorer that is gone, and silently un-configuring it would be its own bug.
      // Only a base that keeps failing has demonstrated it is stale.
      const viaPublic = await explorerFetch<T>(DEFAULT_EXPLORER_BASE, path, timeoutMs);
      if (++localMisses >= LOCAL_MISSES_BEFORE_GIVING_UP) {
        setExplorerBase("");
        localMisses = 0;
      }
      return viaPublic;
    }
  }
  return explorerFetch<T>(configured, path, timeoutMs);
}

async function explorerFetch<T>(base: string, path: string, timeoutMs: number): Promise<T> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const response = await fetch(`${base}${path}`, {
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
