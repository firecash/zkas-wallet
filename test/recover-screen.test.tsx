// The screen a user meets when their browser lost its key.
//
// It used to blame the service ("the service forgot this wallet"). It is usually
// the opposite: the registration and the coins are fine and THIS BROWSER lost the
// key — Safari clears site storage after about a week. A user who returns to a
// wallet demanding their recovery phrase concludes the wallet ate their money, so
// what this screen says matters as much as what it does.

import { describe, expect, it, beforeEach, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { Status } from "../src/api";

const FVK = "ab".repeat(96);
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


async function mountLost() {
  localStorage.setItem("wallet_token", "tok");
  localStorage.setItem(
    "status_cache_tok",
    JSON.stringify({ address: ADDRESS, has_wallet: true, network: "mainnet" }),
  );
  const { RecoverWallet } = await import("../src/App");
  return render(<RecoverWallet onRecovered={() => {}} onStartOver={() => {}} />);
}

beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
  adopt.mockClear();
  statusOverride = {};
  vi.useRealTimers();
});

describe("the reconnect screen", () => {
  it("blames the browser's storage, not the service", async () => {
    await mountLost();
    const msg = await screen.findByText(/no longer holds the key/i);
    expect(msg).toBeInTheDocument();
    expect(screen.queryByText(/service forgot this wallet/i)).not.toBeInTheDocument();
  });

  it("says the key was never on the server", async () => {
    await mountLost();
    expect(await screen.findByText(/never on the server/i)).toBeInTheDocument();
  });

  it("tells the user how to stop it happening again", async () => {
    await mountLost();
    await screen.findByText(/no longer holds the key/i);
    expect(screen.getByText(/Home Screen/i)).toBeInTheDocument();
  });

  it("offers watching, so no phrase has to be typed into a browser", async () => {
    await mountLost();
    await screen.findByText(/no longer holds the key/i);
    await userEvent.click(screen.getByText(/Just watch this wallet instead/i));
    await userEvent.type(await screen.findByPlaceholderText(/paste the view key/i), FVK);
    await userEvent.click(screen.getByRole("button", { name: /Watch it/i }));
    expect(adopt).toHaveBeenCalledWith(FVK, 0);
  });

  it("still refuses a view key that is not one", async () => {
    await mountLost();
    await screen.findByText(/no longer holds the key/i);
    await userEvent.click(screen.getByText(/Just watch this wallet instead/i));
    await userEvent.type(await screen.findByPlaceholderText(/paste the view key/i), "not-a-key");
    await userEvent.click(screen.getByRole("button", { name: /Watch it/i }));
    expect(await screen.findByText(/not a view key/i)).toBeInTheDocument();
    expect(adopt).not.toHaveBeenCalled();
  });
});
