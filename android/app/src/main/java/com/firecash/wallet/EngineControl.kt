package com.firecash.wallet

import android.content.Context

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

    /**
     * Drop everything the engine can rebuild, and return how many decoded leaves went.
     *
     * Called from [MainActivity.onTrimMemory]. Android warns before it starts killing, and
     * an engine that ignores the warning is the one that gets killed - which loses the
     * user's scan progress and makes the next open pay a full cold restore.
     *
     * What it frees is the decoded leaf cache: ~32 bytes per leaf, so tens to hundreds of
     * MB on a synced wallet, and pure cache - it is rebuilt lazily the next time a spend
     * needs a witness. Nothing persisted is touched. Non-blocking on the Rust side, so it
     * is safe to call on the main thread from a system callback.
     */
    @JvmStatic
    fun releaseMemory(): Long = try {
        uniffi.zkas_walletd_mobile.releaseMemory().toLong()
    } catch (e: Throwable) {
        0L
    }

    /**
     * Stop the engine, and the notification that says it is running.
     *
     * The `ctx` overload exists because stopping only the engine left
     * EngineForegroundService up: a permanent "Syncing your wallet on this
     * phone…" over a dead engine, which is both a lie and a process Android is
     * being asked to keep alive for nothing. EmbeddedEnginePlugin.stop() took
     * both down; SyncWorker's path called this one and took only the engine.
     */
    @JvmStatic
    @JvmOverloads
    fun stopEngine(ctx: Context? = null) {
        try {
            uniffi.zkas_walletd_mobile.stop()
        } catch (e: Throwable) {
        }
        if (ctx != null) EngineForegroundService.stop(ctx)
    }
}
