// The welcome screen: create, restore, import — and now watch.
//
// Watching is the only option here that creates nothing to lose, so it must be
// reachable without first making a wallet, and it must refuse anything that is
// not a view key rather than registering junk with the service.

import { describe, expect, it, beforeEach, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { Status } from "../src/api";

const FVK = "ab".repeat(96);
const SEED = "cd".repeat(32);
const adopt = vi.fn(async () => "zkas:viewed");
vi.mock("../src/lib/watchadopt", () => ({
  adoptViewKey: (k: string, b?: number) => adopt(k, b),
  adoptViewKeyFromUrl: async () => false,
}));

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

beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
  adopt.mockClear();
  // No wallet yet: this is the welcome screen.
  statusOverride = { has_wallet: false };
  vi.useRealTimers();
});

describe("the welcome screen", () => {
  it("offers watching alongside creating and importing", async () => {
    await mountApp();
    expect(await screen.findByRole("button", { name: /Watch a wallet/i }, { timeout: 8000 })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Create new wallet|Connecting/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Import from seed/i })).toBeInTheDocument();
  });

  it("takes a view key and starts watching", async () => {
    await mountApp();
    await userEvent.click(await screen.findByRole("button", { name: /Watch a wallet/i }, { timeout: 8000 }));
    await userEvent.type(screen.getByPlaceholderText(/paste the view key/i), FVK);
    await userEvent.click(screen.getByRole("button", { name: /Watch this wallet/i }));
    expect(adopt).toHaveBeenCalledWith(FVK, 0);
  });

  it("accepts the whole sharing link, with its birthday", async () => {
    await mountApp();
    await userEvent.click(await screen.findByRole("button", { name: /Watch a wallet/i }, { timeout: 8000 }));
    const box = screen.getByPlaceholderText(/paste the view key/i);
    await userEvent.click(box);
    await userEvent.paste(`https://wallet.zkas.info/#/watch?key=${FVK}&b=4242`);
    await userEvent.click(screen.getByRole("button", { name: /Watch this wallet/i }));
    expect(adopt).toHaveBeenCalledWith(FVK, 4242);
  });

  it("refuses a seed instead of a view key, and registers nothing", async () => {
    await mountApp();
    await userEvent.click(await screen.findByRole("button", { name: /Watch a wallet/i }, { timeout: 8000 }));
    await userEvent.type(screen.getByPlaceholderText(/paste the view key/i), SEED);
    await userEvent.click(screen.getByRole("button", { name: /Watch this wallet/i }));
    expect(await screen.findByText(/not a view key/i)).toBeInTheDocument();
    expect(adopt).not.toHaveBeenCalled();
  });

  it("warns what a view key discloses", async () => {
    await mountApp();
    await userEvent.click(await screen.findByRole("button", { name: /Watch a wallet/i }, { timeout: 8000 }));
    expect(screen.getByText(/every amount and memo/i)).toBeInTheDocument();
  });
});
