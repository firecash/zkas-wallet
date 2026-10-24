import { readLocal, writeLocal } from "./safestore";
import { loadStatusCache, type Status } from "../api";
import { addressFromSeed, accountAddress, accountSeedHex, type Network } from "../signer";
import { unlockedDeviceSeed, isLockEnabled, sealNewSeed, allUnlockedSeeds } from "../applock";
import { masterMnemonic, setAccountOf, clearAccountOf, adoptExistingPhrase } from "../accounts";
import { listWallets } from "../wallets";
import { storageIsEphemeral } from "./storage-shim";

/// Cheap shape test for a stored wallet secret: a legacy 64-hex seed, or a
/// recovery phrase (BIP-39 words are lowercase letters separated by spaces).
/// Deliberately permissive — callers confirm by deriving the address.
export function isSecretShaped(v: string): boolean {
  const s = v.trim();
  if (/^[0-9a-fA-F]{64}$/.test(s)) return true;
  const words = s.split(/\s+/);
  return words.length >= 12 && words.length <= 24 && words.every((w) => /^[a-z]+$/i.test(w));
}

function deviceSeedKey(): string {
  return `device_seed_${readLocal("wallet_token") || "default"}`;
}

/**
 * A guarded read for the SEED keys — deliberately not `readLocal`.
 *
 * safestore's reader falls back to a session map holding what a blocked store refused, and
 * a spending key must never live there: it would disappear on reload while the owner
 * believed the wallet had remembered it, which is the key-loss shape `setDeviceSeed` carries
 * a warning about (a real user lost funds to the earlier version of it). So this catches the
 * throw and nothing more — "no seed stored" is the honest answer on a browser that cannot
 * store one, and the app then asks for the recovery phrase, which is correct.
 *
 * The WRITES in this module stay raw and loud for the same reason: a seed that could not be
 * saved has to fail where someone can see it.
 */
