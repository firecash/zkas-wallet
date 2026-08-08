import { create } from "zustand";
import { api, type Status, type ChainHistory } from "../api";
import { loadTxs, recordSend, reconcile, pendingTotal, saveSnapshot, loadSnapshot, type LocalTx } from "../localtx";
import { loadStatusCache, saveStatusCache } from "../api";
import { activeToken, listWallets, ensureRegistered, type WalletRef } from "../wallets";
import { arrivalAmount } from "../status";
import { snapshotDirty, sameStatus, sameTxs } from "../lib/statushelpers";

interface WalletStore {
  status: Status | null;
  reachable: boolean | null;
  txs: LocalTx[];
  chainHistory: ChainHistory | null;
  activeWallet: WalletRef | null;
  wallets: WalletRef[];
  justSent: string | null;
  sendPrefill: string | null;
  polling: boolean;

  refresh: () => Promise<void>;
  setJustSent: (txid: string | null) => void;
  setSendPrefill: (addr: string | null) => void;
  recordSent: (txs: Omit<LocalTx, "pending">[]) => void;
  loadWallets: () => void;
}

export const useWalletStore = create<WalletStore>((set, get) => ({
  status: loadStatusCache(),
  reachable: loadStatusCache() ? true : null,
  txs: loadTxs(),
  chainHistory: null,
  activeWallet: null,
  wallets: listWallets(),
  justSent: null,
  sendPrefill: null,
  polling: false,

  refresh: async () => {
    try {
      const status = await api.status();
      if (status) {
        const prev = get().status;
        if (!prev || !sameStatus(prev, status)) {
          set({ status });
        }
        saveStatusCache(status);
        set({ reachable: true });

        // Reconcile local txs
        const txs = reconcile(parseFloat(status.balance_fc || "0"), !!status.synced);
        const prevTxs = get().txs;
        if (!sameTxs(prevTxs, txs)) {
          set({ txs });
        }

        // Save snapshot if changed
        if (snapshotDirty(status)) {
          saveSnapshot({
            balanceFc: parseFloat(status.balance_fc || "0"),
            spendableFc: parseFloat(status.spendable_fc || status.balance_fc || "0"),
            maturingFc: parseFloat(status.maturing_fc || "0"),
            noteCount: status.note_count,
            ts: Date.now(),
          });
        }

        // Ensure wallet is registered
        if (status.has_wallet && status.address) {
          ensureRegistered(activeToken() || "", status.address);
        }
      }
    } catch {
      set({ reachable: false });
    }
  },

  setJustSent: (txid) => set({ justSent: txid }),
  setSendPrefill: (addr) => set({ sendPrefill: addr }),

  recordSent: (newTxs) => {
    for (const t of newTxs) {
      recordSend(t);
    }
    set({ txs: loadTxs() });
  },

  loadWallets: () => {
    set({ wallets: listWallets(), activeWallet: listWallets().find(w => w.token === activeToken()) ?? null });
  },
}));
