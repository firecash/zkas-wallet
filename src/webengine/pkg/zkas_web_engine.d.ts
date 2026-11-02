/* tslint:disable */
/* eslint-disable */
export function warm_prover(): void;
/**
 * The page's entry point for [`verify_manifest_str`].
 */
export function verify_manifest(json: string): string;
/**
 * Build the Halo 2 proving key now (a few seconds, once per page): called when the wallet is
 * idle at the tip, so the first payment does not pay for it. Later calls return at once.
 * Where a gateway page ends, read before it is ingested: `{last, count, reorged}` with `last` the
 * page's final block in the form `Engine::low` uses (null for an empty page). Lets the browser
 * ask for the next page while this one is ingested, instead of leaving the network idle.
 * The index of block `hash_hex` in a gateway page, or -1.
 */
export function page_index_of(bytes: Uint8Array, hash_hex: string): number;
/**
 * Does a downloaded segment match its manifest entry (size and SHA-256)?
 */
export function segment_matches(bytes: Uint8Array, sha256_hex: string, size: bigint): boolean;
export function page_cursor(bytes: Uint8Array): string;
export function address_of_fvk(fvk_hex: string): string;
/**
 * Configuration for the WASM32 bindings runtime interface.
 * @see {@link IWASM32BindingsConfig}
 * @category General
 */
export function initWASM32Bindings(config: IWASM32BindingsConfig): void;
/**
 * Present panic logs to the user in the browser.
 *
 * This function should be called after a panic has occurred and the
 * browser-based panic hook has been activated. It will present the
 * collected panic logs in a full-screen `DIV` in the browser.
 * @see {@link initBrowserPanicHook}
 * @category General
 */
export function presentPanicHookLogs(): void;
/**
 * Initialize Rust panic handler in browser mode.
 *
 * This will output additional debug information during a panic in the browser
 * by creating a full-screen `DIV`. This is useful on mobile devices or where
 * the user otherwise has no access to console/developer tools. Use
 * {@link presentPanicHookLogs} to activate the panic logs in the
 * browser environment.
 * @see {@link presentPanicHookLogs}
 * @category General
 */
export function initBrowserPanicHook(): void;
/**
 * Initialize Rust panic handler in console mode.
 *
 * This will output additional debug information during a panic to the console.
 * This function should be called right after loading WASM libraries.
 * @category General
 */
export function initConsolePanicHook(): void;
/**
 * r" Deferred promise - an object that has `resolve()` and `reject()`
 * r" functions that can be called outside of the promise body.
 * r" WARNING: This function uses `eval` and can not be used in environments
 * r" where dynamically-created code can not be executed such as web browser
 * r" extensions.
 * r" @category General
 */
export function defer(): Promise<any>;
/**
 * Set the logger log level using a string representation.
 * Available variants are: 'off', 'error', 'warn', 'info', 'debug', 'trace'
 * @category General
 */
export function setLogLevel(level: "off" | "error" | "warn" | "info" | "debug" | "trace"): void;
/**
 *
 *  Kaspa `Address` version (`PubKey`, `PubKey ECDSA`, `ScriptHash`)
 *
 * @category Address
 */
export enum AddressVersion {
  /**
   * PubKey addresses always have the version byte set to 0
   */
  PubKey = 0,
  /**
   * PubKey ECDSA addresses always have the version byte set to 1
   */
  PubKeyECDSA = 1,
  /**
   * ScriptHash addresses always have the version byte set to 8
   */
  ScriptHash = 8,
  /**
   * ZKas shielded (Orchard) addresses have the version byte set to 9.
   * The payload is the 43-byte raw Orchard address (diversifier ‖ pk_d). Such
   * an address is never spent through a transparent script — it is the
   * recipient of a shielded (Orchard) output — so it maps to no standard
   * script class (PLAN §2.10).
   */
  ShieldedOrchard = 9,
}
/**
 * @category Consensus
 */
export enum NetworkType {
  Mainnet = 0,
  Testnet = 1,
  Devnet = 2,
  Simnet = 3,
}

/**
 * Interface defines the structure of a Script Public Key.
 * 
 * @category Consensus
 */
export interface IScriptPublicKey {
    version : number;
    script: HexString;
}



    /**
     * Generic network address representation.
     * 
     * @category General
     */
    export interface INetworkAddress {
        /**
         * IPv4 or IPv6 address.
         */
        ip: string;
        /**
         * Optional port number.
         */
        port?: number;
    }



/**
 * Interface for configuring workflow-rs WASM32 bindings.
 * 
 * @category General
 */
