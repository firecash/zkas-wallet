// Encrypted backup of the seed THIS DEVICE holds.
//
// Why this exists separately from the daemon's backup: the wallet is
// non-custodial by design — the seed is generated in the app, only the viewing
// key is registered with the daemon, and the seed itself lives in this device's
// localStorage. So the daemon genuinely has nothing to back up ("watch-only"),
// while the app has the one secret that matters. A backup must therefore be
// produced here, client-side, from `device_seed_<token>`.
//
// Crypto: PBKDF2-SHA256 (600k iterations, OWASP-current) → AES-256-GCM, all via
// WebCrypto so there is no dependency to audit. The file is useless without the
// passphrase; GCM's tag also makes a wrong passphrase a clean failure rather
// than silently yielding garbage that would restore an empty wallet.

const MAGIC = "zkas-wallet-backup";
const VERSION = 2;
const PBKDF2_ITERATIONS = 600_000;

export interface SeedBackup {
  magic: string;
  version: number;
  kind: "device-seed";
  network: string;
  /** Wallet birthday so a restore syncs from there, not genesis. */
  birthday: number;
  saltB64: string;
  ivB64: string;
  ciphertextB64: string;
  createdUnix: number;
}

const b64 = (b: ArrayBuffer | Uint8Array) =>
  btoa(String.fromCharCode(...new Uint8Array(b as ArrayBuffer)));

const unb64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

export async function deriveKey(passphrase: string, salt: Uint8Array): Promise<CryptoKey> {
  const material = await crypto.subtle.importKey("raw", new TextEncoder().encode(passphrase), "PBKDF2", false, [
    "deriveKey",
  ]);
  return crypto.subtle.deriveKey(
    { name: "PBKDF2", salt: salt as BufferSource, iterations: PBKDF2_ITERATIONS, hash: "SHA-256" },
    material,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}

/** Encrypt `seedHex` under `passphrase` into a portable backup document. */
export async function makeBackup(
  seedHex: string,
  passphrase: string,
  network: string,
  birthday: number,
): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await deriveKey(passphrase, salt);
  const ct = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv: iv as BufferSource },
    key,
    new TextEncoder().encode(seedHex),
  );
  const doc: SeedBackup = {
    magic: MAGIC,
    version: VERSION,
    kind: "device-seed",
    network,
    birthday,
    saltB64: b64(salt),
    ivB64: b64(iv),
    ciphertextB64: b64(ct),
    createdUnix: Math.floor(Date.now() / 1000),
  };
  return JSON.stringify(doc, null, 2);
}

/** Recover the seed hex from a backup document. Throws a readable message. */
export async function readBackup(json: string, passphrase: string): Promise<{ seedHex: string; birthday: number }> {
  let doc: SeedBackup;
  try {
    doc = JSON.parse(json);
  } catch {
    throw new Error("That file is not a ZKas wallet backup.");
  }
  if (doc?.magic !== MAGIC) throw new Error("That file is not a ZKas wallet backup.");
  if (doc.version > VERSION) throw new Error("This backup was written by a newer wallet — update the app first.");
  const key = await deriveKey(passphrase, unb64(doc.saltB64));
  let plain: ArrayBuffer;
  try {
    plain = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: unb64(doc.ivB64) as BufferSource },
      key,
      unb64(doc.ciphertextB64),
    );
  } catch {
    // GCM authentication failed — the passphrase is wrong (or the file was edited).
    throw new Error("Wrong passphrase for this backup file.");
  }
  const seedHex = new TextDecoder().decode(plain).trim();
  // A backup holds either a legacy 64-hex seed or a recovery phrase. Both restore
  // a wallet; rejecting the phrase here would make phrase-era backups unreadable.
  const isHex = /^[0-9a-fA-F]{64}$/.test(seedHex);
  const words = seedHex.split(/\s+/);
  const isPhrase = words.length >= 12 && words.length <= 24 && words.every((w) => /^[a-z]+$/i.test(w));
  if (!isHex && !isPhrase) throw new Error("Backup decrypted but does not contain a valid seed.");
  return { seedHex, birthday: doc.birthday ?? 0 };
}

// --- Generic string encryption, shared with the app lock ------------------
// Same construction as the backup file; kept in one place so there is a single
// crypto path to review rather than two that drift.

export interface Sealed {
  saltB64: string;
  ivB64: string;
  ciphertextB64: string;
}

export async function seal(plaintext: string, passphrase: string): Promise<Sealed> {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await deriveKey(passphrase, salt);
  const ct = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv: iv as BufferSource },
    key,
    new TextEncoder().encode(plaintext),
  );
  return { saltB64: b64(salt), ivB64: b64(iv), ciphertextB64: b64(ct) };
}

/** Returns null when the passphrase is wrong (GCM tag mismatch). */
export async function unseal(sealed: Sealed, passphrase: string): Promise<string | null> {
  try {
    const key = await deriveKey(passphrase, unb64(sealed.saltB64));
    const plain = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: unb64(sealed.ivB64) as BufferSource },
      key,
      unb64(sealed.ciphertextB64),
    );
    return new TextDecoder().decode(plain);
  } catch {
    return null;
  }
}
