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
export function shouldMirror(key: string): boolean {
  return (
    key.startsWith("device_seed_") ||
    key === "device_mnemonic" ||
    // THE LOCK RECORD. This said "applock_v1", a key that does not exist anywhere in the
    // app — applock.ts calls it `app_lock_v2`, with `app_lock_v1_` as the legacy prefix.
    // The consequence was the exact loss this file exists to prevent: with the lock ON the
    // seed is sealed INSIDE this record and the cleartext device_seed_ copy is deleted, so
    // mirroring device_seed_ captured nothing and the sealed copy was not mirrored at all.
    // One eviction and a locked wallet was unrecoverable without its recovery phrase.
    key === "app_lock_v2" ||
    key.startsWith("app_lock_v1_") ||
    // The flags that make a restored seed READABLE. getDeviceSeed only returns the
    // plaintext fallback when `seed_unsealed_<token>` is present, so restoring the seed
    // without its flag hands back a key the app refuses to use; same for the phrase.
    key.startsWith("seed_unsealed_") ||
    key === "mnemonic_unsealed" ||
    key === "wallets_v1" ||
    key.startsWith("wallet_account_") ||
    key === "account_high_water" ||
    // A WATCH-ONLY wallet's viewing key, which for that wallet is the whole wallet: there
    // is no seed behind it. Lose this to an eviction and `watchKey()` returns "",
    // `isWatchOnly()` goes false, and the app treats what is left as an ordinary wallet
    // with no key — asking for a recovery phrase that never existed for it. The funds are
    // safe on the device that issued the link, but the viewer is gone and the owner has to
    // go and fetch the link again. 96 bytes, and the Keychain is a better home for a key
    // that reveals an entire transaction history than evictable website data is.
    key.startsWith("watch_fvk_") ||
    // The address book. On a shielded chain nothing on-chain says who an address belongs
    // to — contacts.ts opens with exactly that — so this cannot be rebuilt from anywhere,
    // which is the test this file sets for what belongs in the Keychain. It is also the
    // only thing here that is neither a key nor a counter, and it is small: a contact is
    // a name and an address.
    key.startsWith("contacts_")
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
    // MIRROR FIRST, then store. The other order meant that when localStorage refused a
    // write — iOS enforces a quota, and a blocked store throws outright — the exception
    // propagated and mirrorPut was never reached. The Keychain is a SEPARATE store with
    // its own limits, so localStorage refusing a value says nothing about whether the
    // mirror could hold it, and the mirror is the copy that exists precisely to survive
    // localStorage being emptied. Losing both because one failed is the opposite of the
    // point.
    //
    // Mirroring a value the app then failed to store is right, not wrong: the app INTENDED
    // to store it, so putting it back at the next launch is what the owner expects — and
    // for a seed it is the difference between recovering the wallet and asking for the
    // recovery phrase.
    void mirrorPut(key, value);
    // Still throws if localStorage refuses, so callers that must fail loudly — setDeviceSeed
    // above all — keep doing so. Swallowing it here would reintroduce the silent key-drop
    // that cost a real user their funds.
    origSet(key, value);
  };
  localStorage.removeItem = (key: string) => {
    try {
      origRemove(key);
    } finally {
      // A key the app deliberately deleted must not come back on the next restore —
      // otherwise removing a wallet would resurrect it, which is worse than losing it.
      //
      // In a `finally` for the same reason setItem above mirrors FIRST: `origRemove` can
      // throw. A store that is blocked rather than merely full throws on every access, and
      // `removeLocal` wraps this call in a `catch` that swallows it — so the app would
      // believe the key was gone while the Keychain still held it, and `mirrorRestore` would
      // hand it back at the next launch. For "Remove wallet" that resurrects a wallet; for
      // the lock screen's "erase this device" it leaves the seed of a wallet someone erased
      // under duress sitting in the Keychain.
      //
      // The throw still propagates, so callers that must fail loudly keep doing so.
      if (shouldMirror(key)) void mirrorDrop(key);
    }
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
/// A mirrored key's name with the wallet token taken out of it.
///
/// The restore path logged the names it put back, and every per-wallet key carries the
/// token as its suffix — `device_seed_<token>`, `watch_fvk_<token>`, `contacts_<token>`.
/// That token is the bearer credential for the hosted daemon: it is what every request
/// authenticates with, so whoever holds it can read the wallet's balance and its entire
/// transaction history server-side. Printing it into the console put it wherever console
/// output goes — devtools, a screen-share, logcat on a debuggable Android build — on a
/// wallet whose whole purpose is that this metadata stays private.
///
/// The KIND of key is the part with diagnostic value ("the seed came back, so did the view
/// key"), and it survives. The token does not.
export function redactKeyName(key: string): string {
  return key.replace(/[0-9a-f]{16,}$/i, "\u2026");
}

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