export interface IWASM32BindingsConfig {
    /**
     * This option can be used to disable the validation of class names
     * for instances of classes exported by Rust WASM32 when passing
     * these classes to WASM32 functions.
     * 
     * This can be useful to programmatically disable checks when using
     * a bundler that mangles class symbol names.
     */
    validateClassNames : boolean;
}


/**
 *
 * Abortable trigger wraps an `Arc<AtomicBool>`, which can be cloned
 * to signal task terminating using an atomic bool.
 *
 * ```text
 * let abortable = Abortable::default();
 * let result = my_task(abortable).await?;
 * // ... elsewhere
 * abortable.abort();
 * ```
 *
 * @category General
 */
export class Abortable {
  free(): void;
  isAborted(): boolean;
  constructor();
  abort(): void;
  check(): void;
  reset(): void;
}
/**
 * Error emitted by [`Abortable`].
 * @category General
 */
export class Aborted {
  private constructor();
  free(): void;
}
/**
 * Kaspa [`Address`] struct that serializes to and from an address format string: `kaspa:qz0s...t8cv`.
 *
 * @category Address
 */
export class Address {
/**
** Return copy of self without private attributes.
*/
  toJSON(): Object;
/**
* Return stringified version of self.
*/
  toString(): string;
  free(): void;
  constructor(address: string);
  /**
   * Convert an address to a string.
   */
  toString(): string;
  static validate(address: string): boolean;
  readonly prefix: string;
  readonly payload: string;
  readonly version: string;
  set setPrefix(value: string);
}
export class Engine {
  free(): void;
  /**
   * Everything needed to resume: kept by the page (IndexedDB) and given to `restore`.
   */
  checkpoint(): Uint8Array;
  /**
   * The matured anchor: the node's tree frontier at a chain block deep enough that a spend
   * rooted there is final when mined (the gateway's `/tree?below=<tip - margin>`). Notes
   * below its leaf count are spendable; the rest are maturing. Witnesses are advanced to it
   * here, a little at a time, so a send is a lookup.
   * Take `boundary_json` as the matured anchor. Returns why not, if not: "ahead" (beyond what
   * this wallet has ingested) or "below_base" (below the leaves it holds); the last anchor stays.
   */
  set_anchor(boundary_json: string): string | undefined;
  /**
   * See [`Engine::page`].
   */
  ingest_page(bytes: Uint8Array): string;
  /**
   * The mempool's shielded bundles (hex payloads, from the gateway's `/mempool`): what they
   * would do to this wallet once mined. Bundles already counted from the unsettled blocks
   * are skipped, so a payment crossing from mempool to block is counted once.
   */
  set_mempool(payloads_json: string): void;
  /**
   * Counts only, for the diagnostic log: where the tree, its base and the anchor are, and how
   * many leaves the oldest coin not yet under the anchor still needs (0: all spendable).
   */
  anchor_debug(): string;
  /**
   * Build and prove a payment of `amount` sompi to `to` (a `zkas:` address) from this
   * wallet's matured notes, rooted at the matured anchor. `sk_hex` is the wallet's 32-byte
   * spending key; it is used for this call only. Returns the bundle to submit, the leaf
   * positions it spends and the fee. Nothing is marked spent until [`Engine::mark_sent`].
   */
  prepare_send(sk_hex: string, to: string, amount: bigint, memo: string): string;
  /**
   * This wallet's tree frontier at `low()`, as the gateway's /tree answers it — for the
   * check against the node. Undefined while the wallet holds no tree of its own.
   */
  tip_frontier(): string | undefined;
  /**
   * A wallet adopted from a wallet service's scan receipt (see [`Engine::from_receipt`]).
   */
  static adopt_receipt(fvk_hex: string, receipt: Uint8Array, node_boundary_json: string, birthday: bigint): Engine;
  /**
   * See [`Engine::segment`].
   */
  ingest_segment(bytes: Uint8Array, index: bigint, from_block_hex: string, to_boundary_json: string): string;
  /**
   * The general form of [`Engine::prepare_send`]: several payees in one transaction
   * (`payees_json` = `[{to, amount_sompi, memo}]`), or a consolidation (`opts.consolidate`:
   * no payees; the wallet's settled coins merged into one, paid to itself), with
   * `opts.recoverable` (default true) choosing whether the payment can be read back from
   * the seed (false = the wallet's "private sends"). Returns the same shape as prepare_send,
   * plus `merged` (coins merged) for a consolidation.
   */
  prepare_payment(sk_hex: string, payees_json: string, opts_json: string): string;
  /**
   * [`Engine::ingest_page`] up to and including block `stop_hex` (the whole page when absent).
   */
  ingest_page_until(bytes: Uint8Array, stop_hex: string): string;
  low(): string;
  /**
   * A new wallet watching `fvk_hex`, starting at a manifest segment boundary (`from` of the
   * segment the birthday falls in: its frontier and block). `birthday` is kept for status.
   */
  constructor(fvk_hex: string, boundary_json: string, birthday: bigint);
  status(): string;
  /**
   * This wallet's history in walletd's `/api/wallet/history` shape, newest first, so the app's
   * history view reads it unchanged. Recipient addresses and the per-address breakdown are not
   * rendered here yet (they need the address encoding), and stay null / empty.
   */
  history(limit: number, offset: number): string;
  /**
   * A wallet restored from `checkpoint()` bytes.
   */
  static restore(fvk_hex: string, bytes: Uint8Array): Engine;
  scanned(): bigint;
  /**
   * Are all of these leaf positions still unspent notes of this wallet (none spent or parked
   * since)? A payment proven ahead of the user's confirmation is submitted only if so.
   */
  unspent(positions_json: string): boolean;
  /**
   * The payment `txid` was accepted by the node: park its notes (they leave the balance, and
   * return on their own if the payment is never mined) and record the change coming back.
   */
  mark_sent(positions_json: string, txid_hex: string, outflow: bigint): void;
}
/**
 * @category General
 */
