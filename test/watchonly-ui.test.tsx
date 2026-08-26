// The wallet as a VIEWER sees it. A view-only device holds no spending key, so
// the guarantee is structural — but the UI must not offer what cannot work, and
// must not imply the balance is spendable from here.

import { describe, expect, it, beforeEach, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import type { Status } from "../src/api";

const ADDRESS = "zkas:p8a4neush78c56rcqraed3esy280ar2xatee3zucz39hyyxgjz80ph6mfj0430v4r3ek6qgj8dkk0ll";
const FVK = "ab".repeat(96);

function base(over: Partial<Status> = {}): Status {
  return {
    has_wallet: true, address: ADDRESS, network: "mainnet", node_connected: true,
    daa_score: 1000, synced: true, warming: false, scanned_blocks: 1000, chain_len: 1000,
    balance_sompi: "500000000", balance_fc: "5.00000000", spendable_fc: "5.00000000",
    maturing_fc: "0", note_count: 4, updated_unix: 1, error: null, ...over,
  } as Status;
}

vi.mock("../src/api", async (orig) => {
  const actual = await orig<typeof import("../src/api")>();
  return {
    ...actual,
    api: {
      status: vi.fn(async () => base()),
      history: vi.fn(async () => ({ recoverableHistory: true, total: 0, rows: [], pendingOutgoing: [] })),
      balance: vi.fn(async () => ({})),
      setHistoryEnabled: vi.fn(async () => ({ recoverableHistory: true })),
      rescan: vi.fn(async () => ({ rescanning: true })),
      watch: vi.fn(async () => ({ address: ADDRESS })),
      send: vi.fn(), prepare: vi.fn(), submit: vi.fn(), sign: vi.fn(), verify: vi.fn(),
    },
    chainTx: vi.fn(async () => null),
  };
});
vi.mock("../src/signer", () => ({
  fvkHex: async () => FVK,
  generateWallet: async () => ({ seedHex: "cd".repeat(32), address: ADDRESS }),
  signLocal: async () => ({ address: ADDRESS, signature: "sig" }),
  verifyLocal: async () => ({ valid: true, reason: null }),
  ensureSigner: async () => {},
}));

async function mount() {
  const { default: App } = await import("../src/App");
  const { ToastHost } = await import("../src/toast");
  return render(<ToastHost><App /></ToastHost>);
}

beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
  localStorage.setItem("wallet_token", "viewer");
  vi.useRealTimers();
});

describe("a view-only wallet", () => {
  it("shows the balance", async () => {
    localStorage.setItem("watch_fvk_viewer", FVK);
    await mount();
    expect(await screen.findByText(/Shielded balance/, {}, { timeout: 8000 })).toBeInTheDocument();
  });

  it("offers no way to send or consolidate", async () => {
    localStorage.setItem("watch_fvk_viewer", FVK);
    await mount();
    await screen.findByText(/Shielded balance/, {}, { timeout: 8000 });
    expect(screen.queryByRole("button", { name: "Send ZKAS" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Consolidate wallet notes" })).not.toBeInTheDocument();
    expect(screen.queryByRole("tab", { name: "Send" })).not.toBeInTheDocument();
    // ...and says why, rather than leaving a gap.
    expect(screen.getByText("View only")).toBeInTheDocument();
  });

  it("still offers Receive, because an address is public", async () => {
    localStorage.setItem("watch_fvk_viewer", FVK);
    await mount();
    await screen.findByText(/Shielded balance/, {}, { timeout: 8000 });
    expect(screen.getByRole("button", { name: "Receive ZKAS" })).toBeInTheDocument();
  });

  it("keeps every spending control when the device DOES hold a seed", async () => {
    // Same view key, but a seed as well: an ordinary wallet that merely knows its
    // own view key must not be crippled.
    localStorage.setItem("watch_fvk_viewer", FVK);
    localStorage.setItem("device_seed_viewer", "cd".repeat(32));
    await mount();
    await screen.findByText(/Shielded balance/, {}, { timeout: 8000 });
    expect(screen.getByRole("button", { name: "Send ZKAS" })).toBeInTheDocument();
    expect(screen.queryByText("View only")).not.toBeInTheDocument();
  });

  it("does not offer to reveal a seed it does not have", async () => {
    localStorage.setItem("watch_fvk_viewer", FVK);
    await mount();
    await screen.findByText(/Shielded balance/, {}, { timeout: 8000 });
    await waitFor(() => expect(screen.getByRole("tab", { name: "Settings" })).toBeInTheDocument());
    const { default: userEvent } = await import("@testing-library/user-event");
    await userEvent.click(screen.getByRole("tab", { name: "Settings" }));
    expect(await screen.findByText("View-only wallet")).toBeInTheDocument();
    expect(screen.queryByText("Recovery seed")).not.toBeInTheDocument();
    expect(screen.queryByText("Watch on another device")).not.toBeInTheDocument();
  });
});
