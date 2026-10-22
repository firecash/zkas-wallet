package com.firecash.wallet

import android.app.Activity
import android.app.ActivityManager
import android.app.Application
import android.app.ApplicationExitInfo
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.net.ConnectivityManager
import android.net.NetworkCapabilities
import android.os.BatteryManager
import android.os.Build
import android.os.Bundle
import android.os.Debug
import android.os.Handler
import android.os.HandlerThread
import android.os.PowerManager
import android.os.SystemClock
import android.view.FrameMetrics
import android.view.Window

/**
 * What only the native side can see, for the diagnostic log:
 *
 *   - how the process started (cold, or an activity recreated in a living process) and how
 *     long the native side took before the WebView ran any JavaScript
 *   - how the previous processes ENDED (ApplicationExitInfo: crash, native crash, ANR, low
 *     memory kill, user swipe), each reported once, with the ANR trace's first lines
 *   - activity lifecycle, so background/foreground is on the record even when the WebView
 *     is paused and cannot say so itself
 *   - jank (FrameMetrics, aggregated per 10 s window: frames, slow > 16.7 ms, frozen
 *     > 700 ms, worst) — framework API, no extra dependency
 *   - once a minute: PSS, Java and native heap, battery level/charging/temperature, power
 *     saver, thermal status, network transport
 *   - uncaught Java/Kotlin exceptions, written before the default handler kills the process
 */
object DiagCollectors {
    private var installed = false
    @Volatile var startKind: String = "cold"
        private set
    private var firstActivitySeen = false
    private var bgThread: HandlerThread? = null
    private var bg: Handler? = null
    private var startedActivities = 0
    private var backgroundAt = 0L

    @JvmStatic
    @Synchronized
    fun install(app: Application) {
        if (installed) return
        installed = true
        DiagStore.init(app)
        bgThread = HandlerThread("diag-collect").also { it.start() }
        bg = Handler(bgThread!!.looper)

        val prev = Thread.getDefaultUncaughtExceptionHandler()
        Thread.setDefaultUncaughtExceptionHandler { t, e ->
            try {
                DiagStore.emitSync("err", "java_crash", "error", mapOf(
                    "thread" to t.name,
                    "err" to e.javaClass.name,
                    "msg" to DiagRedact.scrub(e.message ?: "", 500),
                    "stack" to DiagRedact.scrub(android.util.Log.getStackTraceString(e), 6_000),
                ))
            } catch (_: Throwable) {
            }
            prev?.uncaughtException(t, e)
        }

        DiagStore.emit("app", "process_start", "info", mapOf(
            "since_process_start_ms" to (SystemClock.elapsedRealtime() - DiagStore.processStart),
            "importance" to processImportance(app),
        ))

        app.registerActivityLifecycleCallbacks(object : Application.ActivityLifecycleCallbacks {
            override fun onActivityCreated(a: Activity, s: Bundle?) {
                if (!firstActivitySeen) {
                    firstActivitySeen = true
                    startKind = "cold"
                } else {
                    startKind = "warm"
                }
                DiagStore.emit("app", "activity_created", "info", mapOf(
                    "kind" to startKind,
                    "restored_state" to (s != null),
                    "since_process_start_ms" to (SystemClock.elapsedRealtime() - DiagStore.processStart),
                ))
                attachFrameMetrics(a)
            }
            override fun onActivityStarted(a: Activity) {
                if (startedActivities++ == 0 && backgroundAt > 0) {
                    DiagStore.emit("app", "native_foreground", "info", mapOf("away_ms" to (SystemClock.elapsedRealtime() - backgroundAt)))
                }
            }
            override fun onActivityResumed(a: Activity) = DiagStore.emit("app", "activity_resumed", verbose = true)
            override fun onActivityPaused(a: Activity) = DiagStore.emit("app", "activity_paused", verbose = true)
            override fun onActivityStopped(a: Activity) {
                if (--startedActivities <= 0) {
                    startedActivities = 0
                    backgroundAt = SystemClock.elapsedRealtime()
                    DiagStore.emit("app", "native_background")
                }
            }
            override fun onActivitySaveInstanceState(a: Activity, s: Bundle) {}
            override fun onActivityDestroyed(a: Activity) = DiagStore.emit("app", "activity_destroyed", "info", mapOf("finishing" to a.isFinishing))
        })

        bg?.post { reportExits(app) }
        bg?.postDelayed(object : Runnable {
            override fun run() {
                try { sample(app) } catch (_: Throwable) {}
                bg?.postDelayed(this, 60_000)
            }
        }, 20_000)
    }

    private fun processImportance(ctx: Context): Int? = try {
        val info = ActivityManager.RunningAppProcessInfo()
        ActivityManager.getMyMemoryState(info)
        info.importance
    } catch (_: Throwable) {
        null
    }

