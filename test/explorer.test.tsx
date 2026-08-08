import { render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";

const { blockdag } = vi.hoisted(() => ({
  blockdag: vi.fn(async () => ({
    networkName: "mainnet", blockCount: "10", headerCount: "10", tipHashes: [], difficulty: 1,
    pastMedianTime: "0", virtualParentHashes: [], pruningPointHash: [], virtualDaaScore: "10", sink: "00",
  })),
}));

vi.mock("../src/api/explorer", () => ({
  explorerApi: {
    blockdag,
    network: vi.fn(async () => ({ nodes: 1, connectedPeers: 1, peerNets: [], userAgents: [] })),
    nodes: vi.fn(async () => ({ updatedAt: 0, totals: { nodes: 1, peers: 1, countries: 1, located: 1, inbound: 1, outbound: 0 }, nodes: [], countries: [] })),
    relay: vi.fn(async () => ({ mempoolSize: 0, activePeers: 1, blocksIngested: 1, transactionsProcessed: 1 })),
    shieldedPool: vi.fn(async () => ({ anchor: null, nullifierCount: 0, noteCount: 0, turnstileIn: "0", turnstileOut: "0", emissionPerBlock: 1, blueScore: "10" })),
    halving: vi.fn(async () => ({ nextHalvingTimestamp: 0, nextHalvingDate: "later", nextHalvingAmount: 1 })),
    coinSupply: vi.fn(async () => ({ circulatingSupply: "0", maxSupply: null, emissionModel: "perpetual-tail" })),
    pulse: vi.fn(async () => ({ blocks15m: 1, bps15m: 1, averageBlockTime15m: 1, transactions15m: 1, transactions1h: 1, workWindowSeconds: 3600, workBinSeconds: 60, workDifficultyBins: [1, 1], workHashrateBins: [2, 2], timestamp: 0 })),
    recentBlocks: vi.fn(async () => []),
    transaction: vi.fn(),
    block: vi.fn(),
  },
}));

import { Explorer } from "../src/pages/Explorer";

afterEach(() => {
  localStorage.clear();
  vi.clearAllMocks();
});

describe("explorer dashboard", () => {
  it("refreshes once on mount without entering a request loop", async () => {
    render(
      <MemoryRouter initialEntries={["/explore"]}>
        <Routes><Route path="/explore" element={<Explorer />} /></Routes>
      </MemoryRouter>,
    );
    await waitFor(() => expect(screen.getByText("Live")).toBeInTheDocument());
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(blockdag).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("searchbox")).not.toBeInTheDocument();
  });
});
