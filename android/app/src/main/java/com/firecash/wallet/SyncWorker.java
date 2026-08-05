package com.firecash.wallet;

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
import java.io.InputStream;
import java.io.InputStreamReader;
import java.math.BigInteger;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import org.json.JSONObject;

/**
 * One periodic wake of the wallet's background sync: a single GET /api/status.
 * That call TOUCHES the wallet on the daemon, so its chain scan catches up
 * (the daemon only actively syncs wallets a client has recently touched) —
 * which is what makes the next app open instant. The reply also tells us the
 * balance moved, in which case a local notification announces the incoming
 * payment. No key material is involved: the token is the same read credential
 * the app itself uses, and the daemon it talks to is watch-only.
 */
public class SyncWorker extends Worker {
    private static final String CHANNEL = "payments";

    public SyncWorker(@NonNull Context context, @NonNull WorkerParameters params) {
        super(context, params);
    }

    @NonNull
    @Override
    public Result doWork() {
        SharedPreferences p = getApplicationContext().getSharedPreferences(BackgroundSyncPlugin.PREFS, Context.MODE_PRIVATE);
        if (!p.getBoolean("enabled", false)) return Result.success();
        String base = p.getString("baseUrl", "");
        String token = p.getString("token", "");
        if (base.isEmpty() || token.isEmpty()) return Result.success();

        JSONObject status;
        try {
            HttpURLConnection c = (HttpURLConnection) new URL(base + "/api/status").openConnection();
            c.setRequestProperty("X-Wallet-Token", token);
            c.setConnectTimeout(10_000);
            c.setReadTimeout(10_000);
            int code = c.getResponseCode();
            InputStream in = code >= 400 ? c.getErrorStream() : c.getInputStream();
            StringBuilder sb = new StringBuilder();
            try (BufferedReader r = new BufferedReader(new InputStreamReader(in, StandardCharsets.UTF_8))) {
                for (String line; (line = r.readLine()) != null; ) sb.append(line);
            }
            c.disconnect();
            if (code != 200) return Result.success(); // wallet gone / daemon down briefly — next tick retries
            status = new JSONObject(sb.toString());
        } catch (Exception e) {
            return Result.retry(); // transient network failure: WorkManager backs off
        }

        if (!status.optBoolean("has_wallet", false)) return Result.success();
        // Balance + incoming-not-yet-settled: both are "money that is the user's",
        // and pending_in is how a just-broadcast payment is seen ~1s after it lands.
        BigInteger total = new BigInteger(status.optString("balance_sompi", "0"))
            .add(new BigInteger(status.optString("pending_in_sompi", "0")));

        String last = p.getString("lastTotalSompi", null);
        p.edit().putString("lastTotalSompi", total.toString()).apply();
        // First run only records the baseline — announcing the whole balance as
        // "received" is exactly the lie the in-app announcement avoids too.
        if (last != null && total.compareTo(new BigInteger(last)) > 0) {
            BigInteger delta = total.subtract(new BigInteger(last));
            notifyPayment(formatZkas(delta));
        }
        return Result.success();
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
