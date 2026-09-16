package com.firecash.wallet

import android.app.Activity
import android.content.pm.PackageManager
import android.os.Build

/**
 * Android 13+ gates notifications behind a runtime permission. Without it the
 * "Syncing your wallet on this phone…" foreground-service notification and the
 * background-sync payment alerts are silently hidden from the drawer. Worst case a
 * denial means the sync still runs but stays silent — so we ask once and move on.
 * Shared by [EmbeddedEnginePlugin] (on-device engine) and [BackgroundSyncPlugin].
 */
object NotificationPermission {
    private const val PERMISSION = "android.permission.POST_NOTIFICATIONS"

    @JvmStatic
    fun maybeAsk(activity: Activity?) {
        if (Build.VERSION.SDK_INT < 33 || activity == null) return
        if (activity.checkSelfPermission(PERMISSION) == PackageManager.PERMISSION_GRANTED) return
        // Plugin methods run off the main thread; the permission dialog is UI.
        activity.runOnUiThread {
            try { activity.requestPermissions(arrayOf(PERMISSION), 0) } catch (_: Throwable) {}
        }
    }
}
