let wasm;

const cachedTextDecoder = (typeof TextDecoder !== 'undefined' ? new TextDecoder('utf-8', { ignoreBOM: true, fatal: true }) : { decode: () => { throw Error('TextDecoder not available') } } );

if (typeof TextDecoder !== 'undefined') { cachedTextDecoder.decode(); };

let cachedUint8ArrayMemory0 = null;

function getUint8ArrayMemory0() {
    if (cachedUint8ArrayMemory0 === null || cachedUint8ArrayMemory0.byteLength === 0) {
        cachedUint8ArrayMemory0 = new Uint8Array(wasm.memory.buffer);
    }
    return cachedUint8ArrayMemory0;
}

function getStringFromWasm0(ptr, len) {
    ptr = ptr >>> 0;
    return cachedTextDecoder.decode(getUint8ArrayMemory0().subarray(ptr, ptr + len));
}

let WASM_VECTOR_LEN = 0;

const cachedTextEncoder = (typeof TextEncoder !== 'undefined' ? new TextEncoder('utf-8') : { encode: () => { throw Error('TextEncoder not available') } } );

const encodeString = (typeof cachedTextEncoder.encodeInto === 'function'
    ? function (arg, view) {
    return cachedTextEncoder.encodeInto(arg, view);
}
    : function (arg, view) {
    const buf = cachedTextEncoder.encode(arg);
    view.set(buf);
    return {
        read: arg.length,
        written: buf.length
    };
});

function passStringToWasm0(arg, malloc, realloc) {

    if (realloc === undefined) {
        const buf = cachedTextEncoder.encode(arg);
        const ptr = malloc(buf.length, 1) >>> 0;
        getUint8ArrayMemory0().subarray(ptr, ptr + buf.length).set(buf);
        WASM_VECTOR_LEN = buf.length;
        return ptr;
    }

    let len = arg.length;
    let ptr = malloc(len, 1) >>> 0;

    const mem = getUint8ArrayMemory0();

    let offset = 0;

    for (; offset < len; offset++) {
        const code = arg.charCodeAt(offset);
        if (code > 0x7F) break;
        mem[ptr + offset] = code;
    }

    if (offset !== len) {
        if (offset !== 0) {
            arg = arg.slice(offset);
        }
        ptr = realloc(ptr, len, len = offset + arg.length * 3, 1) >>> 0;
        const view = getUint8ArrayMemory0().subarray(ptr + offset, ptr + len);
        const ret = encodeString(arg, view);

        offset += ret.written;
        ptr = realloc(ptr, len, offset, 1) >>> 0;
    }

    WASM_VECTOR_LEN = offset;
    return ptr;
}

function takeFromExternrefTable0(idx) {
    const value = wasm.__wbindgen_export_0.get(idx);
    wasm.__externref_table_dealloc(idx);
    return value;
}
/**
 * `nsec1…` → 32-byte hex secret key. For importing an existing Nostr identity.
 * @param {string} nsec
 * @returns {string}
 */
