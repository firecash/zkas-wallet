// Where a new wallet will sync, said BEFORE it is created.
//
// Creating a wallet registers its full viewing key with a service, which can then
// see every amount and memo it ever receives. The first-run gate skipped the web
// entirely, reasoning the host had already served the page — true of the IP, and
// false of the viewing key. A wallet appeared in a fresh browser already talking
// to the public daemon with nothing said.

import { describe, expect, it, beforeEach, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { Status } from "../src/api";

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


async function mountFresh(base = "https://wallet.zkas.info/daemon") {
  // jsdom's origin is localhost, which the label would honestly call "this
  // computer"; set the base the real web app resolves to.
  localStorage.setItem("walletd_base", base);
  statusOverride = { has_wallet: false };
  const { default: App } = await import("../src/App");
  const { ToastHost } = await import("../src/toast");
  return render(<ToastHost><App /></ToastHost>);
}

beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
  statusOverride = {};
  vi.useRealTimers();
});

describe("before a wallet exists", () => {
  it("says which service the wallet will sync through", async () => {
    await mountFresh();
    expect(await screen.findByText(/will sync through/i, {}, { timeout: 8000 })).toBeInTheDocument();
  });

  it("names the public service by default, on the web too", async () => {
    await mountFresh();
    const line = await screen.findByText(/will sync through/i, {}, { timeout: 8000 });
    expect(line.textContent).toMatch(/public service|wallet\.zkas\.info/i);
  });

  it("says what that service can and cannot do", async () => {
    await mountFresh();
    const line = await screen.findByText(/will sync through/i, {}, { timeout: 8000 });
    expect(line.textContent).toMatch(/balance and history/i);
    expect(line.textContent).toMatch(/never your keys/i);
    expect(line.textContent).toMatch(/cannot spend/i);
  });

  it("offers exactly one way to change it, on the screen that decides it", async () => {
    await mountFresh();
    await screen.findByText(/will sync through/i, {}, { timeout: 8000 });
    // One control, not a second copy competing with the header chip.
    expect(screen.getAllByRole("button", { name: /^Connection:/ })).toHaveLength(1);
  });

  it("names a self-hosted daemon honestly rather than calling it public", async () => {
    await mountFresh("http://127.0.0.1:8501");
    const line = await screen.findByText(/will sync through/i, {}, { timeout: 8000 });
    expect(line.textContent).toMatch(/this computer/i);
  });

  it("repeats it where a view key is adopted — that registers a key too", async () => {
    await mountFresh();
    await userEvent.click(await screen.findByRole("button", { name: /Watch a wallet/i }, { timeout: 8000 }));
    expect(await screen.findByText(/will sync through/i)).toBeInTheDocument();
  });
});
