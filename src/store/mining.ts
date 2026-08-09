import { create } from "zustand";
import { STRATUM_PORT } from "../ports";

export interface PoolStats {
  miners_active: number;
  workers_active: number;
  hashrate_hs: number;
  accepted_shares: number;
  blocks: {
    found: number;
    matured: number;
    orphaned: number;
  };
}

export interface MinerStats {
  hashrate_hs: number;
  accepted_shares: number;
  rejected_shares: number;
  workers_count: number;
  kas: {
    allocated: { sompi: string; kas: string };
    paid: { sompi: string; kas: string };
    payable: { sompi: string; kas: string };
  };
}

interface MiningStore {
  mode: "solo" | "pool" | "dual" | null;
  nodeRunning: boolean;
  bridgeRunning: boolean;
  minerRunning: boolean;
  hashrate: number;
  sharesAccepted: number;
  sharesRejected: number;
  blocksFound: number;
  bestShare: number;
  stratumPort: number;
  poolStats: PoolStats | null;
  minerStats: MinerStats | null;

  setMode: (mode: "solo" | "pool" | "dual") => void;
  setNodeRunning: (running: boolean) => void;
  setBridgeRunning: (running: boolean) => void;
  setMinerRunning: (running: boolean) => void;
  setHashrate: (hr: number) => void;
  setShares: (accepted: number, rejected: number) => void;
  setBlocksFound: (n: number) => void;
  setPoolStats: (s: PoolStats | null) => void;
  setMinerStats: (s: MinerStats | null) => void;
}

export const useMiningStore = create<MiningStore>((set) => ({
  mode: null,
  nodeRunning: false,
  bridgeRunning: false,
  minerRunning: false,
  hashrate: 0,
  sharesAccepted: 0,
  sharesRejected: 0,
  blocksFound: 0,
  bestShare: 0,
  stratumPort: STRATUM_PORT,
  poolStats: null,
  minerStats: null,

  setMode: (mode) => set({ mode }),
  setNodeRunning: (running) => set({ nodeRunning: running }),
  setBridgeRunning: (running) => set({ bridgeRunning: running }),
  setMinerRunning: (running) => set({ minerRunning: running }),
  setHashrate: (hr) => set({ hashrate: hr }),
  setShares: (accepted, rejected) => set({ sharesAccepted: accepted, sharesRejected: rejected }),
  setBlocksFound: (n) => set({ blocksFound: n }),
  setPoolStats: (s) => set({ poolStats: s }),
  setMinerStats: (s) => set({ minerStats: s }),
}));
