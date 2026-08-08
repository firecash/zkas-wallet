// Second sweep: flows the first suite didn't touch. Written to FIND bugs, so
// each case asserts what a user would expect rather than what the code does.

import { describe, expect, it, beforeEach, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { Status } from "../src/api";

const ADDRESS = "zkas:p8a4neush78c56rcqraed3esy280ar2xatee3zucz39hyyxgjz80ph6mfj0430v4r3ek6qgj8dkk0ll";
const OTHER = "zkas:pxqyg2wne2q87knpg2z046azzvr6rfrlues72te646kx2ws0vmskk4q8ntweayy6ps6c9vg97fphz7y";

let current: Status;
function base(over: Partial<Status> = {}): Status {
  return {
    has_wallet: true, address: ADDRESS, network: "mainnet", node_connected: true,
    daa_score: 1000, synced: true, warming: false, scanned_blocks: 1000, chain_len: 1000,
    balance_sompi: "500000000", balance_fc: "5.00000000", spendable_fc: "5.00000000",
    maturing_fc: "0", note_count: 1, updated_unix: 1, error: null, ...over,
  };
}

const historyRows = [
  { kind: "received" as const, txid: "a".repeat(64), daaScore: 900, timestamp: Date.now() - 60000,
    amountSompi: 200000000, amountZkas: 2, feeSompi: 0, recipient: ADDRESS, memo: "rent" },
  { kind: "sent" as const, txid: "b".repeat(64), daaScore: 950, timestamp: Date.now() - 30000,
    amountSompi: 100000000, amountZkas: 1, feeSompi: 3000000, recipient: OTHER, memo: null },
];

vi.mock("../src/api", async (orig) => {
  const actual = await orig<typeof import("../src/api")>();
  return {
    ...actual,
    api: {
      status: vi.fn(async () => current),
      history: vi.fn(async () => ({ recoverableHistory: true, total: historyRows.length, rows: historyRows, pendingOutgoing: [] })),
      setHistoryEnabled: vi.fn(async () => ({ recoverableHistory: true })),
      rescan: vi.fn(async () => ({ rescanning: true })),
      watch: vi.fn(async () => ({ address: ADDRESS })),
      create: vi.fn(async () => ({ address: ADDRESS, seed_hex: "ab".repeat(32), network: "mainnet", warning: "" })),
      reveal: vi.fn(async () => ({ address: ADDRESS, seed_hex: "ab".repeat(32), network: "mainnet" })),
      send: vi.fn(), prepare: vi.fn(), submit: vi.fn(), sign: vi.fn(), verify: vi.fn(), balance: vi.fn(),
    },
    chainTx: vi.fn(async () => null),
  };
});
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

beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
  localStorage.setItem("wallet_token", "t1");
  current = base();
});

describe("history", () => {
  it("lists rows and opens a transaction's details", async () => {
    const user = userEvent.setup();
    await mountApp();
    await user.click(await screen.findByRole("tab", { name: "History" }));
    expect(await screen.findByText(/rent/)).toBeInTheDocument();
    // Tapping a row must open the detail sheet, not navigate away.
    await user.click(screen.getByText(/rent/));
    await waitFor(() => expect(document.querySelector(".modalwrap")).not.toBeNull());
    expect(screen.getByText(/View on explorer/)).toBeInTheDocument();
  });

  it("shows a contact's name instead of a raw address", async () => {
    const user = userEvent.setup();
    const { addContact } = await import("../src/contacts");
    addContact("Bob", OTHER);
    await mountApp();
    await user.click(await screen.findByRole("tab", { name: "History" }));
    expect(await screen.findByText(/Bob/)).toBeInTheDocument();
  });
});

describe("receive", () => {
  it("shows the address, a copy action, and the privacy assurance", async () => {
    const user = userEvent.setup();
    await mountApp();
    await user.click(await screen.findByRole("button", { name: "Receive ZKAS" }));
    // The address itself, and the one-tap copy the sharing flow depends on.
    expect(await screen.findByText(/Copy address/)).toBeInTheDocument();
    // The privacy promise that distinguishes this wallet, right where you share.
    expect(screen.getByText(/Nobody can see this coming/i)).toBeInTheDocument();
    // The removed "request a specific amount" flow must be gone, not merely hidden.
    expect(screen.queryByText(/Request a specific amount/i)).toBeNull();
  });
});

describe("balance truthfulness", () => {
  it("never renders a daemon's 'still loading' zeros as an empty wallet", async () => {
    const { saveSnapshot } = await import("../src/localtx");
    saveSnapshot({ balanceFc: 5, spendableFc: 5, maturingFc: 0, noteCount: 1, ts: Date.now() });
    current = base({ scanned_blocks: 0, synced: false, balance_fc: "0", note_count: 0 });
    await mountApp();
    // The last known balance is shown, and the wallet says it is still working
    // rather than presenting the daemon's zeros as an empty wallet. Asserted on
    // MEANING, not wording: the exact phrasing lives in `status.ts` and is allowed
    // to improve without breaking this guarantee.
    expect(await screen.findByText(/opening your wallet|setting up|catching up/i)).toBeInTheDocument();
    expect(screen.queryByText("0.00000000")).toBeNull();
  });

  it("separates what can be spent now from what is still arriving", async () => {
    current = base({ balance_fc: "5.00000000", spendable_fc: "1.00000000", maturing_fc: "4.00000000" });
    await mountApp();
    // "maturing" was our word for it; a user reads "ready to spend" and "arriving".
    expect(await screen.findByText(/ready to spend/i)).toBeInTheDocument();
    expect(await screen.findByText(/arriving/i)).toBeInTheDocument();
  });
});

describe("settings", () => {
  it("offers backup, app lock, wallets and appearance", async () => {
    const user = userEvent.setup();
    await mountApp();
    await user.click(await screen.findByRole("tab", { name: "Settings" }));
    expect(await screen.findByText(/App lock/)).toBeInTheDocument();
    expect(screen.getByText(/Wallets/)).toBeInTheDocument();
    expect(screen.getByText(/Appearance/)).toBeInTheDocument();
    expect(screen.getByText(/Contacts/)).toBeInTheDocument();
  });

  it("theme choice sticks and applies to the document", async () => {
    const user = userEvent.setup();
    await mountApp();
    await user.click(await screen.findByRole("tab", { name: "Settings" }));
    await user.click(await screen.findByRole("button", { name: "Light" }));
    expect(document.documentElement.getAttribute("data-theme")).toBe("light");
    await user.click(screen.getByRole("button", { name: "Dark" }));
    expect(document.documentElement.getAttribute("data-theme")).toBeNull();
  });
});

describe("onboarding", () => {
  it("offers create and restore when there is no wallet", async () => {
    current = base({ has_wallet: false, address: null });
    await mountApp();
    expect(await screen.findByText(/Create new wallet/)).toBeInTheDocument();
    expect(screen.getByText(/Import from seed/)).toBeInTheDocument();
  });

  it("import accepts a pasted seed and keeps it", async () => {
    const user = userEvent.setup();
    current = base({ has_wallet: false, address: null });
    await mountApp();
    await user.click(await screen.findByText(/Import from seed/));
    const box = await screen.findByPlaceholderText(/0a1b2c/);
    const seed = "ab".repeat(32);
    await user.click(box);
    await user.paste(seed);
    expect(box).toHaveValue(seed);
    // And it must survive the poll, like every other field.
    await new Promise((r) => setTimeout(r, 1600));
    expect(box).toHaveValue(seed);
  });
});