export class Hash {
  free(): void;
  constructor(hex_str: string);
  toString(): string;
}
/**
 *
 * NetworkId is a unique identifier for a kaspa network instance.
 * It is composed of a network type and an optional suffix.
 *
 * @category Consensus
 */
export class NetworkId {
/**
** Return copy of self without private attributes.
*/
  toJSON(): Object;
/**
* Return stringified version of self.
*/
  toString(): string;
  free(): void;
  toString(): string;
  addressPrefix(): string;
  constructor(value: any);
  type: NetworkType;
  get suffix(): number | undefined;
  set suffix(value: number | null | undefined);
  readonly id: string;
}
/**
 * Represents a Kaspad ScriptPublicKey
 * @category Consensus
 */
export class ScriptPublicKey {
/**
** Return copy of self without private attributes.
*/
  toJSON(): Object;
/**
* Return stringified version of self.
*/
  toString(): string;
  free(): void;
  constructor(version: number, script: any);
  readonly script: string;
  version: number;
}
export class SigHashType {
  private constructor();
  free(): void;
}
/**
 * Holds details about an individual transaction output in a utxo
 * set such as whether or not it was contained in a coinbase tx, the daa
 * score of the block that accepts the tx, its public key script, and how
 * much it pays.
 * @category Consensus
 */
export class TransactionUtxoEntry {
  private constructor();
/**
** Return copy of self without private attributes.
*/
  toJSON(): Object;
/**
* Return stringified version of self.
*/
  toString(): string;
  free(): void;
  amount: bigint;
  scriptPublicKey: ScriptPublicKey;
  blockDaaScore: bigint;
  isCoinbase: boolean;
  get covenantId(): Hash | undefined;
  set covenantId(value: Hash | null | undefined);
}

export type InitInput = RequestInfo | URL | Response | BufferSource | WebAssembly.Module;

