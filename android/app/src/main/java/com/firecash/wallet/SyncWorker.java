package com.firecash.wallet;

import android.app.ActivityManager;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.os.Build;
import androidx.annotation.NonNull;
import androidx.core.app.NotificationCompat;
import androidx.core.app.NotificationManagerCompat;
import androidx.work.Worker;
import androidx.work.WorkerParameters;
import java.io.BufferedReader;
import java.io.File;
import java.io.InputStream;
import java.io.InputStreamReader;
import java.math.BigInteger;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.List;
import org.json.JSONObject;

/**
 * One periodic wake of the wallet's background sync: a GET /api/status. That call
 * TOUCHES the wallet on the daemon, so its chain scan catches up (the daemon only
 * actively syncs wallets a client has recently touched) — which is what makes the
 * next app open instant. The reply also tells us the balance moved, in which case a
 * local notification announces the incoming payment. No spend key is involved: the
 * token is the same read credential the app uses, and the daemon is watch-only.
 *
 * ON-DEVICE ENGINE: when the wallet runs on this phone, the daemon lives IN THE APP
 * PROCESS, so when the app is not running there is nothing on the loopback port. This
 * worker then STARTS the engine itself (idempotent — it reuses the app's instance if
 * the app is alive), waits for it to catch up, and stops it again if it started it.
 */
public class SyncWorker extends Worker {
    private static final String CHANNEL = "payments";
    // The on-device engine resumes from its persisted checkpoint and then syncs. Give it
    // a bounded window to reach the tip before we compare balances; a WorkManager wake has
    // ~10 min, and a wallet that syncs every ~15 min only has a little ground to make up.
    private static final int EMBEDDED_MAX_POLLS = 30;
    private static final long EMBEDDED_POLL_MS = 5_000L;

    public SyncWorker(@NonNull Context context, @NonNull WorkerParameters params) {
        super(context, params);
    }

    @NonNull
    @Override
    public Result doWork() {
        SharedPreferences p = getApplicationContext().getSharedPreferences(BackgroundSyncPlugin.PREFS, Context.MODE_PRIVATE);
        if (!p.getBoolean("enabled", false)) return Result.success();
        String token = p.getString("token", "");
        String bearer = p.getString("bearer", "");
        boolean embedded = p.getBoolean("embedded", false);
        if (token.isEmpty()) return Result.success();

        String base;
        boolean startedHere = false;
        if (embedded) {
            int port = EngineControl.port();
            if (port == 0) {
                String node = p.getString("node", "185.147.157.125:16110");
                String dir = new File(getApplicationContext().getFilesDir(), "wallets").getAbsolutePath();
                port = EngineControl.startEngine(node, dir);
                startedHere = true;
            }
            if (port == 0) return Result.retry(); // engine could not start; back off and retry
            base = "http://127.0.0.1:" + port;
        } else {
            base = p.getString("baseUrl", "");
            if (base.isEmpty()) return Result.success();
        }

        try {
            // Remote daemon: one call is enough (it runs server-side, already synced).
            // Embedded: the first call loads the wallet, then poll while its scan catches up.
            int tries = embedded ? EMBEDDED_MAX_POLLS : 1;
            JSONObject status = null;
            for (int i = 0; i < tries; i++) {
                if (isStopped()) return Result.success(); // WorkManager gave up; stop cleanly (finally still runs)
                status = fetchStatus(base, token, bearer);
                if (status == null) {
                    // Transient (engine still binding, or a network blip). For embedded, keep
                    // waiting within budget; for remote, let WorkManager back off.
                    if (embedded && i + 1 < tries && !isStopped()) { sleep(EMBEDDED_POLL_MS); continue; }
                    return Result.retry();
                }
                if (!status.optBoolean("has_wallet", false)) return Result.success();
                boolean synced = status.optBoolean("synced", false) && !status.optBoolean("loading", false);
                if (synced || !embedded) break;
                if (i + 1 < tries) sleep(EMBEDDED_POLL_MS);
            }
            if (status == null) return Result.retry();
            processStatus(p, status);
            return Result.success();
        } finally {
            // Only stop the engine if THIS worker started it AND the app is not now in the
            // foreground. `startedHere` alone is not enough: the app can open mid-run and
            // reuse this very engine (ensureEmbedded reuses a running instance), and stopping
            // it then would leave the foreground WebView talking to a dead loopback port.
            if (startedHere && !appInForeground()) EngineControl.stopEngine();
        }
    }

    /** GET base + /api/status → parsed JSON, or null on any transport/HTTP failure. */
    private JSONObject fetchStatus(String base, String token, String bearer) {
        try {
            HttpURLConnection c = (HttpURLConnection) new URL(base + "/api/status").openConnection();
            c.setRequestProperty("X-Wallet-Token", token);
            if (!bearer.isEmpty()) c.setRequestProperty("Authorization", "Bearer " + bearer);
            c.setConnectTimeout(10_000);
            c.setReadTimeout(10_000);
            int code = c.getResponseCode();
            InputStream in = code >= 400 ? c.getErrorStream() : c.getInputStream();
            StringBuilder sb = new StringBuilder();
            try (BufferedReader r = new BufferedReader(new InputStreamReader(in, StandardCharsets.UTF_8))) {
                for (String line; (line = r.readLine()) != null; ) sb.append(line);
            }
            c.disconnect();
            if (code != 200) return null;
            return new JSONObject(sb.toString());
        } catch (Exception e) {
            return null;
        }
    }

