// Client-side FireCash key primitives, powered by the `firecash-signer` crate
// compiled to WebAssembly (no proving circuit). Everything here runs entirely in
// the browser / device — no server, no key material ever leaves the page. Used for
// on-device wallet generation, address derivation, and message signing/verifying.
//
// The wasm is inlined as base64 (see ./wasm-base64.js), so there is no separate
// asset to fetch and it works identically in the hosted web app and the Capacitor
// native build.

import init, {
  new_wallet,
  address_from_seed,
  sign as _sign,
  verify as _verify,
  fvk_hex as _fvk_hex,
  sign_spend_auth as _sign_spend_auth,
} from "./firecash_signer.js";
import { WASM_B64 } from "./wasm-base64.js";

export type Network = "mainnet" | "testnet";

export interface LocalWallet {
  seedHex: string;
  address: string;
}
export interface LocalSignature {
  address: string;
  signatureHex: string;
}

let ready: Promise<void> | null = null;

function wasmBytes(): Uint8Array {
  const bin = atob(WASM_B64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** Initialise the wasm module exactly once. Safe to await repeatedly. */
export function ensureSigner(): Promise<void> {
  if (!ready) ready = init({ module_or_path: wasmBytes() }).then(() => undefined);
  return ready;
}

/** Generate a brand-new wallet (random seed + address) entirely on-device. */
export async function generateWallet(network: Network): Promise<LocalWallet> {
  await ensureSigner();
  const w = new_wallet(network);
  return { seedHex: w.seed_hex, address: w.address };
}

/** Derive the `firecash:` address for an existing seed, on-device. */
export async function addressFromSeed(seedHex: string, network: Network): Promise<string> {
  await ensureSigner();
  return address_from_seed(seedHex.trim(), network);
}

/** Sign a message on-device. The seed never leaves this page. */
export async function signLocal(seedHex: string, network: Network, message: string): Promise<LocalSignature> {
  await ensureSigner();
  const s = _sign(seedHex.trim(), network, message);
  return { address: s.address, signatureHex: s.signature_hex };
}

/** Verify a signature on-device (no server involved). */
export async function verifyLocal(address: string, message: string, signatureHex: string): Promise<boolean> {
  await ensureSigner();
  return _verify(address.trim(), message, signatureHex.trim());
}

/**
 * The wallet's 96-byte full viewing key (hex), derived on-device. Sent to the
 * daemon's non-custodial `/prepare` so it can scan watch-only and build the proof.
 * Grants viewing, not spend — the seed stays on this device.
 */
export async function fvkHex(seedHex: string): Promise<string> {
  await ensureSigner();
  return _fvk_hex(seedHex.trim());
}

/**
 * Device half of a non-custodial payment: sign one spend's `alpha` randomizer over
 * the payment `sighash` (both hex, from `/prepare`), returning the 64-byte RedPallas
 * spend-auth signature (hex). The seed never leaves the device.
 */
export async function signSpendAuth(seedHex: string, alphaHex: string, sighashHex: string): Promise<string> {
  await ensureSigner();
  return _sign_spend_auth(seedHex.trim(), alphaHex.trim(), sighashHex.trim());
}
