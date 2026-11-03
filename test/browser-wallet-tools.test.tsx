import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";

// Batch send and Combine coins are custodial-only on the wallet service. In browser mode the
// page holds the key, so both run in the in-page engine instead of answering "custodial only".
const sendMany = vi.fn(async (_s: string, p: unknown[]) => ({ payees: p.length, tx_count: 1, txid: "t", fee_sompi: 3_000_000 }));
const consolidate = vi.fn(async () => ({ consolidated: 6, notes_remaining: 1, txid: "t" }));
let browser = false;
vi.mock("../src/webengine", async (orig) => {
  const actual = await orig<typeof import("../src/webengine")>();
  return { ...actual, browserModeChosen: () => browser, browserSendMany: (...a: [string, unknown[]]) => sendMany(...a), browserConsolidate: () => consolidate() };
});
vi.mock("../src/lib/deviceseed", async (orig) => {
  const actual = await orig<typeof import("../src/lib/deviceseed")>();
  return { ...actual, resolveDeviceSeed: async () => "11".repeat(32) };
});
const svcSendMany = vi.fn(async () => ({ payees: 1, tx_count: 1 }));
const svcConsolidate = vi.fn(async () => ({ consolidated: 2, notes_remaining: 1 }));
let failOn = -1;
const deviceSend = vi.fn(async (..._a: unknown[]) => {
  if (deviceSend.mock.calls.length - 1 === failOn) throw new Error("not enough spendable coins yet");
  return { txid: "s", txids: ["s"], sent_sompi: 1, fee_sompi: 1 };
});
const deviceConsolidate = vi.fn(async () => ({ txid: "t2", inputs: 5, amount_sompi: 1, fee_sompi: 1, txids: ["t2"], rounds: 1, more: false }));
vi.mock("../src/noncustodial", async (orig) => {
  const actual = await orig<typeof import("../src/noncustodial")>();
  return { ...actual, consolidateNonCustodial: (...a: unknown[]) => deviceConsolidate(...(a as [])), sendNonCustodial: (...a: unknown[]) => deviceSend(...(a as [])) };
});
vi.mock("../src/api", async (orig) => {
  const actual = await orig<typeof import("../src/api")>();
  return { ...actual, api: { ...actual.api, sendMany: (...a: unknown[]) => svcSendMany(...(a as [])), consolidate: () => svcConsolidate() } };
});

import "../src/i18n";
import { WalletTools } from "../src/pages/WalletTools";
import type { Status } from "../src/api";

const status = { has_wallet: true, synced: true, note_count: 6, address: "zkas:x" } as unknown as Status;
const ADDR = "zkas:py82h42m9qjff0knpcmllzq3c7qhurje5auh4tq2ceagf69wjpf23djwwmqr26zhsua8rrglrwdltsh";

beforeEach(() => {
  [sendMany, consolidate, svcSendMany, svcConsolidate, deviceConsolidate, deviceSend].forEach((f) => f.mockClear());
  failOn = -1;
});

function show(tab: string) {
  render(<MemoryRouter initialEntries={[`/tools?tab=${tab}`]}><WalletTools status={status} /></MemoryRouter>);
}

describe("Wallet tools in browser mode", () => {
  it("Combine coins runs in the page", async () => {
    browser = true;
    show("maintenance");
    fireEvent.click(screen.getByRole("button", { name: /Combine|Consolidate/i }));
    await waitFor(() => expect(consolidate).toHaveBeenCalled());
    expect(svcConsolidate).not.toHaveBeenCalled();
    expect(await screen.findByText(/Combined 6 notes/)).toBeInTheDocument();
  });

  // Every wallet service holds this wallet watch-only (the app registers it by viewing key), so the
  // service-side /api/wallet/consolidate can only refuse it: outside browser mode the merge is
  // proved by the service and signed on this device, like a send, and that endpoint is never used.
  it("Combine coins outside browser mode merges with the device signing, never the seed-holding endpoint", async () => {
    browser = false;
    show("maintenance");
    fireEvent.click(screen.getByRole("button", { name: /Combine|Consolidate/i }));
    await waitFor(() => expect(deviceConsolidate).toHaveBeenCalled());
    expect(svcConsolidate).not.toHaveBeenCalled();
    expect(consolidate).not.toHaveBeenCalled();
    expect(await screen.findByText(/Combined 5 notes/)).toBeInTheDocument();
  });

  it("Batch send builds one transaction in the page", async () => {
    browser = true;
    show("batch");
    fireEvent.change(document.querySelector("textarea")!, { target: { value: `${ADDR},1.5\n${ADDR},2,rent` } });
    const btn = screen.getByRole("button", { name: /Review & send/ });
    expect(btn).toBeEnabled();
    fireEvent.click(btn);
    await waitFor(() => expect(sendMany).toHaveBeenCalled());
    expect(sendMany.mock.calls[0][1]).toEqual([
      { to: ADDR, amount_sompi: "150000000", memo: undefined },
      { to: ADDR, amount_sompi: "200000000", memo: "rent" },
    ]);
    expect(svcSendMany).not.toHaveBeenCalled();
  });

  // Outside browser mode the wallet service holds the wallet watch-only, so the seed-holding
  // /api/wallet/send-many can only refuse it: each line is paid as an ordinary device-signed
  // payment, in order, and a failure stops there and says which line.
  it("Batch send outside browser mode pays each line with the device signing, never the seed-holding endpoint", async () => {
    browser = false;
    show("batch");
    fireEvent.change(document.querySelector("textarea")!, { target: { value: `${ADDR},1.5\n${ADDR},2,rent` } });
    fireEvent.click(screen.getByRole("button", { name: /Review & send/ }));
    await waitFor(() => expect(deviceSend).toHaveBeenCalledTimes(2));
    expect(svcSendMany).not.toHaveBeenCalled();
    expect(sendMany).not.toHaveBeenCalled();
    expect(deviceSend.mock.calls[0][2]).toBe(ADDR);
    expect(deviceSend.mock.calls[0][3]).toBe(1.5);
    expect(deviceSend.mock.calls[1][3]).toBe(2);
    expect(deviceSend.mock.calls[1][6]).toBe("rent");
    expect(deviceSend.mock.calls[0][4]).toBeUndefined(); // automatic fee unless one is set (sompi when set)
  });

  it("Batch send outside browser mode stops at a failed line and says how many were paid", async () => {
    browser = false;
    failOn = 1;
    show("batch");
    fireEvent.change(document.querySelector("textarea")!, { target: { value: `${ADDR},1\n${ADDR},2\n${ADDR},3` } });
    fireEvent.click(screen.getByRole("button", { name: /Review & send/ }));
    expect(await screen.findByText(/Paid 1 of 3 recipients, then stopped at line 2/)).toBeInTheDocument();
    expect(deviceSend).toHaveBeenCalledTimes(2); // line 3 is never paid
  });
});
