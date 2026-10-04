// The chat engine: NIP-06 identity derivation, event signing, proof of work.
//
// A SEPARATE wasm module from the payment signer, and deliberately so. It has no
// dependency on shielded-core, orchard or the spend path — it cannot derive a
// spending key or sign a payment. Keeping it apart also means the wallet does
// not grow for people who never turn chat on: like `src/signer`, the blob is
// behind a dynamic import, so it is fetched on first use and never before.

import init, {
  chat_identity as wasmChatIdentity,
  sign_chat_event_with_key as wasmSignWithKey,
  npub_to_hex as wasmNpubToHex,
  hex_to_npub as wasmHexToNpub,
  verify_chat_event as wasmVerify,
  dm_wrap as wasmDmWrap,
  dm_unwrap as wasmDmUnwrap,
  xonly_pubkey as wasmXonly,
} from "./zkas_chat_identity.js";

let ready: Promise<void> | null = null;

function wasmBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** Initialise once; safe to await repeatedly. */
export function ensureEngine(): Promise<void> {
  if (!ready)
    ready = import("./wasm-base64.js").then(({ WASM_B64 }) =>
      init({ module_or_path: wasmBytes(WASM_B64) }).then(() => undefined),
    );
  return ready;
}

export interface Identity {
  pubkey_hex: string;
  privkey_hex: string;
  npub: string;
  nsec: string;
  is_nip06: boolean;
}

/** Derive the chat identity for `account` from the wallet's own secret.
 *
 *  `account` doubles as the per-room pseudonym index: a different account is an
 *  unrelated identity, which is what keeps two rooms from being cross-referenced. */
export async function chatIdentity(secret: string, account: number): Promise<Identity> {
  await ensureEngine();
  const id = wasmChatIdentity(secret, account);
  return {
    pubkey_hex: id.pubkey_hex,
    privkey_hex: id.privkey_hex,
    npub: id.npub,
    nsec: id.nsec,
    is_nip06: id.is_nip06,
  };
}

/** Sign (and optionally mine) an event. Returns the wire JSON. */
export async function signEvent(
  privkeyHex: string,
  kind: number,
  tagsJson: string,
  content: string,
  createdAt: number,
  difficulty: number,
  maxMs: number,
): Promise<string> {
  await ensureEngine();
  // `created_at` and `max_ms` are u64 in the engine, so the bindings want BigInt.
  // Converting here keeps a plain-number API for callers.
  return wasmSignWithKey(
    privkeyHex,
    kind,
    tagsJson,
    content,
    BigInt(Math.floor(createdAt)),
    difficulty,
    BigInt(Math.floor(maxMs)),
  );
}

/** Verify an event's id AND signature. Used before trusting anything a relay sent. */
export async function verifyEvent(json: string): Promise<boolean> {
  await ensureEngine();
  return wasmVerify(json);
}

export async function npubToHex(npub: string): Promise<string> {
  await ensureEngine();
  return wasmNpubToHex(npub);
}

export async function hexToNpub(hex: string): Promise<string> {
  await ensureEngine();
  return wasmHexToNpub(hex);
}

// ------------------------------------------------------------ private messages

export interface OpenedDm {
  sender: string;
  content: string;
  created_at: number;
  reply_to: string;
  id: string;
}

/** Randomness for one gift wrap, drawn from Web Crypto.
 *
 *  Generated here rather than inside the engine so the wasm needs no getrandom
 *  backend, and so every value is auditable from the JS side. */
function randomHex(bytes: number): string {
  const b = new Uint8Array(bytes);
  crypto.getRandomValues(b);
  return [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
}

/** Timestamps are randomised up to two days into the past, independently per
 *  layer. If the seal and the wrap shared a timestamp, grouping by it would
 *  re-link the conversation the wrap exists to hide. */
function jitteredPast(now: number): number {
  return now - Math.floor(Math.random() * 2 * 24 * 3600);
}

/** Wrap a private message for one recipient. */
export async function wrapDm(
  senderSecretHex: string,
  recipientPubHex: string,
  content: string,
  replyTo = "",
): Promise<string> {
  await ensureEngine();
  const now = Math.floor(Date.now() / 1000);
  return wasmDmWrap(
    senderSecretHex,
    recipientPubHex,
    content,
    replyTo,
    BigInt(now),
    BigInt(jitteredPast(now)),
    BigInt(jitteredPast(now)),
    randomHex(32),
    randomHex(32),
    // A throwaway key, used once: this is what stops a relay seeing who is
    // talking to whom.
    randomHex(32),
  );
}

export async function unwrapDm(mySecretHex: string, giftWrapJson: string): Promise<OpenedDm> {
  await ensureEngine();
  return JSON.parse(wasmDmUnwrap(mySecretHex, giftWrapJson)) as OpenedDm;
}

export async function xonlyPubkey(secretHex: string): Promise<string> {
  await ensureEngine();
  return wasmXonly(secretHex);
}
