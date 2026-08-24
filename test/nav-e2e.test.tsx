// The mobile nav, end to end: the REAL router mounting the REAL wallet.
//
// The Settings bounce lived exactly here and no test saw it — settings-route
// mounted a stub wallet, and wallet.test.tsx mounted the wallet with no router.
// Each half passed while the combination was broken, which is the whole lesson.

import { describe, expect, it, beforeEach, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { HashRouter, Routes, Route, useLocation, useNavigate } from "react-router-dom";
import type { Status } from "../src/api";
import { WalletRoute } from "../src/WalletRoute";
import { useHashRouterSync } from "../src/hashsync";

const ADDRESS = "zkas:p8a4neush78c56rcqraed3esy280ar2xatee3zucz39hyyxgjz80ph6mfj0430v4r3ek6qgj8dkk0ll";
const OTHER = "zkas:pxqyg2wne2q87knpg2z046azzvr6rfrlues72te646kx2ws0vmskk4q8ntweayy6ps6c9vg97fphz7y";

function status(over: Partial<Status> = {}): Status {
  return {
    has_wallet: true,
    address: ADDRESS,
    network: "mainnet",
    node_connected: true,
    daa_score: 1000,
    synced: true,
    warming: false,
    scanned_blocks: 1000,
    chain_len: 1000,
    balance_sompi: "500000000",
    balance_fc: "5.00000000",
    spendable_fc: "5.00000000",
    maturing_fc: "0",
    note_count: 1,
    updated_unix: Math.floor(Date.now() / 1000),
    error: null,
    ...over,
  };
}

/** Count renders of the whole app, to catch a poll that re-renders needlessly. */
let renderCount = 0;
/** What the next status poll reports — lets a test walk the app through state
 * transitions (restoring → synced) instead of a single frozen snapshot. */
let statusOverride: Partial<Status> = {};

vi.mock("../src/api", async (orig) => {
  const actual = await orig<typeof import("../src/api")>();
  return {
    ...actual,
    api: {
      status: vi.fn(async () => {
        renderCount++; // one poll = one status call
        return status(statusOverride);
      }),
      history: vi.fn(async () => ({ recoverableHistory: true, total: 0, rows: [], pendingOutgoing: [] })),
      balance: vi.fn(async () => ({})),
      setHistoryEnabled: vi.fn(async () => ({ recoverableHistory: true })),
      rescan: vi.fn(async () => ({ rescanning: true })),
      watch: vi.fn(async () => ({ address: ADDRESS })),
      create: vi.fn(async () => ({ address: ADDRESS, seed_hex: "ab".repeat(32), network: "mainnet", warning: "" })),
      reveal: vi.fn(async () => ({ address: ADDRESS, seed_hex: "ab".repeat(32), network: "mainnet" })),
      send: vi.fn(async () => ({ txid: "f".repeat(64), amount_sompi: 1, fee_sompi: 1 })),
      prepare: vi.fn(),
      submit: vi.fn(),
      sign: vi.fn(),
      verify: vi.fn(),
    },
    chainTx: vi.fn(async () => null),
  };
});

// The signer is a WASM module; the UI paths under test never need real keys.
vi.mock("../src/signer", () => ({
  fvkHex: async () => "00".repeat(96),
  generateWallet: async () => ({ seedHex: "ab".repeat(32), address: ADDRESS }),
  signLocal: async () => ({ address: ADDRESS, signature: "sig" }),
  verifyLocal: async () => ({ valid: true, reason: null }),
  ensureSigner: async () => {},
}));


// Mirrors AppShell: navigation and highlighting both come from the router.
function Nav() {
  const navigate = useNavigate();
  const location = useLocation();
  useHashRouterSync();
  return (
    <div>
      <span data-testid="path">{location.pathname}</span>
      <button data-testid="nav-wallet" onClick={() => navigate("/")}>nav wallet</button>
      <button data-testid="nav-settings" aria-current={location.pathname === "/settings" ? "page" : undefined}
        onClick={() => navigate("/settings")}>nav settings</button>
    </div>
  );
}

async function mountShell() {
  const { ToastHost } = await import("../src/toast");
  return render(
    <ToastHost>
      <HashRouter>
        <Nav />
        <Routes>
          <Route path="/" element={<WalletRoute />} />
          <Route path="/settings" element={<WalletRoute />} />
        </Routes>
      </HashRouter>
    </ToastHost>,
  );
}

beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
  localStorage.setItem("wallet_token", "testtoken");
  statusOverride = {};
  window.location.hash = "#/";
  vi.useRealTimers();
});

describe("the mobile nav, for real", () => {
  it("opens Settings and STAYS there", async () => {
    await mountShell();
    await screen.findByText(/Shielded balance/, {}, { timeout: 8000 });

    await userEvent.click(screen.getByTestId("nav-settings"));

    expect(await screen.findByText("Recovery seed", {}, { timeout: 8000 })).toBeInTheDocument();
    // The bug: it bounced back to the wallet within a tick.
    await new Promise((r) => setTimeout(r, 80));
    expect(screen.getByText("Recovery seed")).toBeInTheDocument();
    expect(screen.queryByText(/Shielded balance/)).not.toBeInTheDocument();
    expect(screen.getByTestId("path")).toHaveTextContent("/settings");
    expect(screen.getByTestId("nav-settings")).toHaveAttribute("aria-current", "page");
  });

  it("goes back to the wallet, and Settings can be opened again", async () => {
    await mountShell();
    await screen.findByText(/Shielded balance/, {}, { timeout: 8000 });
    await userEvent.click(screen.getByTestId("nav-settings"));
    await screen.findByText("Recovery seed", {}, { timeout: 8000 });

    await userEvent.click(screen.getByRole("button", { name: "← Wallet" }));
    expect(await screen.findByText(/Shielded balance/, {}, { timeout: 8000 })).toBeInTheDocument();
    await waitFor(() => expect(screen.getByTestId("path")).toHaveTextContent("/"));

    // A stale router would make this second tap do nothing.
    await userEvent.click(screen.getByTestId("nav-settings"));
    expect(await screen.findByText("Recovery seed", {}, { timeout: 8000 })).toBeInTheDocument();
  });

  it("leaves the wallet on the tab the user had open underneath", async () => {
    await mountShell();
    await screen.findByText(/Shielded balance/, {}, { timeout: 8000 });
    await userEvent.click(screen.getByTestId("nav-settings"));
    await screen.findByText("Recovery seed", {}, { timeout: 8000 });
    await userEvent.click(screen.getByTestId("nav-wallet"));
    // Settings was never a tab, so nothing about the wallet moved.
    expect(await screen.findByText(/Shielded balance/, {}, { timeout: 8000 })).toBeInTheDocument();
  });

  it("What's New opens the same screen, through a raw hash write", async () => {
    await mountShell();
    await screen.findByText(/Shielded balance/, {}, { timeout: 8000 });
    window.location.hash = "#/settings";
    expect(await screen.findByText("Recovery seed", {}, { timeout: 8000 })).toBeInTheDocument();
    await waitFor(() => expect(screen.getByTestId("path")).toHaveTextContent("/settings"));
  });
});
