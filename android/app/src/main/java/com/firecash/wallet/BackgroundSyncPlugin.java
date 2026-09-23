package com.firecash.wallet;

import android.content.Context;
import android.content.SharedPreferences;
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
        boolean embedded = Boolean.TRUE.equals(call.getBoolean("embedded", false));
        String node = call.getString("node", "");
        String socks = call.getString("socks", "");
        // Until when the worker must not announce a balance increase as a payment.
        //
        // The worker compares balances against its own stored baseline and cannot read
        // the app's record of sends, so it cannot tell an incoming payment from the
        // CHANGE returning out of one of yours. The app knows, and hands it a deadline.
        // 0 clears any hold.
        long quiet = call.getLong("quietUntil", 0L);
        prefs().edit()
            .putString("baseUrl", base)
            .putString("token", token)
            .putString("bearer", bearer)
            .putBoolean("embedded", embedded)
            .putString("node", node)
            .putString("socks", socks)
            .putLong("quietUntil", quiet)
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

    /**
     * What Android will currently allow this app in the background.
     *
     * `exempt` is the only one that decides whether a ~15 minute wake really happens
     * every ~15 minutes; without it WorkManager's period is a hint that Doze stretches
     * to hours. `shouldAsk` folds in the user's "don't ask again" so the web layer does
     * not have to keep that rule in two places.
     */
    @PluginMethod
    public void backgroundStatus(PluginCall call) {
        JSObject ret = new JSObject();
        ret.put("exempt", BackgroundPermission.isExempt(getContext()));
        ret.put("suppressed", BackgroundPermission.suppressed(getContext()));
        ret.put("shouldAsk", BackgroundPermission.shouldAsk(getContext()));
        ret.put("enabled", prefs().getBoolean("enabled", false));
        call.resolve(ret);
    }

    /**
     * Open the system battery-optimisation dialog. `shown:false` means this device has
     * no such screen, so the caller should say that rather than claim it asked.
     */
    @PluginMethod
    public void requestBackground(PluginCall call) {
        JSObject ret = new JSObject();
        ret.put("shown", BackgroundPermission.request(getContext()));
        call.resolve(ret);
    }

    /** Remember "don't ask me again" — or clear it, if the user changes their mind. */
    @PluginMethod
    public void suppressBackgroundPrompt(PluginCall call) {
        BackgroundPermission.setSuppressed(getContext(), !Boolean.FALSE.equals(call.getBoolean("on", true)));
        call.resolve();
    }

    // Android 13+ gates notifications behind a runtime permission. Worst case a
    // denial means the sync still runs but stays silent — so we ask and move on.
    private void maybeAskNotifications() {
        NotificationPermission.maybeAsk(getActivity());
    }
}