export interface InitOutput {
  readonly memory: WebAssembly.Memory;
  readonly __wbg_engine_free: (a: number, b: number) => void;
  readonly address_of_fvk: (a: number, b: number, c: number) => void;
  readonly engine_adopt_receipt: (a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: bigint) => void;
  readonly engine_anchor_debug: (a: number, b: number) => void;
  readonly engine_checkpoint: (a: number, b: number) => void;
  readonly engine_history: (a: number, b: number, c: number, d: number) => void;
  readonly engine_ingest_page: (a: number, b: number, c: number, d: number) => void;
  readonly engine_ingest_page_until: (a: number, b: number, c: number, d: number, e: number, f: number) => void;
  readonly engine_ingest_segment: (a: number, b: number, c: number, d: number, e: bigint, f: number, g: number, h: number, i: number) => void;
  readonly engine_low: (a: number, b: number) => void;
  readonly engine_mark_sent: (a: number, b: number, c: number, d: number, e: number, f: number, g: bigint) => void;
  readonly engine_new: (a: number, b: number, c: number, d: number, e: number, f: bigint) => void;
  readonly engine_prepare_payment: (a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: number) => void;
  readonly engine_prepare_send: (a: number, b: number, c: number, d: number, e: number, f: number, g: bigint, h: number, i: number) => void;
  readonly engine_restore: (a: number, b: number, c: number, d: number, e: number) => void;
  readonly engine_scanned: (a: number) => bigint;
  readonly engine_set_anchor: (a: number, b: number, c: number, d: number) => void;
  readonly engine_set_mempool: (a: number, b: number, c: number, d: number) => void;
  readonly engine_status: (a: number, b: number) => void;
  readonly engine_tip_frontier: (a: number, b: number) => void;
  readonly engine_unspent: (a: number, b: number, c: number) => number;
  readonly page_cursor: (a: number, b: number, c: number) => void;
  readonly page_index_of: (a: number, b: number, c: number, d: number, e: number) => void;
  readonly segment_matches: (a: number, b: number, c: number, d: number, e: bigint) => number;
  readonly verify_manifest: (a: number, b: number, c: number) => void;
  readonly warm_prover: () => void;
  readonly __wbg_get_networkid_suffix: (a: number) => number;
  readonly __wbg_get_networkid_type: (a: number) => number;
  readonly __wbg_networkid_free: (a: number, b: number) => void;
  readonly __wbg_set_networkid_suffix: (a: number, b: number) => void;
  readonly __wbg_set_networkid_type: (a: number, b: number) => void;
  readonly networkid_addressPrefix: (a: number, b: number) => void;
  readonly networkid_ctor: (a: number, b: number) => void;
  readonly networkid_id: (a: number, b: number) => void;
  readonly networkid_toString: (a: number, b: number) => void;
  readonly __wbg_get_scriptpublickey_version: (a: number) => number;
  readonly __wbg_get_transactionutxoentry_amount: (a: number) => bigint;
  readonly __wbg_get_transactionutxoentry_blockDaaScore: (a: number) => bigint;
  readonly __wbg_get_transactionutxoentry_covenantId: (a: number) => number;
  readonly __wbg_get_transactionutxoentry_isCoinbase: (a: number) => number;
  readonly __wbg_get_transactionutxoentry_scriptPublicKey: (a: number) => number;
  readonly __wbg_scriptpublickey_free: (a: number, b: number) => void;
  readonly __wbg_set_scriptpublickey_version: (a: number, b: number) => void;
  readonly __wbg_set_transactionutxoentry_amount: (a: number, b: bigint) => void;
  readonly __wbg_set_transactionutxoentry_blockDaaScore: (a: number, b: bigint) => void;
  readonly __wbg_set_transactionutxoentry_covenantId: (a: number, b: number) => void;
  readonly __wbg_set_transactionutxoentry_isCoinbase: (a: number, b: number) => void;
  readonly __wbg_set_transactionutxoentry_scriptPublicKey: (a: number, b: number) => void;
  readonly __wbg_transactionutxoentry_free: (a: number, b: number) => void;
  readonly scriptpublickey_constructor: (a: number, b: number, c: number) => void;
  readonly scriptpublickey_script_as_hex: (a: number, b: number) => void;
  readonly __wbg_sighashtype_free: (a: number, b: number) => void;
  readonly rustsecp256k1_v0_10_0_context_create: (a: number) => number;
  readonly rustsecp256k1_v0_10_0_default_error_callback_fn: (a: number, b: number) => void;
  readonly rustsecp256k1_v0_10_0_default_illegal_callback_fn: (a: number, b: number) => void;
  readonly rustsecp256k1_v0_10_0_context_destroy: (a: number) => void;
  readonly __wbg_hash_free: (a: number, b: number) => void;
  readonly hash_constructor: (a: number, b: number) => number;
  readonly hash_toString: (a: number, b: number) => void;
  readonly __wbg_address_free: (a: number, b: number) => void;
  readonly address_constructor: (a: number, b: number) => number;
  readonly address_payload: (a: number, b: number) => void;
  readonly address_prefix: (a: number, b: number) => void;
  readonly address_set_setPrefix: (a: number, b: number, c: number) => void;
  readonly address_toString: (a: number, b: number) => void;
  readonly address_validate: (a: number, b: number) => number;
  readonly address_version: (a: number, b: number) => void;
  readonly initWASM32Bindings: (a: number, b: number) => void;
  readonly initBrowserPanicHook: () => void;
  readonly initConsolePanicHook: () => void;
  readonly presentPanicHookLogs: () => void;
  readonly defer: () => number;
  readonly __wbg_abortable_free: (a: number, b: number) => void;
  readonly __wbg_aborted_free: (a: number, b: number) => void;
  readonly abortable_abort: (a: number) => void;
  readonly abortable_check: (a: number, b: number) => void;
  readonly abortable_isAborted: (a: number) => number;
  readonly abortable_new: () => number;
  readonly abortable_reset: (a: number) => void;
  readonly setLogLevel: (a: number) => void;
  readonly __wbindgen_export_0: (a: number) => void;
  readonly __wbindgen_export_1: (a: number, b: number, c: number) => void;
  readonly __wbindgen_export_2: (a: number, b: number) => number;
  readonly __wbindgen_export_3: (a: number, b: number, c: number, d: number) => number;
  readonly __wbindgen_add_to_stack_pointer: (a: number) => number;
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
