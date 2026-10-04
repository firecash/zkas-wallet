/* tslint:disable */
/* eslint-disable */
export const memory: WebAssembly.Memory;
export const event_difficulty: (a: number, b: number) => [number, number, number];
export const hex_to_npub: (a: number, b: number) => [number, number, number, number];
export const npub_to_hex: (a: number, b: number) => [number, number, number, number];
export const nsec_to_hex: (a: number, b: number) => [number, number, number, number];
export const pubkey_for_key: (a: number, b: number) => [number, number, number, number];
export const sign_chat_event: (a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: number, i: bigint, j: number, k: bigint) => [number, number, number, number];
export const sign_chat_event_with_key: (a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: bigint, i: number, j: bigint) => [number, number, number, number];
export const verify_chat_event: (a: number, b: number) => [number, number, number];
export const dm_unwrap: (a: number, b: number, c: number, d: number) => [number, number, number, number];
export const dm_wrap: (a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: number, i: bigint, j: bigint, k: bigint, l: number, m: number, n: number, o: number, p: number, q: number) => [number, number, number, number];
export const xonly_pubkey: (a: number, b: number) => [number, number, number, number];
export const __wbg_chatidentity_free: (a: number, b: number) => void;
export const chat_identity: (a: number, b: number, c: number) => [number, number, number];
export const chatidentity_is_nip06: (a: number) => number;
export const chatidentity_npub: (a: number) => [number, number];
export const chatidentity_nsec: (a: number) => [number, number];
export const chatidentity_privkey_hex: (a: number) => [number, number];
export const chatidentity_pubkey_hex: (a: number) => [number, number];
export const __wbindgen_export_0: WebAssembly.Table;
export const __wbindgen_malloc: (a: number, b: number) => number;
export const __wbindgen_realloc: (a: number, b: number, c: number, d: number) => number;
export const __externref_table_dealloc: (a: number) => void;
export const __wbindgen_free: (a: number, b: number, c: number) => void;
export const __wbindgen_start: () => void;
