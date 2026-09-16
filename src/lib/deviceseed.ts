import { loadStatusCache, type Status } from "../api";
import { addressFromSeed, accountAddress, accountSeedHex, type Network } from "../signer";
import { unlockedDeviceSeed, isLockEnabled, sealNewSeed, allUnlockedSeeds } from "../applock";
import { masterMnemonic, setAccountOf, clearAccountOf, adoptExistingPhrase } from "../accounts";
import { listWallets } from "../wallets";

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
  return `device_seed_${localStorage.getItem("wallet_token") || "default"}`;
}

export function getDeviceSeed(): string {
  const unlocked = unlockedDeviceSeed();
  if (unlocked) return unlocked;
  if (isLockEnabled()) {
    const token = localStorage.getItem("wallet_token") || "default";
    if (localStorage.getItem(`seed_unsealed_${token}`)) return localStorage.getItem(deviceSeedKey()) || "";
    return "";
  }
  return localStorage.getItem(deviceSeedKey()) || "";
}

export function setDeviceSeed(seed: string) {
  if (!seed) return;
  if (isLockEnabled()) {
    const token = localStorage.getItem("wallet_token") || "default";
    void sealNewSeed(token, seed).then((ok) => {
      if (!ok) {
        localStorage.setItem(deviceSeedKey(), seed);
        localStorage.setItem(`seed_unsealed_${token}`, "1");
      }
    });
    return;
  }
  localStorage.setItem(deviceSeedKey(), seed);
}

function birthdayKey(): string {
  return `birthday_${localStorage.getItem("wallet_token") || "default"}`;
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
    localStorage.setItem(birthdayKey(), v);
    if (address) {
      // Per address keep the EARLIEST value ever recorded: starting a scan too
      // early costs seconds, starting it too late costs notes.
      const prev = addressBirthday(address);
      if (!prev || daa < prev) localStorage.setItem(birthdayAddrKey(address), v);
    }
  } catch {
    /* best-effort */
  }
}

/// The active token's remembered birthday only; 0 when this token has none.
/// Prefer `knownBirthday` wherever the number is about to be SENT somewhere.
export function walletBirthday(): number {
  return positive(localStorage.getItem(birthdayKey()));
}

/// The per-address copy (see `birthdayAddrKey`); 0 when none.
export function addressBirthday(address: string): number {
  try {
    return positive(localStorage.getItem(birthdayAddrKey(address)));
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
  const v = Number(localStorage.getItem(`birthday_${token}`) || "0");
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
export async function findOrphanedSeed(expectedAddress: string): Promise<string> {
  // Seed → the token it was stored under (first one wins), so a match can bring
  // that token's remembered birthday along with it.
  const candidates = new Map<string, string>();
  for (let i = 0; i < localStorage.length; i++) {
    const k = localStorage.key(i);
    if (k?.startsWith("device_seed_")) {
      const v = localStorage.getItem(k);
      // A stored secret is either a legacy 64-hex seed or a recovery phrase.
      // Accept both shapes here: this is only a cheap pre-filter, and the
      // address-derivation check below is what actually decides.
      if (v && isSecretShaped(v) && !candidates.has(v.trim())) candidates.set(v.trim(), k.slice("device_seed_".length));
    }
  }
  for (const [token, v] of Object.entries(allUnlockedSeeds() ?? {})) if (!candidates.has(v.trim())) candidates.set(v.trim(), token);
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
      const token = localStorage.getItem("wallet_token") || "default";
      setAccountOf(token, account);
      return account === 0 ? master : await accountSeedHex(master, account);
    }
  }
  return "";
}

export const SEED_REQUIRED = "SEED_REQUIRED";

/// Does `secret` (legacy hex, or a phrase at any account) derive `address`?
/// Undecidable (signer not loaded, malformed secret) counts as "no": a secret that
/// cannot be shown to own the wallet must not be presented as its key.
const ownsCache = new Map<string, boolean>();
export async function secretOwnsAddress(secret: string, address: string): Promise<boolean> {
  // A phrase check derives up to ACCOUNT_SCAN_LIMIT accounts; the resolver runs on
  // every send and status refresh, so remember the answer per (secret, address).
  const k = `${address}\n${secret.trim()}`;
  const hit = ownsCache.get(k);
  if (hit !== undefined) return hit;
  let owns = false;
  try {
    owns = (await keyForWallet(secret, address)) !== null;
  } catch {
    return false; // undecidable now (signer not ready): do not cache
  }
  ownsCache.set(k, owns);
  return owns;
}

/// The stored secret under the active token did not derive the wallet on screen.
/// Keep it — it may be another wallet's key, and `device_seed_` keeps it visible to
/// the orphan scan — but move it out of the way so it is never shown as THIS
/// wallet's key again.
function shelveMismatchedSeed(token: string, secret: string): void {
  try {
    localStorage.setItem(`device_seed_stray_${token}_${Date.now()}`, secret);
    localStorage.removeItem(`device_seed_${token}`);
  } catch {
    /* best effort */
  }
}

export async function resolveDeviceSeed(expectedAddress?: string): Promise<string> {
  const stored = getDeviceSeed();
  // A stored secret is only this wallet's key if it derives this wallet's address.
  // Returning it unchecked is how a desktop revealed — and wrote into a backup file —
  // a phrase for a wallet that phrase does not own.
  if (stored && (!expectedAddress || (await secretOwnsAddress(stored, expectedAddress)))) return stored;
  if (stored && expectedAddress) {
    shelveMismatchedSeed(localStorage.getItem("wallet_token") || "default", stored);
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
