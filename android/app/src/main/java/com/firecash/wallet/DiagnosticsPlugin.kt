package com.firecash.wallet

import android.app.ActivityManager
import android.content.Context
import android.content.Intent
import android.os.Build
import android.os.SystemClock
import android.webkit.WebView
import androidx.core.content.FileProvider
import com.getcapacitor.JSObject
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.annotation.CapacitorPlugin

/**
 * The WebView's door to the on-device diagnostic log (see DiagStore). `append` takes the
 * SPA's already-redacted batches; `export` hands ONE file to the system share sheet, and
 * only when the user pressed Export. Nothing here uses the network.
 */
@CapacitorPlugin(name = "Diagnostics")
class DiagnosticsPlugin : Plugin() {

    override fun load() {
        DiagCollectors.install(activity.application)
        // Native events reach the live tail on the Diagnostics screen.
        DiagStore.listener = { line -> notifyListeners("line", JSObject().put("line", line)) }
    }

    @PluginMethod
    fun config(call: PluginCall) {
        val ctx = context
        val am = ctx.getSystemService(Context.ACTIVITY_SERVICE) as ActivityManager
        val env = JSObject()
        env.put("os", "android")
        env.put("os_version", Build.VERSION.RELEASE)
        env.put("sdk", Build.VERSION.SDK_INT)
        env.put("manufacturer", Build.MANUFACTURER)
        env.put("model", Build.MODEL)
        env.put("abi", Build.SUPPORTED_ABIS.firstOrNull() ?: "")
        env.put("memory_class_mb", am.memoryClass)
        env.put("large_memory_class_mb", am.largeMemoryClass)
        env.put("low_ram", am.isLowRamDevice)
        env.put("net_native", DiagCollectors.networkType(ctx))
        try {
            val pi = ctx.packageManager.getPackageInfo(ctx.packageName, 0)
            env.put("app_version_name", pi.versionName)
            @Suppress("DEPRECATION")
            env.put("app_version_code", if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) pi.longVersionCode else pi.versionCode.toLong())
        } catch (_: Throwable) {
        }
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            try {
                val wv = WebView.getCurrentWebViewPackage()
                env.put("webview", "${wv?.packageName ?: "?"} ${wv?.versionName ?: "?"}")
            } catch (_: Throwable) {
            }
        }
        val out = JSObject()
        out.put("salt", DiagStore.salt())
        out.put("level", DiagStore.levelName())
        out.put("procUptimeMs", SystemClock.elapsedRealtime() - DiagStore.processStart)
        out.put("startKind", DiagCollectors.startKind)
        out.put("env", env)
        out.put("dir", "files/diag")
        call.resolve(out)
    }

    @PluginMethod
    fun append(call: PluginCall) {
        val arr = call.getArray("lines")
        val lines = ArrayList<String>()
        if (arr != null) for (i in 0 until arr.length()) arr.optString(i)?.let { lines.add(it) }
        DiagStore.append(lines)
        call.resolve()
    }

    @PluginMethod
    fun setLevel(call: PluginCall) {
        DiagStore.setLevel(context, call.getString("level") ?: "normal")
        call.resolve()
    }

    @PluginMethod
    fun stats(call: PluginCall) {
        val (files, bytes) = DiagStore.stats()
        call.resolve(JSObject().put("files", files).put("bytes", bytes))
    }

    @PluginMethod
    fun clear(call: PluginCall) {
        DiagStore.clear()
        call.resolve()
    }

    @PluginMethod
    fun export(call: PluginCall) {
        val header = call.getString("header") ?: "{}"
        Thread {
            try {
                val file = DiagStore.buildExport(context, header)
                val uri = FileProvider.getUriForFile(context, "${context.packageName}.fileprovider", file)
                val send = Intent(Intent.ACTION_SEND).apply {
                    type = "text/plain"
                    putExtra(Intent.EXTRA_STREAM, uri)
                    putExtra(Intent.EXTRA_SUBJECT, file.name)
                    addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
                }
                val chooser = Intent.createChooser(send, file.name).addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
                activity.runOnUiThread {
                    try {
                        activity.startActivity(chooser)
                        DiagStore.emit("diag", "exported", "info", mapOf("bytes" to file.length()))
                        call.resolve(JSObject().put("outcome", "shared"))
                    } catch (e: Throwable) {
                        call.reject("Could not open the share sheet: ${e.javaClass.simpleName}")
                    }
                }
            } catch (e: Throwable) {
                call.reject("Could not build the export: ${e.javaClass.simpleName}")
            }
        }.start()
    }
}