export function nsec_to_hex(nsec) {
    let deferred3_0;
    let deferred3_1;
    try {
        const ptr0 = passStringToWasm0(nsec, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.nsec_to_hex(ptr0, len0);
        var ptr2 = ret[0];
        var len2 = ret[1];
        if (ret[3]) {
            ptr2 = 0; len2 = 0;
            throw takeFromExternrefTable0(ret[2]);
        }
        deferred3_0 = ptr2;
        deferred3_1 = len2;
        return getStringFromWasm0(ptr2, len2);
    } finally {
        wasm.__wbindgen_free(deferred3_0, deferred3_1, 1);
    }
}

/**
 * Sign with an imported Nostr key rather than a ZKas secret.
 * @param {string} privkey_hex
 * @param {number} kind
 * @param {string} tags_json
 * @param {string} content
 * @param {bigint} created_at
 * @param {number} difficulty
 * @param {bigint} max_ms
 * @returns {string}
 */
export function sign_chat_event_with_key(privkey_hex, kind, tags_json, content, created_at, difficulty, max_ms) {
    let deferred5_0;
    let deferred5_1;
    try {
        const ptr0 = passStringToWasm0(privkey_hex, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ptr1 = passStringToWasm0(tags_json, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len1 = WASM_VECTOR_LEN;
        const ptr2 = passStringToWasm0(content, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len2 = WASM_VECTOR_LEN;
        const ret = wasm.sign_chat_event_with_key(ptr0, len0, kind, ptr1, len1, ptr2, len2, created_at, difficulty, max_ms);
        var ptr4 = ret[0];
        var len4 = ret[1];
        if (ret[3]) {
            ptr4 = 0; len4 = 0;
            throw takeFromExternrefTable0(ret[2]);
        }
        deferred5_0 = ptr4;
        deferred5_1 = len4;
        return getStringFromWasm0(ptr4, len4);
    } finally {
        wasm.__wbindgen_free(deferred5_0, deferred5_1, 1);
    }
}

/**
 * The x-only public key, hex, for a raw secret key — so an imported identity can
 * show its own `npub` without re-deriving anything.
 * @param {string} privkey_hex
 * @returns {string}
 */
export function pubkey_for_key(privkey_hex) {
    let deferred3_0;
    let deferred3_1;
    try {
        const ptr0 = passStringToWasm0(privkey_hex, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.pubkey_for_key(ptr0, len0);
        var ptr2 = ret[0];
        var len2 = ret[1];
        if (ret[3]) {
            ptr2 = 0; len2 = 0;
            throw takeFromExternrefTable0(ret[2]);
        }
        deferred3_0 = ptr2;
        deferred3_1 = len2;
        return getStringFromWasm0(ptr2, len2);
    } finally {
        wasm.__wbindgen_free(deferred3_0, deferred3_1, 1);
    }
}

/**
 * `npub1…` → 32-byte hex public key.
 * @param {string} npub
 * @returns {string}
 */
export function npub_to_hex(npub) {
    let deferred3_0;
    let deferred3_1;
    try {
        const ptr0 = passStringToWasm0(npub, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.npub_to_hex(ptr0, len0);
        var ptr2 = ret[0];
        var len2 = ret[1];
        if (ret[3]) {
            ptr2 = 0; len2 = 0;
            throw takeFromExternrefTable0(ret[2]);
        }
        deferred3_0 = ptr2;
        deferred3_1 = len2;
        return getStringFromWasm0(ptr2, len2);
    } finally {
        wasm.__wbindgen_free(deferred3_0, deferred3_1, 1);
    }
}

/**
 * 32-byte hex public key → `npub1…`.
 * @param {string} pubkey_hex
 * @returns {string}
 */
export function hex_to_npub(pubkey_hex) {
    let deferred3_0;
    let deferred3_1;
    try {
        const ptr0 = passStringToWasm0(pubkey_hex, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.hex_to_npub(ptr0, len0);
        var ptr2 = ret[0];
        var len2 = ret[1];
        if (ret[3]) {
            ptr2 = 0; len2 = 0;
            throw takeFromExternrefTable0(ret[2]);
        }
        deferred3_0 = ptr2;
        deferred3_1 = len2;
        return getStringFromWasm0(ptr2, len2);
    } finally {
        wasm.__wbindgen_free(deferred3_0, deferred3_1, 1);
    }
}

/**
 * Verify an event's id and signature.
 * @param {string} json
 * @returns {boolean}
 */
export function verify_chat_event(json) {
    const ptr0 = passStringToWasm0(json, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
    const len0 = WASM_VECTOR_LEN;
    const ret = wasm.verify_chat_event(ptr0, len0);
    if (ret[2]) {
        throw takeFromExternrefTable0(ret[1]);
    }
    return ret[0] !== 0;
}

/**
 * Difficulty (leading zero bits) of an event id, for displaying or filtering.
 * @param {string} id_hex
 * @returns {number}
 */
export function event_difficulty(id_hex) {
    const ptr0 = passStringToWasm0(id_hex, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
    const len0 = WASM_VECTOR_LEN;
    const ret = wasm.event_difficulty(ptr0, len0);
    if (ret[2]) {
        throw takeFromExternrefTable0(ret[1]);
    }
    return ret[0] >>> 0;
}

/**
 * Sign and (optionally) mine an event. `tags_json` is a JSON array of arrays of
 * strings; it is parsed here and re-serialized canonically, never passed through.
 * @param {string} secret
 * @param {number} account
 * @param {number} kind
 * @param {string} tags_json
 * @param {string} content
 * @param {bigint} created_at
 * @param {number} difficulty
 * @param {bigint} max_ms
 * @returns {string}
 */
export function sign_chat_event(secret, account, kind, tags_json, content, created_at, difficulty, max_ms) {
    let deferred5_0;
    let deferred5_1;
    try {
        const ptr0 = passStringToWasm0(secret, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ptr1 = passStringToWasm0(tags_json, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len1 = WASM_VECTOR_LEN;
        const ptr2 = passStringToWasm0(content, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len2 = WASM_VECTOR_LEN;
        const ret = wasm.sign_chat_event(ptr0, len0, account, kind, ptr1, len1, ptr2, len2, created_at, difficulty, max_ms);
        var ptr4 = ret[0];
        var len4 = ret[1];
        if (ret[3]) {
            ptr4 = 0; len4 = 0;
            throw takeFromExternrefTable0(ret[2]);
        }
        deferred5_0 = ptr4;
        deferred5_1 = len4;
        return getStringFromWasm0(ptr4, len4);
    } finally {
        wasm.__wbindgen_free(deferred5_0, deferred5_1, 1);
    }
}

/**
 * Wrap a private message. All randomness is supplied by the caller — the TS
 * layer draws it from Web Crypto — so this stays deterministic and testable.
 * @param {string} sender_sk_hex
 * @param {string} recipient_pub_hex
 * @param {string} content
 * @param {string} reply_to
 * @param {bigint} rumor_created_at
 * @param {bigint} seal_created_at
 * @param {bigint} wrap_created_at
 * @param {string} seal_nonce_hex
 * @param {string} wrap_nonce_hex
 * @param {string} ephemeral_sk_hex
 * @returns {string}
 */
export function dm_wrap(sender_sk_hex, recipient_pub_hex, content, reply_to, rumor_created_at, seal_created_at, wrap_created_at, seal_nonce_hex, wrap_nonce_hex, ephemeral_sk_hex) {
    let deferred9_0;
    let deferred9_1;
    try {
        const ptr0 = passStringToWasm0(sender_sk_hex, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ptr1 = passStringToWasm0(recipient_pub_hex, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len1 = WASM_VECTOR_LEN;
        const ptr2 = passStringToWasm0(content, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len2 = WASM_VECTOR_LEN;
        const ptr3 = passStringToWasm0(reply_to, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len3 = WASM_VECTOR_LEN;
        const ptr4 = passStringToWasm0(seal_nonce_hex, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len4 = WASM_VECTOR_LEN;
        const ptr5 = passStringToWasm0(wrap_nonce_hex, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len5 = WASM_VECTOR_LEN;
        const ptr6 = passStringToWasm0(ephemeral_sk_hex, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len6 = WASM_VECTOR_LEN;
        const ret = wasm.dm_wrap(ptr0, len0, ptr1, len1, ptr2, len2, ptr3, len3, rumor_created_at, seal_created_at, wrap_created_at, ptr4, len4, ptr5, len5, ptr6, len6);
        var ptr8 = ret[0];
        var len8 = ret[1];
        if (ret[3]) {
            ptr8 = 0; len8 = 0;
            throw takeFromExternrefTable0(ret[2]);
        }
        deferred9_0 = ptr8;
        deferred9_1 = len8;
        return getStringFromWasm0(ptr8, len8);
    } finally {
        wasm.__wbindgen_free(deferred9_0, deferred9_1, 1);
    }
}

/**
 * The x-only public key for a secret key — needed to address a DM to someone
 * and to recognise our own.
 * @param {string} sec_hex
 * @returns {string}
 */
export function xonly_pubkey(sec_hex) {
    let deferred3_0;
    let deferred3_1;
    try {
        const ptr0 = passStringToWasm0(sec_hex, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.xonly_pubkey(ptr0, len0);
        var ptr2 = ret[0];
        var len2 = ret[1];
        if (ret[3]) {
            ptr2 = 0; len2 = 0;
            throw takeFromExternrefTable0(ret[2]);
        }
        deferred3_0 = ptr2;
        deferred3_1 = len2;
        return getStringFromWasm0(ptr2, len2);
    } finally {
        wasm.__wbindgen_free(deferred3_0, deferred3_1, 1);
    }
}

/**
 * Open a gift wrap addressed to us. Returns `{sender, content, created_at, reply_to, id}`.
 * @param {string} my_sk_hex
 * @param {string} gift_wrap_json
 * @returns {string}
 */
export function dm_unwrap(my_sk_hex, gift_wrap_json) {
    let deferred4_0;
    let deferred4_1;
    try {
        const ptr0 = passStringToWasm0(my_sk_hex, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ptr1 = passStringToWasm0(gift_wrap_json, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len1 = WASM_VECTOR_LEN;
        const ret = wasm.dm_unwrap(ptr0, len0, ptr1, len1);
        var ptr3 = ret[0];
        var len3 = ret[1];
        if (ret[3]) {
            ptr3 = 0; len3 = 0;
            throw takeFromExternrefTable0(ret[2]);
        }
        deferred4_0 = ptr3;
        deferred4_1 = len3;
        return getStringFromWasm0(ptr3, len3);
    } finally {
        wasm.__wbindgen_free(deferred4_0, deferred4_1, 1);
    }
}

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
 * @param {string} secret
 * @param {number} account
 * @returns {ChatIdentity}
 */
export function chat_identity(secret, account) {
    const ptr0 = passStringToWasm0(secret, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
    const len0 = WASM_VECTOR_LEN;
    const ret = wasm.chat_identity(ptr0, len0, account);
    if (ret[2]) {
        throw takeFromExternrefTable0(ret[1]);
    }
    return ChatIdentity.__wrap(ret[0]);
}

const ChatIdentityFinalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_chatidentity_free(ptr >>> 0, 1));
/**
 * A derived chat identity. Mirrors what every Nostr client expects.
 */
export class ChatIdentity {

    static __wrap(ptr) {
        ptr = ptr >>> 0;
        const obj = Object.create(ChatIdentity.prototype);
        obj.__wbg_ptr = ptr;
        ChatIdentityFinalization.register(obj, obj.__wbg_ptr, obj);
        return obj;
    }

    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        ChatIdentityFinalization.unregister(this);
        return ptr;
    }

    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_chatidentity_free(ptr, 0);
    }
    /**
     * 32-byte x-only public key, hex — the Nostr `pubkey` field.
     * @returns {string}
     */
    get pubkey_hex() {
        let deferred1_0;
        let deferred1_1;
        try {
            const ret = wasm.chatidentity_pubkey_hex(this.__wbg_ptr);
            deferred1_0 = ret[0];
            deferred1_1 = ret[1];
            return getStringFromWasm0(ret[0], ret[1]);
        } finally {
            wasm.__wbindgen_free(deferred1_0, deferred1_1, 1);
        }
    }
    /**
     * 32-byte secret key, hex. **Treat exactly like a private key.**
     * @returns {string}
     */
    get privkey_hex() {
        let deferred1_0;
        let deferred1_1;
        try {
            const ret = wasm.chatidentity_privkey_hex(this.__wbg_ptr);
            deferred1_0 = ret[0];
            deferred1_1 = ret[1];
            return getStringFromWasm0(ret[0], ret[1]);
        } finally {
            wasm.__wbindgen_free(deferred1_0, deferred1_1, 1);
        }
    }
    /**
     * NIP-19 `npub1…`. Public; this is the handle others block or follow.
     * @returns {string}
     */
    get npub() {
        let deferred1_0;
        let deferred1_1;
        try {
            const ret = wasm.chatidentity_npub(this.__wbg_ptr);
            deferred1_0 = ret[0];
            deferred1_1 = ret[1];
            return getStringFromWasm0(ret[0], ret[1]);
        } finally {
            wasm.__wbindgen_free(deferred1_0, deferred1_1, 1);
        }
    }
    /**
     * NIP-19 `nsec1…`. Secret.
     * @returns {string}
     */
    get nsec() {
        let deferred1_0;
        let deferred1_1;
        try {
            const ret = wasm.chatidentity_nsec(this.__wbg_ptr);
            deferred1_0 = ret[0];
            deferred1_1 = ret[1];
            return getStringFromWasm0(ret[0], ret[1]);
        } finally {
            wasm.__wbindgen_free(deferred1_0, deferred1_1, 1);
        }
    }
    /**
     * True when this came from a recovery phrase and is therefore the *standard*
     * NIP-06 identity, portable to any Nostr client. False for a legacy raw-seed
     * wallet, whose identity is ZKas-specific (see [`LEGACY_DOMAIN`]).
     * @returns {boolean}
     */
    get is_nip06() {
        const ret = wasm.chatidentity_is_nip06(this.__wbg_ptr);
        return ret !== 0;
    }
}

async function __wbg_load(module, imports) {
    if (typeof Response === 'function' && module instanceof Response) {
        if (typeof WebAssembly.instantiateStreaming === 'function') {
            try {
                return await WebAssembly.instantiateStreaming(module, imports);

            } catch (e) {
                if (module.headers.get('Content-Type') != 'application/wasm') {
                    console.warn("`WebAssembly.instantiateStreaming` failed because your server does not serve Wasm with `application/wasm` MIME type. Falling back to `WebAssembly.instantiate` which is slower. Original error:\n", e);

                } else {
                    throw e;
                }
            }
        }

        const bytes = await module.arrayBuffer();
        return await WebAssembly.instantiate(bytes, imports);

    } else {
        const instance = await WebAssembly.instantiate(module, imports);

        if (instance instanceof WebAssembly.Instance) {
            return { instance, module };

        } else {
            return instance;
        }
    }
}

function __wbg_get_imports() {
    const imports = {};
    imports.wbg = {};
    imports.wbg.__wbg_now_807e54c39636c349 = function() {
        const ret = Date.now();
        return ret;
    };
    imports.wbg.__wbindgen_init_externref_table = function() {
        const table = wasm.__wbindgen_export_0;
        const offset = table.grow(4);
        table.set(0, undefined);
        table.set(offset + 0, undefined);
        table.set(offset + 1, null);
        table.set(offset + 2, true);
        table.set(offset + 3, false);
        ;
    };
    imports.wbg.__wbindgen_string_new = function(arg0, arg1) {
        const ret = getStringFromWasm0(arg0, arg1);
        return ret;
    };
    imports.wbg.__wbindgen_throw = function(arg0, arg1) {
        throw new Error(getStringFromWasm0(arg0, arg1));
    };

    return imports;
}

function __wbg_init_memory(imports, memory) {

}

function __wbg_finalize_init(instance, module) {
    wasm = instance.exports;
    __wbg_init.__wbindgen_wasm_module = module;
    cachedUint8ArrayMemory0 = null;


    wasm.__wbindgen_start();
    return wasm;
}

function initSync(module) {
    if (wasm !== undefined) return wasm;


    if (typeof module !== 'undefined') {
        if (Object.getPrototypeOf(module) === Object.prototype) {
            ({module} = module)
        } else {
            console.warn('using deprecated parameters for `initSync()`; pass a single object instead')
        }
    }

    const imports = __wbg_get_imports();

    __wbg_init_memory(imports);

    if (!(module instanceof WebAssembly.Module)) {
        module = new WebAssembly.Module(module);
    }

    const instance = new WebAssembly.Instance(module, imports);

    return __wbg_finalize_init(instance, module);
}

async function __wbg_init(module_or_path) {
    if (wasm !== undefined) return wasm;


    if (typeof module_or_path !== 'undefined') {
        if (Object.getPrototypeOf(module_or_path) === Object.prototype) {
            ({module_or_path} = module_or_path)
        } else {
            console.warn('using deprecated parameters for the initialization function; pass a single object instead')
        }
    }

    if (typeof module_or_path === 'undefined') {
        // PATCHED (not generated): we inline the module as base64 and pass it in
        // from ./index.ts, so no sibling .wasm is shipped. Keeping one purely to
        // satisfy this fallback would ship the engine twice.
        throw new Error('chat engine: init() requires explicit wasm bytes; use ensureEngine() from ./index.ts');
    }
    const imports = __wbg_get_imports();

    if (typeof module_or_path === 'string' || (typeof Request === 'function' && module_or_path instanceof Request) || (typeof URL === 'function' && module_or_path instanceof URL)) {
        module_or_path = fetch(module_or_path);
    }

    __wbg_init_memory(imports);

    const { instance, module } = await __wbg_load(await module_or_path, imports);

    return __wbg_finalize_init(instance, module);
}

export { initSync };
export default __wbg_init;
