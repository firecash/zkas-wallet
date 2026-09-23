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
import { getBase, getToken, getWalletdBearer, isNative } from "./api";
import { quietUntil } from "./arrivals";
import { loadTxs } from "./localtx";
import { embeddedChosen, embeddedNode, embeddedTor, ORBOT_SOCKS } from "./embedded";

interface BackgroundSyncPlugin {
  configure(opts: { baseUrl: string; token: string; bearer: string; quietUntil: number; embedded?: boolean; node?: string; socks?: string }): Promise<void>;
  enable(): Promise<void>;
  disable(): Promise<void>;
  isEnabled(): Promise<{ enabled: boolean }>;
  backgroundStatus(): Promise<{ exempt: boolean; suppressed: boolean; shouldAsk: boolean; enabled: boolean }>;
  requestBackground(): Promise<{ shown: boolean }>;
  suppressBackgroundPrompt(opts: { on: boolean }): Promise<void>;
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
  await Native.configure({ baseUrl: getBase(), token: getToken(), bearer: getWalletdBearer(), quietUntil: quietUntil(loadTxs()), embedded: embeddedChosen(), node: embeddedNode(), socks: embeddedTor() ? ORBOT_SOCKS : undefined });
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
    await Native.configure({ baseUrl: getBase(), token: getToken(), bearer: getWalletdBearer(), quietUntil: quietUntil(loadTxs()), embedded: embeddedChosen(), node: embeddedNode(), socks: embeddedTor() ? ORBOT_SOCKS : undefined });
  } catch {
    /* best-effort — the next boot re-tries */
  }
}

// ---------------------------------------------------------------------------
// Doze exemption — what makes on-device background sync actually periodic.
// ---------------------------------------------------------------------------
//
// Enabling background sync schedules a ~15 minute WorkManager wake. Android treats that
// period as a hint: in Doze it is deferred to maintenance windows that stretch to hours,
// so a phone running its own engine is behind every time it is opened — the same wait we
// removed on the hosted side, reappearing on the device. The battery-optimisation
// exemption is the only thing that fixes it, and only the user can grant it.
//
// Every function here is safe on platforms without the plugin: no plugin, nothing to ask.

export interface BgBackgroundStatus {
  exempt: boolean;
  suppressed: boolean;
  shouldAsk: boolean;
  enabled: boolean;
}

export async function bgBackgroundStatus(): Promise<BgBackgroundStatus | null> {
  if (!isAndroid()) return null;
  try {
    return await Native.backgroundStatus();
  } catch {
    // An older native build without these methods. Nothing to ask for.
    return null;
  }
}

/** Open the system dialog. false = this device has no such screen. */
export async function bgRequestBackground(): Promise<boolean> {
  if (!isAndroid()) return false;
  try {
    return (await Native.requestBackground()).shown;
  } catch {
    return false;
  }
}

export async function bgSuppressPrompt(on = true): Promise<void> {
  if (!isAndroid()) return;
  try {
    await Native.suppressBackgroundPrompt({ on });
  } catch {
    /* older native build — the prompt simply never appears */
  }
}

/**
 * Called when the user switches to "run on this phone".
 *
 * Returns whether the app should show its own explain-then-ask sheet. The user asked to
 * be prompted on EVERY switch, not once ever, so this deliberately does not latch on a
 * "seen it" flag — only on the explicit "don't ask again" the sheet offers, and on
 * actually having the exemption, at which point there is nothing to ask for.
 */
export async function bgShouldPromptForBackground(): Promise<boolean> {
  const s = await bgBackgroundStatus();
  return !!s && s.shouldAsk;
}

// The "run on this phone" switch reloads the app (see `startOnPhone`), which would throw
// away any sheet opened in the same tick. So the switch leaves a marker and the next boot
// picks it up: exactly once per switch, and it survives the reload.
const PENDING = "bg_prompt_pending";

export function markBackgroundPromptPending(): void {
  try {
    if (isAndroid()) localStorage.setItem(PENDING, "1");
  } catch {
    /* ignore */
  }
}

/** Read and clear. Clearing on read is deliberate: a prompt shown is a prompt spent. */
export function takeBackgroundPromptPending(): boolean {
  try {
    const had = localStorage.getItem(PENDING) === "1";
    if (had) localStorage.removeItem(PENDING);
    return had;
  } catch {
    return false;
  }
}