function readSeed(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

export function getDeviceSeed(): string {
  const unlocked = unlockedDeviceSeed();
  if (unlocked) return unlocked;
  if (isLockEnabled()) {
    const token = readLocal("wallet_token") || "default";
    if (readSeed(`seed_unsealed_${token}`)) return readSeed(deviceSeedKey()) || "";
    return "";
  }
  return readSeed(deviceSeedKey()) || "";
}

export function setDeviceSeed(seed: string) {
  if (!seed) return;
  // With the lock on, keep the seed SEALED rather than in the clear — and
  // never simply drop it. This used to `return` early, so creating, importing
  // or restoring a wallet while locked stored nothing at all: a wallet that
  // could not spend and whose key was gone on reload. Losing a key is a worse
  // outcome than any it was protecting against.
  //
  // DO NOT "harden" the failed-seal branch below into throwing/dropping instead
  // of writing the plaintext fallback. A REAL USER LOST FUNDS from exactly that:
  // the old drop-the-key behaviour left a freshly created wallet with no
  // spendable key after reload, and the coins already sent to it were
  // unrecoverable. The plaintext-with-flag copy is the deliberate lesser evil —
  // it is self-healing: `resealFallbacks()` (applock.ts) re-seals it and deletes
  // the cleartext on the very next unlock. See issue #4 and PR #8 on the former GitHub repository (now offline), whose
  // "write nothing / throw SEED_REQUIRED" proposal would reintroduce the loss.
  if (isLockEnabled()) {
    const token = readLocal("wallet_token") || "default";
    // Sealing failed (an auto-lock raced this creation/import). NEVER drop a key
    // silently again: fall back to plaintext storage and flag it, so the key survives
    // and the state is discoverable. Losing the key is worse than storing it unsealed —
    // that is the principle this path exists on.
    const fallback = () => {
      localStorage.setItem(deviceSeedKey(), seed);
      localStorage.setItem(`seed_unsealed_${token}`, "1");
    };
    // `.catch(fallback)`, and it is the whole point. This handled a RESOLVED false and
    // not a REJECTION, and sealNewSeed has two ways to reject: `await seal(...)` is
    // WebCrypto, and the `write(rec)` after it is an unguarded localStorage.setItem that
    // throws on a full or blocked store. So on exactly the storage conditions this audit
    // has been chasing, the seal threw, the `then` never ran, the fallback was never
    // written — and the key was neither sealed nor stored. That is the loss the comment
    // above records: a freshly created wallet with no spendable key after reload, coins
    // already sent to it unrecoverable (issue #4 / PR #8).
    void sealNewSeed(token, seed)
      .then((ok) => {
        if (!ok) fallback();
      })
      .catch(fallback);
    return;
  }
  localStorage.setItem(deviceSeedKey(), seed);
}

function birthdayKey(): string {
  return `birthday_${readLocal("wallet_token") || "default"}`;
}
/// The birthday is ALSO kept per address (`birthday_addr_<address>`). The per-token
/// copy is written only by the create/import/restore paths, for the token active at
/// that moment — so it is simply absent when the wallet reached this device by any
/// other route (a paired desktop token, a shell-restored backup, a seed under a
/// stale token, a wallet from before birthdays were tracked). Every re-registration
/// read that copy alone and sent 0 when it was missing, and the daemon then scanned
/// a fully synced wallet from genesis (a user's hosted FVK ended up registered at
/// birthday 0 seven times out of eight). The address names the wallet itself and
/// survives every token change, service switch and re-pairing on this device.
function birthdayAddrKey(address: string): string {
  return `birthday_addr_${address}`;
}
function positive(v: string | number | null | undefined): number {
  const n = Number(v ?? 0);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
}

export function rememberBirthday(daa: number, address?: string | null): void {
  if (!(daa > 0)) return;
  const v = String(Math.floor(daa));
  try {
    writeLocal(birthdayKey(), v);
    if (address) {
      // Per address keep the EARLIEST value ever recorded: starting a scan too
      // early costs seconds, starting it too late costs notes.
      const prev = addressBirthday(address);
      if (!prev || daa < prev) writeLocal(birthdayAddrKey(address), v);
    }
  } catch {
    /* best-effort */
  }
}

/// The active token's remembered birthday only; 0 when this token has none.
/// Prefer `knownBirthday` wherever the number is about to be SENT somewhere.
export function walletBirthday(): number {
  return positive(readLocal(birthdayKey()));
}

/// The per-address copy (see `birthdayAddrKey`); 0 when none.
export function addressBirthday(address: string): number {
  try {
    return positive(readLocal(birthdayAddrKey(address)));
  } catch {
    return 0;
  }
}

/// The earliest birthday ANY source on this device knows for the wallet: the
/// active token's copy, the per-address copy, the copy of every other registered
/// token that holds the same address (the paired/orphan cases), and the daemon's
/// own record when the cached status carries one. 0 only when nothing knows —
/// and 0 is what makes a re-registration scan from genesis, so callers that are
/// about to `api.watch` must use this, never `walletBirthday()` alone.
export function knownBirthday(address?: string | null): number {
  const cached = loadStatusCache();
  const addr = address || cached?.address || "";
  const candidates = [walletBirthday(), positive(cached?.birthday)];
  if (addr) {
    candidates.push(addressBirthday(addr));
    for (const w of listWallets()) if (w.address === addr) candidates.push(birthdayOfToken(w.token));
  }
  return candidates.reduce((min, b) => (b > 0 && (min === 0 || b < min) ? b : min), 0);
}

/// True for a recovery phrase (anything that is not a legacy 64-hex seed).
export function isPhraseSecret(v: string): boolean {
  return !/^[0-9a-fA-F]{64}$/.test(v.trim());
}

/// Phrases compare by their words, not their spacing or case.
export function normalizePhrase(p: string): string {
  return p.trim().split(/\s+/).join(" ").toLowerCase();
}

export function networkOfAddress(addr: string): Network {
  return addr.startsWith("zkastest:") ? "testnet" : "mainnet";
}

/// How many accounts of a phrase we are willing to derive when looking for the
/// one that owns an address. Derivation is cheap and local.
export const ACCOUNT_SCAN_LIMIT = 20;

/// Which account of `phrase` derives `expectedAddress` (0..ACCOUNT_SCAN_LIMIT), or null.
export async function phraseAccountFor(phrase: string, expectedAddress: string, limit = ACCOUNT_SCAN_LIMIT): Promise<number | null> {
  const net = networkOfAddress(expectedAddress);
  for (let i = 0; i < limit; i++) {
    try {
      if ((await accountAddress(phrase, net, i)) === expectedAddress) return i;
    } catch {
      return null; // not a usable phrase
    }
  }
  return null;
}

/// Resolve a user-entered secret against the wallet it must open.
///
/// This is THE check every "paste your phrase/seed" path must use. It used to be
/// `addressFromSeed(secret) === expected`, which for a phrase is only ACCOUNT 0 —
/// so a user restoring account 1, 2, … of their phrase was told "that seed belongs
/// to a different wallet" by their own correct phrase, and the account was
/// unspendable on any device that lacked its cached key. For a phrase this scans
/// the accounts; for account N>0 the key to store and sign with is the DERIVED
/// account key (storing the phrase itself would make every later derivation —
/// fvk, address, signing — silently resolve to account 0, i.e. the wrong wallet).
export async function keyForWallet(secret: string, expectedAddress: string): Promise<{ keyHex: string; account: number | null } | null> {
  const s = secret.trim();
  const net = networkOfAddress(expectedAddress);
  if (!isPhraseSecret(s)) {
    return (await addressFromSeed(s, net)) === expectedAddress ? { keyHex: s, account: null } : null;
  }
  const account = await phraseAccountFor(s, expectedAddress);
  if (account === null) return null;
  // Account 0 keeps the phrase as the stored secret (the existing convention:
  // adoptExistingPhrase promotes it to master + account 0).
  if (account === 0) return { keyHex: s, account: 0 };
  return { keyHex: await accountSeedHex(s, account), account };
}

/// Record how the wallet under `token` relates to the phrase the user entered,
/// so backups/reveal show the RIGHT secret for it. Never labels a wallet as an
/// account of a phrase that is not this device's master — that mislabel is how a
/// wallet ends up showing someone else's phrase as its backup.
export async function bindResolvedKey(token: string, enteredSecret: string, r: { keyHex: string; account: number | null }): Promise<void> {
  if (r.account === null) {
    clearAccountOf(token); // a legacy hex wallet stands alone
    return;
  }
  const master = masterMnemonic();
  if (!master) {
    await adoptExistingPhrase(token, enteredSecret).catch(() => undefined); // becomes the master, account 0
    setAccountOf(token, r.account);
  } else if (normalizePhrase(master) === normalizePhrase(enteredSecret)) {
    setAccountOf(token, r.account);
  } else {
    clearAccountOf(token); // a different phrase backs it; it must not claim the master
  }
}

/// The remembered scan birthday of any wallet on this device, by token.
export function birthdayOfToken(token: string): number {
  const v = Number(readLocal(`birthday_${token}`) || "0");
  return Number.isFinite(v) && v > 0 ? Math.floor(v) : 0;
}

/// A seed stored under a STALE token, or an account of the master phrase that this
/// device has never cached a key for.
///
/// Token rotations and the registry/switcher era could orphan `device_seed_<old>`
/// while the active token holds nothing; and a device restored from (or watching
/// via) a phrase holds the PHRASE but not account N's derived key. In both cases
/// the wallet claimed "this device doesn't hold the key" while the key was right
/// here — and without this the coins are stuck. Match every on-device secret by
/// derived address, then derive the master phrase's accounts, and reattach the
/// match to the active token.
/**
 * Every secret this device holds, as secret -> the token it was filed under (first wins).
 *
 * One implementation for the two callers that needed it — `findOrphanedSeed`, which uses the
 * token to carry a misfiled birthday across, and `deviceCanSign`, which only asks whether
 * anything here owns an address. They were near-identical loops, and the second was added
 * during this audit, which is how duplication starts.
 *
 * The enumeration is guarded as a whole: `localStorage.length` and `.key(i)` throw on a
 * browser with site data blocked just as `getItem` does, so guarding only the read would
 * have protected nothing. Unlocked in-memory seeds are included, since with the app lock on
 * they are the only copies that exist.
 */
function heldSecrets(): Map<string, string> {
  const out = new Map<string, string>();
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (!k?.startsWith("device_seed_")) continue;
      const v = readSeed(k);
      // Either a legacy 64-hex seed or a recovery phrase; a cheap pre-filter only, the
      // address derivation downstream is what actually decides.
      if (v && isSecretShaped(v) && !out.has(v.trim())) out.set(v.trim(), k.slice("device_seed_".length));
    }
  } catch {
    /* storage blocked: only what is unlocked in memory is reachable */
  }
  for (const [token, v] of Object.entries(allUnlockedSeeds() ?? {})) {
    if (isSecretShaped(v) && !out.has(v.trim())) out.set(v.trim(), token);
  }
  return out;
}

