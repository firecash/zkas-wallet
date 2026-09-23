package com.firecash.wallet

import android.content.Context
import android.content.Intent
import android.content.SharedPreferences
import android.net.Uri
import android.os.Build
import android.os.PowerManager
import android.provider.Settings

/**
 * The Doze exemption that makes "run on this phone" background sync actually work.
 *
 * [BackgroundSyncPlugin] schedules a ~15-minute periodic WorkManager wake. That period is
 * a REQUEST, not a promise: once the phone enters Doze, Android defers periodic work to
 * the maintenance windows, which stretch from minutes to hours as the device stays still.
 * For a wallet running its own engine that is the difference between "open the app and it
 * is current" and "open the app and watch it catch up" — the exact 10-15s wait we are
 * trying to remove, moved to the phone.
 *
 * Asking for `REQUEST_IGNORE_BATTERY_OPTIMIZATIONS` is how an app gets out of that. It is
 * a system dialog the user can refuse, and refusal is not a failure: the sync still runs,
 * it just runs when Android feels like it. So this asks, remembers a refusal, and offers
 * a way never to be asked again.
 */
object BackgroundPermission {
    private const val DONT_ASK = "bg_dont_ask"

    private fun prefs(ctx: Context): SharedPreferences =
        ctx.getSharedPreferences(BackgroundSyncPlugin.PREFS, Context.MODE_PRIVATE)

    /** Whether Android will already let us run on our own schedule. */
    @JvmStatic
    fun isExempt(ctx: Context): Boolean {
        // Below M there is no Doze, so there is nothing to be exempt from.
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.M) return true
        val pm = ctx.getSystemService(Context.POWER_SERVICE) as? PowerManager ?: return true
        return try {
            pm.isIgnoringBatteryOptimizations(ctx.packageName)
        } catch (_: Throwable) {
            // A ROM that refuses to answer is not a reason to nag on every switch.
            true
        }
    }

    /** Whether the user has told us to stop asking. */
    @JvmStatic
    fun suppressed(ctx: Context): Boolean = prefs(ctx).getBoolean(DONT_ASK, false)

    @JvmStatic
    fun setSuppressed(ctx: Context, on: Boolean) {
        prefs(ctx).edit().putBoolean(DONT_ASK, on).apply()
    }

    /** Ask now, unless we already have it or were told not to. */
    @JvmStatic
    fun shouldAsk(ctx: Context): Boolean = !isExempt(ctx) && !suppressed(ctx)

    /**
     * Open the system dialog. Returns false if this device has no such screen — some
     * OEM builds omit it — so the caller can say so rather than claiming it asked.
     *
     * The direct `ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS` intent shows a one-tap
     * "Allow?" dialog; it needs the matching manifest permission. If it cannot be
     * resolved we fall back to the settings LIST, which always exists but leaves the
     * user to find the app themselves.
     */
    @JvmStatic
    fun request(ctx: Context): Boolean {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.M) return false
        val direct = Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS)
            .setData(Uri.parse("package:" + ctx.packageName))
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        if (direct.resolveActivity(ctx.packageManager) != null) {
            return try {
                ctx.startActivity(direct)
                true
            } catch (_: Throwable) {
                false
            }
        }
        val list = Intent(Settings.ACTION_IGNORE_BATTERY_OPTIMIZATION_SETTINGS)
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        return try {
            ctx.startActivity(list)
            true
        } catch (_: Throwable) {
            false
        }
    }
}
