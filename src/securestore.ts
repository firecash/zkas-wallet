// A durable mirror for the values a wallet cannot afford to lose, on iOS only.
//
// Every piece of wallet state lives in localStorage, including `device_seed_<token>` and
// the `device_mnemonic` recovery phrase (or their sealed forms when the app lock is on).
// On Android that is app data and lasts until the app is uninstalled. On iOS it is WebKit
// website data, which the system may evict when storage runs low — and then the only copy
// of the seed is gone, or the sealed blob is gone and the app lock's Keychain secret has
// nothing left to open. Either way the coins are unreachable unless the phrase was written
// down.
//
// This does NOT change which store is authoritative. Reads and writes go to localStorage
// exactly as on every other platform; this adds a write-through copy in the iOS Keychain
// and a restore path that runs at startup. The seed paths in this app have a history of
// subtle breakage, so a net that alters the live path would not be a net.
import { registerPlugin } from "@capacitor/core";
import { isNative } from "./api";

interface SecureStorePlugin {
  get(opts: { key: string }): Promise<{ value: string | null }>;
  set(opts: { key: string; value: string }): Promise<void>;
  remove(opts: { key: string }): Promise<void>;
  keys(): Promise<{ keys: string[] }>;
}

const Native = registerPlugin<SecureStorePlugin>("SecureStore");

/** Only iOS needs this; Android's WebView storage is already durable. */
export function mirrorAvailable(): boolean {
  const cap = (globalThis as { Capacitor?: { getPlatform?: () => string } }).Capacitor;
  return isNative() && cap?.getPlatform?.() === "ios";
}

/**
 * The keys worth mirroring: anything whose loss costs money.
 *
 * Deliberately NOT everything. Scan checkpoints, contacts and settings are all rebuildable
 * or replaceable, and copying them into the Keychain would put hundreds of KB of
 * non-secret data somewhere it does not belong.
 */
function shouldMirror(key: string): boolean {
  return (
    key.startsWith("device_seed_") ||
    key === "device_mnemonic" ||
    key === "applock_v1" ||
    key === "wallets_v1" ||
    key.startsWith("wallet_account_") ||
    key === "account_high_water"
  );
}

/** Write-through. Failures are swallowed: the authoritative write already happened. */
export async function mirrorPut(key: string, value: string): Promise<void> {
  if (!mirrorAvailable() || !shouldMirror(key)) return;
  await Native.set({ key, value }).catch(() => {});
}

export async function mirrorDrop(key: string): Promise<void> {
  if (!mirrorAvailable()) return;
  await Native.remove({ key }).catch(() => {});
}

/**
 * Mirror every future write, by wrapping the two storage methods once.
 *
 * Wrapping rather than editing each call site. The seed lives in several places —
 * accounts.ts, applock.ts, the wallet registry — and those paths have a history of subtle
 * breakage (a seed overwritten on watch, a note stranded by compaction, a balance
 * vanishing on mark_spent). Threading a mirror call through each one is more code in
 * exactly the files that can least afford a mistake, and it silently misses any site added
 * later. One wrapper cannot miss a write.
 *
 * The real write happens first and its result is returned untouched, so a failing mirror
 * can never turn a successful save into a failure.
 */
export function installMirror(): void {
  if (!mirrorAvailable() || installed) return;
  installed = true;
  const proto = Object.getPrototypeOf(localStorage) as Storage;
  const origSet = proto.setItem.bind(localStorage);
  const origRemove = proto.removeItem.bind(localStorage);
  localStorage.setItem = (key: string, value: string) => {
    origSet(key, value);
    void mirrorPut(key, value);
  };
  localStorage.removeItem = (key: string) => {
    origRemove(key);
    // A key the app deliberately deleted must not come back on the next restore —
    // otherwise removing a wallet would resurrect it, which is worse than losing it.
    if (shouldMirror(key)) void mirrorDrop(key);
  };
}

let installed = false;

/**
 * Put back anything the Keychain has that localStorage has lost.
 *
 * Runs once at startup, before the app reads any wallet state. Only ever FILLS gaps: a key
 * that localStorage already holds is left alone, so a live value is never overwritten by
 * an older mirrored one. Returns what it restored, so a purge is visible in the log rather
 * than silently healed.
 */
export async function mirrorRestore(): Promise<string[]> {
  if (!mirrorAvailable()) return [];
  const restored: string[] = [];
  try {
    const { keys } = await Native.keys();
    for (const key of keys) {
      if (localStorage.getItem(key) !== null) continue;
      const { value } = await Native.get({ key });
      if (value === null || value === undefined) continue;
      localStorage.setItem(key, value);
      restored.push(key);
    }
  } catch {
    // A Keychain that cannot be read leaves the app exactly as it was.
  }
  return restored;
}

/**
 * Seed the mirror from whatever localStorage already holds.
 *
 * For wallets that existed before this shipped: without it their seeds would stay
 * unmirrored until the next write, which for a wallet nobody is changing is never.
 */
export async function mirrorBackfill(): Promise<number> {
  if (!mirrorAvailable()) return 0;
  let n = 0;
  try {
    for (let i = 0; i < localStorage.length; i += 1) {
      const key = localStorage.key(i);
      if (!key || !shouldMirror(key)) continue;
      const v = localStorage.getItem(key);
      if (v === null) continue;
      await Native.set({ key, value: v }).catch(() => {});
      n += 1;
    }
  } catch {
    /* best effort */
  }
  return n;
}