export async function findOrphanedSeed(expectedAddress: string): Promise<string> {
  // Seed → the token it was stored under (first one wins), so a match can bring
  // that token's remembered birthday along with it.
  const candidates = heldSecrets();
  const net = networkOfAddress(expectedAddress);
  for (const [seed, token] of candidates) {
    try {
      if ((await addressFromSeed(seed, net)) === expectedAddress) {
        // The key was misfiled under another token — so was its birthday. Reattach
        // both, or the re-registration that follows starts the scan at genesis.
        // (Never later than what the active token already knows.)
        const donor = birthdayOfToken(token);
        const own = walletBirthday();
        if (donor > 0) rememberBirthday(own > 0 ? Math.min(own, donor) : donor, expectedAddress);
        return seed;
      }
    } catch {
      /* not a usable seed — keep looking */
    }
  }
  // Derive the master phrase's accounts: the key for account N is not cached on
  // a restored/second device, but it is fully determined by the phrase.
  const master = masterMnemonic();
  if (master) {
    const account = await phraseAccountFor(master, expectedAddress);
    if (account !== null) {
      const token = readLocal("wallet_token") || "default";
      setAccountOf(token, account);
      return account === 0 ? master : await accountSeedHex(master, account);
    }
  }
  return "";
}

export const SEED_REQUIRED = "SEED_REQUIRED";

