import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

const { setHostAccess } = vi.hoisted(() => ({
  setHostAccess: vi.fn(async () => undefined),
}));

vi.mock("react-router-dom", async () => {
  const actual = await vi.importActual<typeof import("react-router-dom")>("react-router-dom");
  return { ...actual, useNavigate: () => vi.fn() };
});

vi.mock("../src/desktop", () => ({
  isDesktop: () => true,
  initDesktop: vi.fn(async () => ({})),
  openPath: vi.fn(async () => undefined),
}));

vi.mock("../src/desktop-services", () => ({
  desktopServices: {
    selfHostStatus: vi.fn(async () => ({
      wallet_engine_running: true,
      wallet_engine_url: "http://127.0.0.1:55000",
      node_mode: "local",
      node_rpc: "127.0.0.1:16810",
      explorer_installed: true,
      explorer_running: false,
      explorer_pid: null,
      explorer_url: "http://127.0.0.1:8500",
      explorer_last_exit: null,
      gateway_release_available: false,
      data_dir: "/tmp/zkas",
      backup_dir: "/tmp/backups",
      autostart_enabled: false,
      wallet_access: "device",
      wallet_access_port: 8501,
      wallet_public_url: "",
      wallet_access_url: null,
      wallet_access_urls: [],
      wallet_access_token: "a".repeat(64),
      lan_ip: "192.168.1.20",
      lan_ips: ["192.168.1.20"],
      node_running: false,
      node_public_p2p: false,
      node_lan_rpc: false,
    })),
    setHostAccess,
    install: vi.fn(),
    startExplorer: vi.fn(),
    stopExplorer: vi.fn(),
    setAutostart: vi.fn(),
  },
}));

import { SelfHost } from "../src/pages/SelfHost";

describe("Host network access", () => {
  it("applies authenticated LAN wallet and node access explicitly", async () => {
    const user = userEvent.setup();
    render(<SelfHost />);

    await user.click(await screen.findByRole("button", { name: "Configure" }));
    await user.click(screen.getByRole("radio", { name: /Local network/ }));
    await user.click(screen.getByRole("checkbox", { name: /Node RPC on trusted LAN/ }));
    await user.click(screen.getByRole("checkbox", { name: /Public P2P node/ }));
    await user.click(screen.getByRole("button", { name: "Apply" }));

    await waitFor(() => expect(setHostAccess).toHaveBeenCalledWith({
      walletAccess: "lan",
      walletAccessPort: 8501,
      walletPublicUrl: "",
      nodeLanRpc: true,
      nodePublicP2p: true,
    }));
  });
});
