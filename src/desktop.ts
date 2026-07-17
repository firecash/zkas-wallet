// Desktop (Tauri) bootstrap: point the SPA at the EMBEDDED walletd.
//
// The desktop shell runs zkas-walletd in-process on a random loopback port with
// a per-install token. Before the app renders, fetch that config and install it
// where the SPA already looks (localStorage walletd_base / wallet_token) — the
// rest of the UI then needs zero desktop-specific code.

export interface DesktopConfig {
  base: string;
  token: string;
  network: string;
  mode: string; // "remote" | "custom" | "local"
  node_addr: string;
  node_binary: string | null;
  node_running: boolean;
}

/** True when running inside the Tauri desktop shell. */
export function isDesktop(): boolean {
  return "__TAURI_INTERNALS__" in globalThis;
}

async function invoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke<T>(cmd, args);
}

/** Fetch the embedded daemon's address+token and install them for the SPA. */
export async function initDesktop(): Promise<DesktopConfig | null> {
  if (!isDesktop()) return null;
  const cfg = await invoke<DesktopConfig>("wallet_config");
  localStorage.setItem("walletd_base", cfg.base);
  localStorage.setItem("wallet_token", cfg.token);
  return cfg;
}

/** Switch node source (restarts the embedded daemon; wallet data is untouched). */
export async function setNodeSource(
  mode: "remote" | "custom" | "local",
  nodeAddr?: string,
  nodeBinary?: string,
): Promise<DesktopConfig> {
  const cfg = await invoke<DesktopConfig>("set_node_source", {
    mode,
    nodeAddr: nodeAddr ?? null,
    nodeBinary: nodeBinary ?? null,
  });
  localStorage.setItem("walletd_base", cfg.base);
  return cfg;
}
