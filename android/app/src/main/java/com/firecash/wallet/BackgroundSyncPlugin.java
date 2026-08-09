package com.firecash.wallet;

import android.content.Context;
import android.content.SharedPreferences;
import android.content.pm.PackageManager;
import android.os.Build;
import androidx.work.Constraints;
import androidx.work.ExistingPeriodicWorkPolicy;
import androidx.work.NetworkType;
import androidx.work.PeriodicWorkRequest;
import androidx.work.WorkManager;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.util.concurrent.TimeUnit;

/**
 * The wallet's opt-in Android background sync. All it schedules is a periodic
 * WorkManager wake (~15 min, network required) that calls the daemon's
 * /api/status — see SyncWorker. Scheduling, configuration and the on/off flag
 * live here; the actual work is in the worker so it survives the app being
 * swiped away or the phone rebooting.
 */
@CapacitorPlugin(name = "BackgroundSync")
public class BackgroundSyncPlugin extends Plugin {
    static final String PREFS = "zkas_bg_sync";
    private static final String WORK_NAME = "zkas-bg-sync";

    private SharedPreferences prefs() {
        return getContext().getSharedPreferences(PREFS, Context.MODE_PRIVATE);
    }

    @PluginMethod
    public void configure(PluginCall call) {
        String base = call.getString("baseUrl", "").replaceAll("/+$", "");
        String token = call.getString("token", "");
        String bearer = call.getString("bearer", "").trim();
        prefs().edit()
            .putString("baseUrl", base)
            .putString("token", token)
            .putString("bearer", bearer)
            .apply();
        call.resolve();
    }

    @PluginMethod
    public void enable(PluginCall call) {
        maybeAskNotifications();
        PeriodicWorkRequest req = new PeriodicWorkRequest.Builder(SyncWorker.class, 15, TimeUnit.MINUTES)
            .setConstraints(new Constraints.Builder().setRequiredNetworkType(NetworkType.CONNECTED).build())
            .build();
        WorkManager.getInstance(getContext()).enqueueUniquePeriodicWork(WORK_NAME, ExistingPeriodicWorkPolicy.UPDATE, req);
        prefs().edit().putBoolean("enabled", true).apply();
        call.resolve();
    }

    @PluginMethod
    public void disable(PluginCall call) {
        WorkManager.getInstance(getContext()).cancelUniqueWork(WORK_NAME);
        prefs().edit().putBoolean("enabled", false).apply();
        call.resolve();
    }

    @PluginMethod
    public void isEnabled(PluginCall call) {
        JSObject ret = new JSObject();
        ret.put("enabled", prefs().getBoolean("enabled", false));
        call.resolve(ret);
    }

    // Android 13+ gates notifications behind a runtime permission. Worst case a
    // denial means the sync still runs but stays silent — so we ask and move on.
    private void maybeAskNotifications() {
        if (Build.VERSION.SDK_INT >= 33 && getActivity() != null
            && getActivity().checkSelfPermission("android.permission.POST_NOTIFICATIONS") != PackageManager.PERMISSION_GRANTED) {
            getActivity().requestPermissions(new String[] { "android.permission.POST_NOTIFICATIONS" }, 0);
        }
    }
}
