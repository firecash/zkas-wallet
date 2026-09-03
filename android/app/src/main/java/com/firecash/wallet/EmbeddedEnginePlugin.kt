package com.firecash.wallet

import com.getcapacitor.JSObject
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.annotation.CapacitorPlugin
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
        Thread {
            val port = try {
                uniffi.zkas_walletd_mobile.start(node, walletDir(), secret, socks).toInt()
            } catch (e: Throwable) {
                0
            }
            if (port == 0) {
                call.reject("The on-device wallet engine could not start.")
            } else {
                call.resolve(JSObject().put("port", port))
            }
        }.start()
    }

    @PluginMethod
    fun stop(call: PluginCall) {
        Thread {
            try { uniffi.zkas_walletd_mobile.stop() } catch (_: Throwable) {}
            call.resolve()
        }.start()
    }

    @PluginMethod
    fun status(call: PluginCall) {
        val port = try { uniffi.zkas_walletd_mobile.port().toInt() } catch (_: Throwable) { 0 }
        call.resolve(JSObject().put("port", port).put("running", port != 0))
    }

    companion object {
        // The public node's gRPC — same default the desktop shell uses.
        const val DEFAULT_NODE = "185.147.157.125:16110"
    }
}
