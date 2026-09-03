package com.firecash.wallet

/**
 * Java-callable control of the embedded zkas-walletd engine (the UniFFI functions
 * return Kotlin `UShort`, which is awkward to call from Java — this exposes plain
 * `Int`). Used by [SyncWorker] so background sync works with the on-device engine:
 * the engine lives in the app process, so when the app is not running the worker
 * must start it, let it catch up, and stop it again.
 */
object EngineControl {
    /** Port of the running engine, or 0 if it is not running. */
    @JvmStatic
    fun port(): Int = try {
        uniffi.zkas_walletd_mobile.port().toInt()
    } catch (e: Throwable) {
        0
    }

    /** Start the engine (idempotent — returns the existing port if already running). 0 on failure. */
    @JvmStatic
    fun startEngine(node: String, walletDir: String, socks: String?): Int = try {
        uniffi.zkas_walletd_mobile.start(node, walletDir, null, socks).toInt()
    } catch (e: Throwable) {
        0
    }

    @JvmStatic
    fun stopEngine() {
        try {
            uniffi.zkas_walletd_mobile.stop()
        } catch (e: Throwable) {
        }
    }
}