/// Does `secret` (legacy hex, or a phrase at any account) derive `address`?
///
/// THREE answers, not two. `null` means undecidable right now — the signer could
/// not be loaded, so nothing can be derived and nothing is known. Before this it
/// returned `false` for that case, and the two readings of `false` want opposite
/// handling: "do not present this as the wallet's key" (right, and unchanged) but
/// also "this is some other wallet's key, move it aside" (wrong, and destructive).
/// A wasm chunk that 404s after a deploy, a phone that is out of memory, or an
/// offline first load would detach the user's own seed from the active token and
/// tell them the device held no key — recoverable only by a later orphan scan,
/// and leaving a plaintext copy behind each time it happened.
const ownsCache = new Map<string, boolean>();
export async function secretOwnsAddress(secret: string, address: string): Promise<boolean | null> {
  // A phrase check derives up to ACCOUNT_SCAN_LIMIT accounts; the resolver runs on
  // every send and status refresh, so remember the answer per (secret, address).
  const k = `${address}\n${secret.trim()}`;
  const hit = ownsCache.get(k);
  if (hit !== undefined) return hit;
  let owns: boolean;
  try {
    owns = (await keyForWallet(secret, address)) !== null;
  } catch {
    return null; // undecidable now (signer not ready): do not cache, do not act
  }
  ownsCache.set(k, owns);
  return owns;
}

/// "Is this definitely this wallet's key?" — undecidable counts as no.
/// For the question "may I hand this out as the key", which is the safe default.
export async function secretDefinitelyOwns(secret: string, address: string): Promise<boolean> {
  return (await secretOwnsAddress(secret, address)) === true;
}

/// The stored secret under the active token did not derive the wallet on screen.
/// Keep it — it may be another wallet's key, and the orphan scan can still find
/// it — but move it out of the way so it is never shown as THIS wallet's key.
///
/// Sealed when the device is locked. It used to be written in the clear
/// unconditionally, and the ONLY thing that ever swept those copies up was
/// `enableLock()`, which runs once when the lock is first turned on — so every
/// stray produced afterwards was a spending key sitting in plaintext
/// localStorage on a device whose owner had switched the lock on precisely to
/// stop that. A stray written while locked (no session secret to seal with) is
/// not written at all and the seed stays where it is: leaving it misfiled is
/// recoverable, writing it in the clear is not.
///
/// Returns whether the seed was moved.
async function shelveMismatchedSeed(token: string, secret: string): Promise<boolean> {
  const stray = `stray_${token}_${Date.now()}`;
  try {
    if (isLockEnabled()) {
      if (!(await sealNewSeed(stray, secret))) return false;
    } else {
      localStorage.setItem(`device_seed_${stray}`, secret);
    }
    localStorage.removeItem(`device_seed_${token}`);
    return true;
  } catch {
    return false; // quota or a sealing failure: leave the seed in place
  }
}

