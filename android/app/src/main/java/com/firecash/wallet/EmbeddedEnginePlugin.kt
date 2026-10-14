package com.firecash.wallet

import com.getcapacitor.JSObject
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.annotation.CapacitorPlugin
import android.app.ActivityManager
import android.app.ApplicationExitInfo
import android.os.Build
import java.io.File

/**
 * Runs the ZKas wallet engine (zkas-walletd) NATIVELY, in this app's process, bound to a
 * loopback port — the desktop model on a phone. The WebView then talks to
 * http://127.0.0.1:<port>. The seed and full viewing key never leave the device: the
 * engine pulls compact block records from a public node's gRPC and trial-decrypts locally.
 *
 * The engine itself is the `zkas-walletd-mobile` Rust crate compiled to a JNI .so
 * (jniLibs/<abi>/libzkas_walletd_mobile.so) with UniFFI Kotlin bindings.
 */
@CapacitorPlugin(name = "EmbeddedEngine")
class EmbeddedEnginePlugin : Plugin() {

    private fun walletDir(): String {
        val dir = File(context.filesDir, "wallets")
        dir.mkdirs()
        return dir.absolutePath
    }

    /** Start the engine against `nodeAddr` (host:port gRPC); returns the loopback `port`. */
    @PluginMethod
    fun start(call: PluginCall) {
        val node = call.getString("nodeAddr") ?: DEFAULT_NODE
        val secret = call.getString("secret")
        val socks = call.getString("socks")
        // The sync notification below is invisible on Android 13+ until this is granted.
        NotificationPermission.maybeAsk(activity)
        // Before the engine sizes anything: it cannot see this app's memory ceiling, and
        // the device-wide figure it would otherwise use is far larger than what this
        // process is allowed to hold.
        EngineControl.reportMemoryBudget(context)
        Thread {
            val port = try {
                uniffi.zkas_walletd_mobile.start(node, walletDir(), secret, socks).toInt()
            } catch (e: Throwable) {
                0
            }
            if (port == 0) {
                call.reject("The on-device wallet engine could not start.")
            } else {
                // A freshly started engine is about to sync: hold the process until the app
                // says the wallet is synced (see keepAlive).
                EngineForegroundService.start(context)
                call.resolve(JSObject().put("port", port))
            }
        }.start()
    }

    @PluginMethod
    fun stop(call: PluginCall) {
        EngineForegroundService.stop(context)
        Thread {
            try { uniffi.zkas_walletd_mobile.stop() } catch (_: Throwable) {}
            call.resolve()
        }.start()
    }

    /** Hold (or release) the foreground service that keeps the engine alive in the
     * background. The app calls this from its status poll: on while the wallet is
     * still syncing, off once it is synced — so a synced wallet costs no battery. */
    @PluginMethod
    fun keepAlive(call: PluginCall) {
        val on = call.getBoolean("on", true) ?: true
        if (on) EngineForegroundService.start(context) else EngineForegroundService.stop(context)
        call.resolve()
    }

    @PluginMethod
    fun status(call: PluginCall) {
        val port = try { uniffi.zkas_walletd_mobile.port().toInt() } catch (_: Throwable) { 0 }
        call.resolve(JSObject().put("port", port).put("running", port != 0))
    }

    @PluginMethod
    fun logs(call: PluginCall) {
        val text = try { uniffi.zkas_walletd_mobile.logs() } catch (e: Throwable) { "" }
        call.resolve(JSObject().put("text", text))
    }

    /**
     * Why this app's process died last time, as the system recorded it.
     *
     * Crash reports for the on-device engine arrived with nothing to act on: "the app
     * closes during the sync" and no way to tell a native abort from an out-of-memory
     * kill from an ANR. Those have completely different fixes, and guessing between them
     * cost a release. The engine runs as native threads in this process, so a native
     * failure leaves no Java stack trace and no log — the process is simply gone.
     *
     * Android has kept the answer since 11: the system records each exit with a reason,
     * a description and the process's RSS at the time. Reading it costs nothing, needs no
     * permission, and turns "it crashed" into one of REASON_LOW_MEMORY (trim harder / cap
     * residency), REASON_CRASH_NATIVE (a panic or abort in the engine), REASON_ANR (the
     * main thread blocked), REASON_SIGNALED (killed, e.g. SIGSEGV) or REASON_USER_REQUESTED
     * (the user swiped it away, and nothing is wrong at all).
     */
    @PluginMethod
    fun lastExit(call: PluginCall) {
        val out = JSObject()
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.R) {
            // Pre-11 has no record to read; say so rather than implying a clean exit.
            call.resolve(out.put("available", false))
            return
        }
        try {
            val am = context.getSystemService(ActivityManager::class.java)
            // Only this app's own process records, newest first.
            val infos = am.getHistoricalProcessExitReasons(context.packageName, 0, 8)
            if (infos.isEmpty()) {
                call.resolve(out.put("available", true).put("count", 0))
                return
            }
            val list = com.getcapacitor.JSArray()
            for (i in infos) {
                val o = JSObject()
                o.put("reason", i.reason)
                o.put("reasonName", reasonName(i.reason))
                o.put("status", i.status)
                o.put("importance", i.importance)
                // RSS at death is what separates "we were killed for memory" from the rest.
                o.put("rssKb", i.pss)
                o.put("timestamp", i.timestamp)
                o.put("description", i.description ?: "")
                list.put(o)
            }
            call.resolve(out.put("available", true).put("count", infos.size).put("exits", list))
        } catch (e: Throwable) {
            call.resolve(out.put("available", false).put("error", e.toString()))
        }
    }

    private fun reasonName(reason: Int): String = when (reason) {
        ApplicationExitInfo.REASON_ANR -> "ANR"
        ApplicationExitInfo.REASON_CRASH -> "CRASH_JAVA"
        ApplicationExitInfo.REASON_CRASH_NATIVE -> "CRASH_NATIVE"
        ApplicationExitInfo.REASON_DEPENDENCY_DIED -> "DEPENDENCY_DIED"
        ApplicationExitInfo.REASON_EXCESSIVE_RESOURCE_USAGE -> "EXCESSIVE_RESOURCE_USAGE"
        ApplicationExitInfo.REASON_EXIT_SELF -> "EXIT_SELF"
        ApplicationExitInfo.REASON_INITIALIZATION_FAILURE -> "INITIALIZATION_FAILURE"
        ApplicationExitInfo.REASON_LOW_MEMORY -> "LOW_MEMORY"
        ApplicationExitInfo.REASON_OTHER -> "OTHER"
        ApplicationExitInfo.REASON_PERMISSION_CHANGE -> "PERMISSION_CHANGE"
        ApplicationExitInfo.REASON_SIGNALED -> "SIGNALED"
        ApplicationExitInfo.REASON_USER_REQUESTED -> "USER_REQUESTED"
        ApplicationExitInfo.REASON_USER_STOPPED -> "USER_STOPPED"
        else -> "UNKNOWN($reason)"
    }

    @PluginMethod
    fun setDebugLogs(call: PluginCall) {
        val on = call.getBoolean("on", false) ?: false
        try { uniffi.zkas_walletd_mobile.setDebugLogs(on) } catch (_: Throwable) {}
        call.resolve()
    }

    companion object {
        // The public node's gRPC — same default the desktop shell uses.
        const val DEFAULT_NODE = "seed.zkas.info:16110"
    }
}