    /** Every exit Android recorded since the last launch looked, reported once each. */
    private fun reportExits(ctx: Context) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.R) return
        try {
            val prefs = ctx.getSharedPreferences("zkas_diag", Context.MODE_PRIVATE)
            val seen = prefs.getLong("last_exit_ts", 0L)
            val am = ctx.getSystemService(ActivityManager::class.java)
            val infos = am.getHistoricalProcessExitReasons(ctx.packageName, 0, 16)
            var newest = seen
            for (i in infos.sortedBy { it.timestamp }) {
                if (i.timestamp <= seen) continue
                newest = maxOf(newest, i.timestamp)
                val fields = mutableMapOf<String, Any?>(
                    "reason" to reasonName(i.reason),
                    "status" to i.status,
                    "importance" to i.importance,
                    "pss_mb" to i.pss / 1024,
                    "rss_mb" to i.rss / 1024,
                    "at" to i.timestamp,
                    "ago_s" to (System.currentTimeMillis() - i.timestamp) / 1000,
                    "description" to DiagRedact.scrub(i.description ?: "", 300),
                )
                if (i.reason == ApplicationExitInfo.REASON_ANR) {
                    try {
                        i.traceInputStream?.bufferedReader()?.use { r ->
                            fields["trace_head"] = DiagRedact.scrub(r.lineSequence().take(60).joinToString("\n"), 6_000)
                        }
                    } catch (_: Throwable) {
                    }
                }
                val bad = i.reason in setOf(ApplicationExitInfo.REASON_ANR, ApplicationExitInfo.REASON_CRASH, ApplicationExitInfo.REASON_CRASH_NATIVE, ApplicationExitInfo.REASON_LOW_MEMORY, ApplicationExitInfo.REASON_SIGNALED, ApplicationExitInfo.REASON_EXCESSIVE_RESOURCE_USAGE)
                DiagStore.emit("app", "exit_info", if (bad) "warn" else "info", fields)
            }
            if (newest > seen) prefs.edit().putLong("last_exit_ts", newest).apply()
        } catch (_: Throwable) {
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

    // ---- jank ---------------------------------------------------------------------

    private class FrameWindow {
        var frames = 0
        var slow = 0
        var frozen = 0
        var worstMs = 0.0
        var startedAt = SystemClock.elapsedRealtime()
    }

    private fun attachFrameMetrics(a: Activity) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.N) return
        val handler = bg ?: return
        val w = FrameWindow()
        try {
            a.window.addOnFrameMetricsAvailableListener(Window.OnFrameMetricsAvailableListener { _, m, _ ->
                val ms = m.getMetric(FrameMetrics.TOTAL_DURATION) / 1_000_000.0
                w.frames++
                if (ms > 16.7) w.slow++
                if (ms > 700) w.frozen++
                if (ms > w.worstMs) w.worstMs = ms
                val now = SystemClock.elapsedRealtime()
                if (now - w.startedAt >= 10_000) {
                    if (w.slow > 0 || DiagStore.level == DiagStore.VERBOSE) {
                        DiagStore.emit("perf", "jank", if (w.frozen > 0) "warn" else "info", mapOf(
                            "frames" to w.frames,
                            "slow" to w.slow,
                            "frozen" to w.frozen,
                            "slow_pct" to Math.round(w.slow * 1000.0 / maxOf(1, w.frames)) / 10.0,
                            "worst_ms" to Math.round(w.worstMs),
                            "window_s" to (now - w.startedAt) / 1000,
                        ))
                    }
                    w.frames = 0; w.slow = 0; w.frozen = 0; w.worstMs = 0.0; w.startedAt = now
                }
            }, handler)
        } catch (_: Throwable) {
        }
    }

    // ---- periodic sample ------------------------------------------------------------

    private fun sample(ctx: Context) {
        if (DiagStore.level == DiagStore.OFF) return
        val mi = Debug.MemoryInfo()
        Debug.getMemoryInfo(mi)
        val rt = Runtime.getRuntime()
        DiagStore.emit("perf", "memory", "info", mapOf(
            "pss_mb" to mi.totalPss / 1024,
            "java_heap_mb" to (rt.totalMemory() - rt.freeMemory()) / 1_048_576,
            "java_heap_max_mb" to rt.maxMemory() / 1_048_576,
            "native_heap_mb" to Debug.getNativeHeapAllocatedSize() / 1_048_576,
            "engine_port" to EngineControl.port().takeIf { it > 0 }?.let { "up" },
        ))
        val battery = ctx.registerReceiver(null, IntentFilter(Intent.ACTION_BATTERY_CHANGED))
        val pm = ctx.getSystemService(Context.POWER_SERVICE) as PowerManager
        val fields = mutableMapOf<String, Any?>()
        if (battery != null) {
            val level = battery.getIntExtra(BatteryManager.EXTRA_LEVEL, -1)
            val scale = battery.getIntExtra(BatteryManager.EXTRA_SCALE, 100)
            val status = battery.getIntExtra(BatteryManager.EXTRA_STATUS, -1)
            fields["battery_pct"] = if (level >= 0 && scale > 0) level * 100 / scale else null
            fields["charging"] = status == BatteryManager.BATTERY_STATUS_CHARGING || status == BatteryManager.BATTERY_STATUS_FULL
            fields["battery_temp_c"] = battery.getIntExtra(BatteryManager.EXTRA_TEMPERATURE, Int.MIN_VALUE).takeIf { it != Int.MIN_VALUE }?.let { it / 10.0 }
        }
        fields["power_save"] = pm.isPowerSaveMode
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) fields["thermal"] = pm.currentThermalStatus
        fields["net"] = networkType(ctx)
        DiagStore.emit("perf", "device", "info", fields)
    }

    fun networkType(ctx: Context): String = try {
        val cm = ctx.getSystemService(Context.CONNECTIVITY_SERVICE) as ConnectivityManager
        val caps = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) cm.getNetworkCapabilities(cm.activeNetwork) else null
        when {
            caps == null -> "none"
            caps.hasTransport(NetworkCapabilities.TRANSPORT_VPN) -> "vpn"
            caps.hasTransport(NetworkCapabilities.TRANSPORT_WIFI) -> "wifi"
            caps.hasTransport(NetworkCapabilities.TRANSPORT_CELLULAR) -> "cellular"
            caps.hasTransport(NetworkCapabilities.TRANSPORT_ETHERNET) -> "ethernet"
            else -> "other"
        }
    } catch (_: Throwable) {
        "unknown"
    }
}
