// Android background sync (opt-in, Settings → Background sync).
//
// A WorkManager periodic wake (~every 15 min, network required) that calls the
// daemon's /api/status. That single call does both jobs: it TOUCHES the wallet,
// so the daemon keeps its chain scan caught up (the daemon only actively syncs
// wallets a client has recently touched — this is what makes the next app open
// instant), and it tells the worker the balance grew, so a local notification
// announces an incoming payment while the app is closed.
//
// All the work happens natively (BackgroundSyncPlugin/SyncWorker) — the app
// does not need to be running or even alive, and no key material is involved:
// the wallet token is the same read credential the app already holds, and the
// daemon it talks to is watch-only. The web bundle only configures and toggles.

import { registerPlugin } from "@capacitor/core";
import { getBase, getToken, isNative } from "./api";

interface BackgroundSyncPlugin {
  configure(opts: { baseUrl: string; token: string }): Promise<void>;
  enable(): Promise<void>;
  disable(): Promise<void>;
  isEnabled(): Promise<{ enabled: boolean }>;
}

const Native = registerPlugin<BackgroundSyncPlugin>("BackgroundSync");

const FLAG = "bg_sync_enabled";

function isAndroid(): boolean {
  const cap = (globalThis as { Capacitor?: { getPlatform?: () => string } }).Capacitor;
  return isNative() && cap?.getPlatform?.() === "android";
}

/** Only Android ships the native plugin — web/desktop/iOS get no toggle. */
export function bgSyncAvailable(): boolean {
  return isAndroid();
}

export function bgSyncEnabled(): boolean {
  return isAndroid() && localStorage.getItem(FLAG) === "1";
}

export async function bgSyncEnable(): Promise<void> {
  // Configure BEFORE enabling so the worker never wakes to stale credentials.
  await Native.configure({ baseUrl: getBase(), token: getToken() });
  await Native.enable();
  localStorage.setItem(FLAG, "1");
}

export async function bgSyncDisable(): Promise<void> {
  await Native.disable();
  localStorage.removeItem(FLAG);
}

/**
 * Re-point the worker at the ACTIVE wallet and current daemon URL. Called on
 * boot (wallet switches reload the app, so boot covers them) and after the
 * daemon URL changes in Settings — the worker is useless while pointing at a
 * wallet this device is no longer looking at.
 */
export async function bgSyncReconfigure(): Promise<void> {
  if (!bgSyncEnabled()) return;
  try {
    await Native.configure({ baseUrl: getBase(), token: getToken() });
  } catch {
    /* best-effort — the next boot re-tries */
  }
}
