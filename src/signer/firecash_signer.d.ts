// Minimal typings for the wasm-bindgen glue (firecash_signer.js).
export class Wallet { readonly seed_hex: string; readonly address: string; }
export class Signature { readonly address: string; readonly signature_hex: string; }
export function new_wallet(network: string): Wallet;
export function address_from_seed(seed_hex: string, network: string): string;
export function sign(seed_hex: string, network: string, message: string): Signature;
export function verify(address: string, message: string, signature_hex: string): boolean;
export default function init(
  options?: { module_or_path: BufferSource | WebAssembly.Module }
): Promise<unknown>;
