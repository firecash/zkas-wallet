// A wallet engine that is still loading must not be reported as one that failed.
//
// The shell allowed 15 seconds for the embedded engine to answer. A cold wallet
// loads its scan state from disk and catches up to the tip, which takes MINUTES,
// so the engine was declared dead, and every remedy the screen offered restarted
// it — throwing away the load and starting the clock again. That is a loop no
// amount of retrying can leave.

import { describe, expect, it, beforeEach, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";

const walletdStatus = vi.fn();
// Spread the real module: App imports several things from it at module scope,
// and replacing the whole module leaves those undefined and hangs the import.
vi.mock("../src/desktop-services", async (orig) => {
  const actual = await orig<typeof import("../src/desktop-services")>();
  return { ...actual, desktopServices: { ...actual.desktopServices, walletdStatus: () => walletdStatus() } };
});

function status(over: Record<string, unknown> = {}) {
  return {
    running: false, starting: false, port: 8501, node_source: "remote",
    node_rpc: "185.147.157.125:16110", node_connected: null, synced: null,
    scanning_progress: null, note_count: null, anchor_daa: null, balance: null,
    error: null, ...over,
  };
}

beforeEach(() => { walletdStatus.mockReset(); localStorage.clear(); });

describe("the desktop engine screen", { timeout: 15000 }, () => {
  it("says it is STARTING, not that it failed", async () => {
    walletdStatus.mockResolvedValue(status({ starting: true }));
    const { DesktopEngineDown } = await import("../src/App");
    render(<DesktopEngineDown requestError="error sending request for url (http://127.0.0.1:8501/api/status)" />);
    expect(await screen.findByText(/Starting the wallet on this computer/, {}, { timeout: 8000 })).toBeInTheDocument();
    expect(screen.queryByText(/didn't start/)).not.toBeInTheDocument();
  });

  it("hides the raw transport error while it is starting", async () => {
    walletdStatus.mockResolvedValue(status({ starting: true }));
    const { DesktopEngineDown } = await import("../src/App");
    render(<DesktopEngineDown requestError="error sending request for url (http://127.0.0.1:8501/api/status)" />);
    await screen.findByText(/Starting the wallet on this computer/, {}, { timeout: 8000 });
    expect(screen.queryByText(/error sending request/)).not.toBeInTheDocument();
  });

  it("offers nothing that would restart a starting engine", async () => {
    walletdStatus.mockResolvedValue(status({ starting: true }));
    const { DesktopEngineDown } = await import("../src/App");
    render(<DesktopEngineDown />);
    await screen.findByText(/Starting the wallet on this computer/, {}, { timeout: 8000 });
    // Switching sources restarts the engine and loses the load in progress.
    const text = document.body.textContent ?? "";
    expect(text).not.toMatch(/Use the public wallet service/);
    expect(text).not.toMatch(/Retry/);
  });

  it("only reports failure when the engine is genuinely not running", async () => {
    walletdStatus.mockResolvedValue(status({ starting: false, error: "cannot bind 0.0.0.0:8501" }));
    const { DesktopEngineDown } = await import("../src/App");
    render(<DesktopEngineDown />);
    expect(await screen.findByText(/didn't start/, {}, { timeout: 8000 })).toBeInTheDocument();
    await waitFor(() => expect(screen.getByText(/cannot bind/)).toBeInTheDocument());
  });

  it("offers the public SERVICE as the remedy, which needs no local engine", async () => {
    walletdStatus.mockResolvedValue(status({ starting: false, error: "boom" }));
    const { DesktopEngineDown } = await import("../src/App");
    render(<DesktopEngineDown />);
    expect(await screen.findByRole("button", { name: /Use the public wallet service/ }, { timeout: 8000 })).toBeInTheDocument();
    // The old remedy switched the CHAIN SOURCE, restarting the engine.
    expect(screen.queryByRole("button", { name: /public history node/ })).not.toBeInTheDocument();
  });
});
