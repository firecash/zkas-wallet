package com.firecash.wallet;

import android.app.PendingIntent;
import android.appwidget.AppWidgetManager;
import android.appwidget.AppWidgetProvider;
import android.content.ComponentName;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.widget.RemoteViews;
import java.math.BigInteger;

/** An opt-in home-screen balance glance. It reads only the last value already
 * stored by BackgroundSync; it never opens the wallet daemon or holds a key. */
public class WalletWidget extends AppWidgetProvider {
    @Override
    public void onUpdate(Context context, AppWidgetManager manager, int[] ids) {
        for (int id : ids) update(context, manager, id);
    }

    static void refreshAll(Context context) {
        AppWidgetManager manager = AppWidgetManager.getInstance(context);
        ComponentName component = new ComponentName(context, WalletWidget.class);
        int[] ids = manager.getAppWidgetIds(component);
        for (int id : ids) update(context, manager, id);
    }

    private static void update(Context context, AppWidgetManager manager, int id) {
        SharedPreferences prefs = context.getSharedPreferences(BackgroundSyncPlugin.PREFS, Context.MODE_PRIVATE);
        String sompi = prefs.getString("lastTotalSompi", null);
        RemoteViews views = new RemoteViews(context.getPackageName(), R.layout.wallet_widget);
        String balance = "Open to sync";
        try {
            if (sompi != null) balance = format(new BigInteger(sompi)) + " ZKAS";
        } catch (NumberFormatException ignored) {
            // A corrupt preference must never crash the launcher/widget host.
        }
        views.setTextViewText(R.id.widget_balance, balance);
        views.setTextViewText(R.id.widget_state, prefs.getBoolean("enabled", false) ? "Background sync on" : "Tap to open wallet");
        Intent open = new Intent(context, MainActivity.class);
        PendingIntent pending = PendingIntent.getActivity(context, 11, open, PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
        views.setOnClickPendingIntent(R.id.widget_root, pending);
        manager.updateAppWidget(id, views);
    }

    private static String format(BigInteger sompi) {
        String value = sompi.max(BigInteger.ZERO).toString();
        while (value.length() < 9) value = "0" + value;
        String whole = value.substring(0, value.length() - 8);
        String fraction = value.substring(value.length() - 8).replaceAll("0+$", "");
        return fraction.isEmpty() ? whole : whole + "." + fraction;
    }
}
