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

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        val text = intent?.getStringExtra(EXTRA_TEXT) ?: DEFAULT_TEXT
        ensureChannel()
        val notification = build(text)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            startForeground(NOTIFICATION_ID, notification, ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC)
        } else {
            startForeground(NOTIFICATION_ID, notification)
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

        fun start(ctx: Context, text: String = DEFAULT_TEXT) {
            val i = Intent(ctx, EngineForegroundService::class.java).putExtra(EXTRA_TEXT, text)
            try {
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) ctx.startForegroundService(i) else ctx.startService(i)
            } catch (_: Throwable) {
                // Background-start restrictions or a missing permission: the sync still runs
                // while the app is open; we just cannot promise it survives the screen going off.
            }
        }

        fun stop(ctx: Context) {
            try { ctx.stopService(Intent(ctx, EngineForegroundService::class.java)) } catch (_: Throwable) {}
        }
    }
}