    /** Compare the reported balance against the stored baseline and notify on a real rise. */
    private void processStatus(SharedPreferences p, JSONObject status) {
        // Only a FULLY SCANNED wallet reports a balance worth comparing. A wallet still
        // opening or catching up answers with what it has found SO FAR — commonly 0 — and
        // that is not a balance, it is an absence of one. Without this gate the worker stored
        // 0 as the baseline while the wallet was opening, and when the scan finished announced
        // the delta as an incoming payment for the user's own whole balance.
        if (!status.optBoolean("synced", false) || status.optBoolean("loading", false)) return;
        BigInteger total;
        try {
            total = new BigInteger(status.optString("balance_sompi", "0"))
                .add(new BigInteger(status.optString("pending_in_sompi", "0")));
        } catch (NumberFormatException e) {
            return; // malformed data is not a payment; a later valid status repairs the baseline
        }

        String last = p.getString("lastTotalSompi", null);
        p.edit().putString("lastTotalSompi", total.toString()).apply();
        // A rise the app can explain by its OWN settling payment is not a payment to you.
        long quietUntil = p.getLong("quietUntil", 0L);
        boolean quiet = quietUntil > 0 && System.currentTimeMillis() < quietUntil;
        WalletWidget.refreshAll(getApplicationContext());
        // First run only records the baseline — announcing the whole balance as "received"
        // is exactly the lie the in-app announcement avoids too.
        if (last != null) {
            try {
                BigInteger previous = new BigInteger(last);
                if (!quiet && total.compareTo(previous) > 0) notifyPayment(formatZkas(total.subtract(previous)));
            } catch (NumberFormatException ignored) {
            }
        }
    }

    private static void sleep(long ms) {
        try { Thread.sleep(ms); } catch (InterruptedException ignored) { Thread.currentThread().interrupt(); }
    }

    /** True when this app has a process in the foreground (a user has it open). Used to
     * avoid stopping an engine the foreground app has adopted. getRunningAppProcesses
     * returns this app's own process, whose importance is readable even on modern Android. */
    private boolean appInForeground() {
        try {
            ActivityManager am = (ActivityManager) getApplicationContext().getSystemService(Context.ACTIVITY_SERVICE);
            if (am == null) return false;
            List<ActivityManager.RunningAppProcessInfo> procs = am.getRunningAppProcesses();
            if (procs == null) return false;
            String pkg = getApplicationContext().getPackageName();
            for (ActivityManager.RunningAppProcessInfo pi : procs) {
                if (pi.importance == ActivityManager.RunningAppProcessInfo.IMPORTANCE_FOREGROUND
                        && pi.processName != null && pi.processName.startsWith(pkg)) {
                    return true;
                }
            }
            return false;
        } catch (Exception e) {
            // If we cannot tell, err on the side of NOT stopping — a leaked engine is
            // reclaimed when the process dies; a stopped-out-from-under foreground app is worse.
            return true;
        }
    }

    /** Sompi → a human "12.345" ZKAS string (8 decimals, trailing zeros trimmed). */
    private static String formatZkas(BigInteger sompi) {
        String s = sompi.toString();
        while (s.length() < 9) s = "0" + s;
        String whole = s.substring(0, s.length() - 8);
        String frac = s.substring(s.length() - 8).replaceAll("0+$", "");
        return frac.isEmpty() ? whole : whole + "." + frac;
    }

    private void notifyPayment(String amountZkas) {
        Context ctx = getApplicationContext();
        if (Build.VERSION.SDK_INT >= 26) {
            NotificationChannel ch = new NotificationChannel(CHANNEL, "Payments", NotificationManager.IMPORTANCE_DEFAULT);
            ch.setDescription("Incoming ZKas payments seen by background sync");
            ctx.getSystemService(NotificationManager.class).createNotificationChannel(ch);
        }
        Intent open = new Intent(ctx, MainActivity.class);
        PendingIntent tap = PendingIntent.getActivity(ctx, 0, open, PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
        NotificationCompat.Builder b = new NotificationCompat.Builder(ctx, CHANNEL)
            .setSmallIcon(ctx.getApplicationInfo().icon)
            .setContentTitle("ZKas payment received")
            .setContentText(amountZkas + " ZKAS arrived in your wallet.")
            .setContentIntent(tap)
            .setAutoCancel(true);
        try {
            NotificationManagerCompat.from(ctx).notify((int) (System.currentTimeMillis() % 100_000), b.build());
        } catch (SecurityException ignored) {
            // POST_NOTIFICATIONS denied: the sync still ran, it just stays silent.
        }
    }
}
