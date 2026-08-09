import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

const { serviceState, startNode, stopListeners } = vi.hoisted(() => ({
  serviceState: {
    logs: [{ at_unix_ms: 1, service: "zkas-node", stream: "app", line: "node ready" }],
  },
  startNode: vi.fn(async () => 1234),
  stopListeners: vi.fn(),
}));

vi.mock("../src/desktop", () => ({
  isDesktop: () => true,
  initDesktop: vi.fn(async () => ({})),
  setNodeSource: vi.fn(async () => undefined),
}));

vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async () => stopListeners),
}));

vi.mock("../src/desktop-services", () => ({
  desktopServices: {
    config: vi.fn(async () => ({
      settings: { node_preset: "shielded", node_public_p2p: false },
      components: { zkas_node: true, bridge: false, zkas_miner: true, kaspa_node: false, explorer: true },
      data_dir: "/tmp/zkas-wallet",
    })),
    nodeStatus: vi.fn(async () => ({
      running: false, managed: false, pid: null, rpc_addr: "127.0.0.1:16810",
      block_count: null, header_count: null, daa_score: null, peer_count: null,
      is_synced: null, mempool_size: null, sync_progress: null, difficulty: null,
      disk_bytes: 0, error: null, last_exit: null,
    })),
    walletdStatus: vi.fn(async () => ({
      running: true, port: 8501, node_source: "remote", node_rpc: "public:16110",
      node_connected: true, synced: true, scanning_progress: 100, note_count: 1,
      anchor_daa: 10, balance: "1", error: null,
    })),
    logs: vi.fn(async () => serviceState.logs),
    install: vi.fn(async () => undefined),
    startNode,
    stopNode: vi.fn(async () => undefined),
  },
}));

import { NodeRunner } from "../src/pages/NodeRunner";

afterEach(() => {
  vi.clearAllMocks();
  serviceState.logs = [{ at_unix_ms: 1, service: "zkas-node", stream: "app", line: "node ready" }];
  document.body.style.overflow = "";
});

describe("managed node", () => {
  it("asks for the mode at launch, defaults to mining, and passes peer access explicitly", async () => {
    const user = userEvent.setup();
    render(<NodeRunner />);

    await user.click(await screen.findByRole("button", { name: "Run node" }));
    const dialog = screen.getByRole("dialog", { name: "Choose how to run it" });
    expect(dialog).toBeInTheDocument();
    expect(screen.getByRole("radio", { name: /Mining/ })).toHaveAttribute("aria-checked", "true");
    expect(screen.getByText("No firewall changes needed")).toBeInTheDocument();

    await user.click(screen.getByRole("checkbox", { name: /Accept inbound peers/ }));
    expect(screen.getByText("Firewall setup")).toBeInTheDocument();
    await user.click(within(dialog).getByRole("button", { name: "Run node" }));

    await waitFor(() => expect(startNode).toHaveBeenCalledWith("mining", true));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Choose how to run it" })).not.toBeInTheDocument());
  });

  it("opens logs outside the page and recovers new lines from live snapshots", async () => {
    const user = userEvent.setup();
    const view = render(<NodeRunner />);

    await user.click(await screen.findByRole("button", { name: "View logs" }));
    expect(await screen.findByRole("dialog", { name: "ZKAS node logs diagnostics" })).toBeInTheDocument();
    expect(await screen.findByText("node ready")).toBeInTheDocument();
    expect(view.container.querySelector(".service-console")).toBeNull();

    serviceState.logs = [
      ...serviceState.logs,
      { at_unix_ms: 2, service: "zkas-node", stream: "stdout", line: "new block received" },
    ];
    await waitFor(() => expect(screen.getByText("new block received")).toBeInTheDocument(), { timeout: 2_500 });
  });
});