/**
 * Can anything this device holds sign for `address`? Read-only, three-state.
 *
 * The question the send path answers destructively — `resolveDeviceSeed` shelves a
 * mismatched seed and reattaches an orphan's birthday — asked without touching anything,
 * so a screen can show the answer before the user needs it. Measured gap: with a stored
 * seed that derives a DIFFERENT address, Receive displayed the wallet's address with no
 * indication at all, and the mismatch only surfaced at "Confirm & send". Somebody can
 * fund an address this device cannot spend from and not find out until they try.
 *
 * `null` means UNDECIDABLE — the signer was not ready — and the caller must say nothing.
 * The difference matters: a wrong "cannot send" on a healthy wallet is worse than the late
 * failure this replaces, because the late failure at least refuses to sign.
 *
 * Account-aware through `secretOwnsAddress`, so a phrase-derived wallet whose stored
 * secret is a phrase (not this account's raw seed) is NOT reported as foreign — the naive
 * `addressFromSeed` comparison would have branded those wallets unusable. Answers are
 * cached per (secret, address) by that helper, so this is one derivation per wallet, not
 * one per render.
 */
export async function deviceCanSign(address: string): Promise<boolean | null> {
  if (!address) return null;
  // The same candidates findOrphanedSeed considers — every secret stored under any token,
  // plus any held unlocked in memory — read without writing any of them back.
  const candidates = new Set(heldSecrets().keys());
  // Nothing found is only an ANSWER if we were allowed to look. When the browser blocks
  // site storage the shim substitutes an in-memory store, so every read succeeds and
  // returns nothing — indistinguishable here from a device that genuinely holds no key.
  // Reporting that as a definite "cannot sign" puts "this device can't spend from this
  // address" over a wallet whose key is on disk and simply unreachable this session, which
  // is exactly the wrong-way-round warning the contract above forbids.
  if (candidates.size === 0) return storageIsEphemeral() ? null : false;
  let undecided = false;
  for (const secret of candidates) {
    const owns = await secretOwnsAddress(secret, address);
    if (owns === true) return true;
    if (owns === null) undecided = true;
  }
  // One undecidable candidate is enough to stay quiet: it may be the one that owns it.
  return undecided ? null : false;
}

export async function resolveDeviceSeed(expectedAddress?: string): Promise<string> {
  const stored = getDeviceSeed();
  // A stored secret is only this wallet's key if it derives this wallet's address.
  // Returning it unchecked is how a desktop revealed — and wrote into a backup file —
  // a phrase for a wallet that phrase does not own.
  const owns = stored && expectedAddress ? await secretOwnsAddress(stored, expectedAddress) : true;
  if (stored && owns === true) return stored;
  // Shelving is a destructive move, so it needs a DEFINITE mismatch. `null` means
  // we could not derive anything and therefore know nothing: leave the seed
  // exactly where it is and fail this attempt. The next one, with a working
  // signer, returns it normally.
  if (stored && expectedAddress && owns === false) {
    await shelveMismatchedSeed(readLocal("wallet_token") || "default", stored);
  }
  if (expectedAddress) {
    const orphan = await findOrphanedSeed(expectedAddress);
    if (orphan) {
      setDeviceSeed(orphan);
      return orphan;
    }
  }
  // No custodial fallback. The wallet service is viewing-key-only and holds no
  // seed to hand back, so asking it for one could only ever help a wallet from
  // the old custodial model — at the cost of a path that pulls a spending key
  // over the network. The device asks the user to restore instead.
  throw new Error(SEED_REQUIRED);
}

/** Key recording that a freshly created wallet has NOT had its phrase written down. */
function backupKey(token: string): string {
  return `backup_pending_${token}`;
}

/// A new wallet's recovery phrase has not been written down yet.
///
/// The backup card used to live in React state alone, so one tap on "Explore" —
/// the nav bar sits 40px below it and is fully live — or a plain reload destroyed
/// it permanently. The phrase had never been revealed, the quiz had never run, and
/// NOTHING recorded that it was skipped: `main.tsx` asserts "which is why the
/// backup nag exists", and grepping the repo for one finds nothing. A wallet could
/// therefore be funded for months with no backup and no reminder, and this storage
/// is the same storage a browser may evict after 7 days.
export function markBackupPending(token: string, address: string): void {
  try {
    localStorage.setItem(backupKey(token), address);
  } catch {
    /* storage full / private mode: the in-memory card still shows this session */
  }
}

/** The address of the wallet still awaiting a written-down phrase, if any. */
export function backupPending(token: string): string | null {
  try {
    return localStorage.getItem(backupKey(token));
  } catch {
    return null;
  }
}

/** Cleared only by finishing the backup — reaching the end of the quiz. */
export function clearBackupPending(token: string): void {
  try {
    localStorage.removeItem(backupKey(token));
  } catch {
    /* ignore */
  }
}
