package com.firecash.wallet

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.IBinder
import androidx.core.app.NotificationCompat

/**
 * Keeps the on-device wallet engine alive while it is syncing.
 *
 * The engine runs as plain threads inside this app's process. Without a foreground
 * service Android freezes or kills that process shortly after the screen goes dark, so
 * a long first sync in "Run on this phone" mode could never finish unless the user kept
 * the screen on. A `dataSync` foreground service holds the process (and shows the
 * required ongoing notification) for exactly as long as a sync is in progress; the
 * app drops it as soon as the wallet reports synced, so a synced wallet idles like any
 * other app and costs no battery.
 */
class EngineForegroundService : Service() {
    override fun onBind(intent: Intent?): IBinder? = null

    /**
     * Android 15 (API 35) budgets a `dataSync` foreground service at roughly six hours a
     * day and calls this when that runs out. It is not advisory: a service that does not
     * stop itself here is killed, and repeated offences get the app's ability to start
     * these services revoked entirely.
     *
     * Required the moment this app targets 35, which Google Play now requires — so
     * shipping to the Play Store without it would turn a long sync into a system kill.
     *
     * Stopping is the easy half. The engine is holding a scan in memory that is only
     * written to disk periodically, so tearing the process down without asking it to
     * flush discards everything since the last checkpoint — the same loss that made a
     * sync look like it restarted. `stopEngine` goes through the graceful path, which
     * drains and then flushes, so the next open resumes where this left off.
     */
    override fun onTimeout(startId: Int, fgsType: Int) {
        android.util.Log.w("ZKas", "sync foreground service hit its daily budget; flushing and standing down")
        EngineControl.stopEngine(applicationContext)
        running = false
        stopSelf(startId)
    }

    /** Pre-35 signature; the framework calls whichever it has. */
    @Deprecated("Superseded by onTimeout(startId, fgsType) on API 35+")
    override fun onTimeout(startId: Int) {
        onTimeout(startId, ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC)
    }

    override fun onDestroy() {
        // Clear the armed flag however this service ended — including a system kill.
        // Without this, `start()`'s idempotence check would believe a dead service is
        // still holding the process and never arm a replacement.
        running = false
        super.onDestroy()
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        val text = intent?.getStringExtra(EXTRA_TEXT) ?: DEFAULT_TEXT
        ensureChannel()
        val notification = build(text)
        // `startForeground` CAN THROW, and an uncaught throw in a Service kills the app.
        //
        // `start()` below guards `startForegroundService`, but that is a different call
        // at a different time: the system accepts it and then runs this method later. By
        // then the process may no longer be eligible to hold a foreground service — on
        // Android 12+ a background start raises ForegroundServiceStartNotAllowedException,
        // and on 14 the dataSync type is additionally budgeted (~6 h/day) and refuses once
        // spent. The app re-armed this from its status poll every 30 s while hidden, so a
        // wallet still syncing when the user switched apps had a refusal arriving on the
        // main thread with nothing to catch it.
        //
        // Reported as: the app crashes when opened during the daily sync, once per wallet,
        // and the sync appears to start over afterwards — the crash skips
        // `flush_checkpoints_on_exit`, so the scan progress since the last periodic save
        // goes with it.
        //
        // A refusal is not an error worth dying for: the engine keeps syncing for as long
        // as the app is open, exactly as it does on a device that never granted the
        // permission. Stand down and let the next arm (or the WorkManager path) try again.
        try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                startForeground(NOTIFICATION_ID, notification, ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC)
            } else {
                startForeground(NOTIFICATION_ID, notification)
            }
            running = true
        } catch (_: Throwable) {
            running = false
            stopSelf()
            return START_NOT_STICKY
        }
        // Not sticky: if the OS still kills us, the app re-arms this on its next status poll.
        return START_NOT_STICKY
    }

    private fun ensureChannel() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
        val nm = getSystemService(NotificationManager::class.java)
        if (nm.getNotificationChannel(CHANNEL) != null) return
        val ch = NotificationChannel(CHANNEL, "Wallet sync", NotificationManager.IMPORTANCE_LOW)
        ch.description = "Shown while the wallet is syncing on this phone"
        ch.setShowBadge(false)
        nm.createNotificationChannel(ch)
    }

    private fun build(text: String): Notification {
        val open = PendingIntent.getActivity(
            this, 0, Intent(this, MainActivity::class.java),
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )
        return NotificationCompat.Builder(this, CHANNEL)
            .setSmallIcon(R.drawable.ic_stat_zkas)
            .setContentTitle("ZKas Wallet")
            .setContentText(text)
            .setOngoing(true)
            .setSilent(true)
            .setPriority(NotificationCompat.PRIORITY_LOW)
            .setContentIntent(open)
            .build()
    }

    companion object {
        const val CHANNEL = "engine_sync"
        const val NOTIFICATION_ID = 4201
        const val EXTRA_TEXT = "text"
        const val DEFAULT_TEXT = "Syncing your wallet on this phone…"

        /** True while this service holds a foreground notification. */
        @Volatile
        private var running = false

        /**
         * Arm the service, unless it is already armed.
         *
         * The idempotence matters: the app arms this from its status poll, which runs
         * every second in the foreground and every 30 s hidden, and each arm was a fresh
         * `startForegroundService` + `onStartCommand` + `startForeground` for a service
         * that was already running.
         */
        fun start(ctx: Context, text: String = DEFAULT_TEXT) {
            if (running) return
            val i = Intent(ctx, EngineForegroundService::class.java).putExtra(EXTRA_TEXT, text)
            try {
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) ctx.startForegroundService(i) else ctx.startService(i)
            } catch (_: Throwable) {
                // Background-start restrictions or a missing permission: the sync still runs
                // while the app is open; we just cannot promise it survives the screen going off.
                running = false
            }
        }

        /** True while this app is holding the process open to finish a sync. */
        @JvmStatic
        fun isRunning(): Boolean = running

        fun stop(ctx: Context) {
            running = false
            try { ctx.stopService(Intent(ctx, EngineForegroundService::class.java)) } catch (_: Throwable) {}
        }
    }
}
