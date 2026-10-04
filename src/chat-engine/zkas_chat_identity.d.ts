/* tslint:disable */
/* eslint-disable */
/**
 * `nsec1…` → 32-byte hex secret key. For importing an existing Nostr identity.
 */
export function nsec_to_hex(nsec: string): string;
/**
 * Sign with an imported Nostr key rather than a ZKas secret.
 */
export function sign_chat_event_with_key(privkey_hex: string, kind: number, tags_json: string, content: string, created_at: bigint, difficulty: number, max_ms: bigint): string;
/**
 * The x-only public key, hex, for a raw secret key — so an imported identity can
 * show its own `npub` without re-deriving anything.
 */
export function pubkey_for_key(privkey_hex: string): string;
/**
 * `npub1…` → 32-byte hex public key.
 */
export function npub_to_hex(npub: string): string;
/**
 * 32-byte hex public key → `npub1…`.
 */
export function hex_to_npub(pubkey_hex: string): string;
/**
 * Verify an event's id and signature.
 */
export function verify_chat_event(json: string): boolean;
/**
 * Difficulty (leading zero bits) of an event id, for displaying or filtering.
 */
export function event_difficulty(id_hex: string): number;
/**
 * Sign and (optionally) mine an event. `tags_json` is a JSON array of arrays of
 * strings; it is parsed here and re-serialized canonically, never passed through.
 */
export function sign_chat_event(secret: string, account: number, kind: number, tags_json: string, content: string, created_at: bigint, difficulty: number, max_ms: bigint): string;
/**
 * Wrap a private message. All randomness is supplied by the caller — the TS
 * layer draws it from Web Crypto — so this stays deterministic and testable.
 */
export function dm_wrap(sender_sk_hex: string, recipient_pub_hex: string, content: string, reply_to: string, rumor_created_at: bigint, seal_created_at: bigint, wrap_created_at: bigint, seal_nonce_hex: string, wrap_nonce_hex: string, ephemeral_sk_hex: string): string;
/**
 * The x-only public key for a secret key — needed to address a DM to someone
 * and to recognise our own.
 */
export function xonly_pubkey(sec_hex: string): string;
/**
 * Open a gift wrap addressed to us. Returns `{sender, content, created_at, reply_to, id}`.
 */
export function dm_unwrap(my_sk_hex: string, gift_wrap_json: string): string;
/**
 * Derive the chat identity for `account` from the user's secret.
 *
 * `secret` is whatever the wallet already holds: a BIP-39 recovery phrase, or a
 * legacy 64-hex seed. `account` is the NIP-06 account index, and doubles as the
 * per-room pseudonym index.
 *
 * This accepts the same secret the money signer accepts, and that is the point —
 * one phrase, no second thing to back up. It reads the secret and returns a
 * secp256k1 key; it has no code path that could produce a spending key.
 */
export function chat_identity(secret: string, account: number): ChatIdentity;
/**
 * A derived chat identity. Mirrors what every Nostr client expects.
 */
export class ChatIdentity {
  private constructor();
  free(): void;
  /**
   * 32-byte x-only public key, hex — the Nostr `pubkey` field.
   */
  readonly pubkey_hex: string;
  /**
   * 32-byte secret key, hex. **Treat exactly like a private key.**
   */
  readonly privkey_hex: string;
  /**
   * NIP-19 `npub1…`. Public; this is the handle others block or follow.
   */
  readonly npub: string;
  /**
   * NIP-19 `nsec1…`. Secret.
   */
  readonly nsec: string;
  /**
   * True when this came from a recovery phrase and is therefore the *standard*
   * NIP-06 identity, portable to any Nostr client. False for a legacy raw-seed
   * wallet, whose identity is ZKas-specific (see [`LEGACY_DOMAIN`]).
   */
  readonly is_nip06: boolean;
}

export type InitInput = RequestInfo | URL | Response | BufferSource | WebAssembly.Module;

export interface InitOutput {
  readonly memory: WebAssembly.Memory;
  readonly event_difficulty: (a: number, b: number) => [number, number, number];
  readonly hex_to_npub: (a: number, b: number) => [number, number, number, number];
  readonly npub_to_hex: (a: number, b: number) => [number, number, number, number];
  readonly nsec_to_hex: (a: number, b: number) => [number, number, number, number];
  readonly pubkey_for_key: (a: number, b: number) => [number, number, number, number];
  readonly sign_chat_event: (a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: number, i: bigint, j: number, k: bigint) => [number, number, number, number];
  readonly sign_chat_event_with_key: (a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: bigint, i: number, j: bigint) => [number, number, number, number];
  readonly verify_chat_event: (a: number, b: number) => [number, number, number];
  readonly dm_unwrap: (a: number, b: number, c: number, d: number) => [number, number, number, number];
  readonly dm_wrap: (a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: number, i: bigint, j: bigint, k: bigint, l: number, m: number, n: number, o: number, p: number, q: number) => [number, number, number, number];
  readonly xonly_pubkey: (a: number, b: number) => [number, number, number, number];
  readonly __wbg_chatidentity_free: (a: number, b: number) => void;
  readonly chat_identity: (a: number, b: number, c: number) => [number, number, number];
  readonly chatidentity_is_nip06: (a: number) => number;
  readonly chatidentity_npub: (a: number) => [number, number];
  readonly chatidentity_nsec: (a: number) => [number, number];
  readonly chatidentity_privkey_hex: (a: number) => [number, number];
  readonly chatidentity_pubkey_hex: (a: number) => [number, number];
  readonly __wbindgen_export_0: WebAssembly.Table;
  readonly __wbindgen_malloc: (a: number, b: number) => number;
  readonly __wbindgen_realloc: (a: number, b: number, c: number, d: number) => number;
  readonly __externref_table_dealloc: (a: number) => void;
  readonly __wbindgen_free: (a: number, b: number, c: number) => void;
  readonly __wbindgen_start: () => void;
}

export type SyncInitInput = BufferSource | WebAssembly.Module;
/**
* Instantiates the given `module`, which can either be bytes or
* a precompiled `WebAssembly.Module`.
*
* @param {{ module: SyncInitInput }} module - Passing `SyncInitInput` directly is deprecated.
*
* @returns {InitOutput}
*/
export function initSync(module: { module: SyncInitInput } | SyncInitInput): InitOutput;

/**
* If `module_or_path` is {RequestInfo} or {URL}, makes a request and
* for everything else, calls `WebAssembly.instantiate` directly.
*
* @param {{ module_or_path: InitInput | Promise<InitInput> }} module_or_path - Passing `InitInput` directly is deprecated.
*
* @returns {Promise<InitOutput>}
*/
export default function __wbg_init (module_or_path?: { module_or_path: InitInput | Promise<InitInput> } | InitInput | Promise<InitInput>): Promise<InitOutput>;
