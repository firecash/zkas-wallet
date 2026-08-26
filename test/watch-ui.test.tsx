// A view-only device, exercised through the REAL wallet.
//
// The guarantee is structural: this device holds a viewing key and no seed, so a
// spend signature is impossible rather than refused. These assert the UI matches
// that — it must not offer actions that end in a signature, and must not tell the
// user a balance is "ready to spend" when nothing here can spend it.

import { describe, expect, it, beforeEach, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { Status } from "../src/api";

const FVK = "ab".repeat(96);
const SEED = "cd".repeat(32);

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


async function mountApp() {
  const { default: App } = await import("../src/App");
  const { ToastHost } = await import("../src/toast");
  return render(<ToastHost><App /></ToastHost>);
}

function asViewer() {
  localStorage.setItem("wallet_token", "tok");
  localStorage.setItem("watch_fvk_tok", FVK);
  localStorage.removeItem("device_seed_tok");
}
function asOwner() {
  localStorage.setItem("wallet_token", "tok");
  localStorage.setItem("device_seed_tok", SEED);
  localStorage.removeItem("watch_fvk_tok");
}

beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
  statusOverride = {};
  vi.useRealTimers();
});

describe("a view-only device", () => {
  it("offers no way to send", async () => {
    asViewer();
    await mountApp();
    await screen.findByText(/Shielded balance/, {}, { timeout: 8000 });
    expect(screen.queryByRole("button", { name: "Send ZKAS" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Consolidate wallet notes" })).not.toBeInTheDocument();
    expect(screen.queryByRole("tab", { name: "Send" })).not.toBeInTheDocument();
  });

  it("says plainly that it cannot", async () => {
    asViewer();
    await mountApp();
    await screen.findByText(/Shielded balance/, {}, { timeout: 8000 });
    expect(screen.getByText("View only")).toBeInTheDocument();
    expect(screen.getByText(/cannot send/i)).toBeInTheDocument();
  });

  it("still shows the balance and can receive", async () => {
    asViewer();
    await mountApp();
    await screen.findByText(/Shielded balance/, {}, { timeout: 8000 });
    // Watching is the whole point, and an address is public — receiving is safe.
    expect(screen.getByRole("button", { name: "Receive ZKAS" })).toBeInTheDocument();
  });

  it("never claims the balance is ready to spend", async () => {
    asViewer();
    statusOverride = { maturing_sompi: "100000000", spend_ready: true, synced: true };
    await mountApp();
    await screen.findByText(/Shielded balance/, {}, { timeout: 8000 });
    expect(screen.queryByText(/ready to spend/i)).not.toBeInTheDocument();
  });

  it("offers no seed to reveal, since there is none", async () => {
    asViewer();
    await mountApp();
    await screen.findByText(/Shielded balance/, {}, { timeout: 8000 });
    await userEvent.click(screen.getByRole("tab", { name: "Settings" }));
    expect(await screen.findByText("View-only wallet")).toBeInTheDocument();
    expect(screen.queryByText("Recovery seed")).not.toBeInTheDocument();
    expect(screen.queryByText("Watch on another device")).not.toBeInTheDocument();
  });
});

describe("the version, where a user can find it", () => {
  it("appears in Settings with the platform, copyable", async () => {
    asOwner();
    await mountApp();
    await screen.findByText(/Shielded balance/, {}, { timeout: 8000 });
    await userEvent.click(screen.getByRole("tab", { name: "Settings" }));
    await userEvent.click(await screen.findByText("About ZKas"));
    const pkg = (await import("../package.json")).default as { version: string };
    const badge = await screen.findByText(`v${pkg.version}`);
    expect(badge).toBeInTheDocument();
    // "Web" appears elsewhere on the page too; assert the one beside the badge.
    expect(badge.parentElement?.textContent).toContain("Web");
    expect(screen.getByRole("button", { name: /Copy version/i })).toBeInTheDocument();
    expect(screen.getByText(/^Built \d{4}-\d{2}-\d{2}/)).toBeInTheDocument();
  });
});

describe("a device that holds the seed", () => {
  it("keeps every spending feature", async () => {
    asOwner();
    await mountApp();
    await screen.findByText(/Shielded balance/, {}, { timeout: 8000 });
    expect(screen.getByRole("button", { name: "Send ZKAS" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Consolidate wallet notes" })).toBeInTheDocument();
    expect(screen.queryByText("View only")).not.toBeInTheDocument();
  });

  it("exports the view key itself, not only a link", async () => {
    asOwner();
    await mountApp();
    await screen.findByText(/Shielded balance/, {}, { timeout: 8000 });
    await userEvent.click(screen.getByRole("tab", { name: "Settings" }));
    await userEvent.click(await screen.findByText("Watch on another device"));
    await userEvent.click(await screen.findByRole("button", { name: /Show the link/i }));
    // A link is for a phone; the bare key is what another tool needs.
    expect(await screen.findByRole("button", { name: /Copy view key/i }, { timeout: 8000 })).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: /Show view key/i }));
    expect(await screen.findByText(/^[0-9a-f]{192}$/i)).toBeInTheDocument();
  });

  it("can share a view of itself", async () => {
    asOwner();
    await mountApp();
    await screen.findByText(/Shielded balance/, {}, { timeout: 8000 });
    await userEvent.click(screen.getByRole("tab", { name: "Settings" }));
    expect(await screen.findByText("Watch on another device")).toBeInTheDocument();
    await waitFor(() => expect(screen.getByText("Recovery seed")).toBeInTheDocument());
  });
});
