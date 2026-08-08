package com.firecash.wallet;

import android.content.Intent;
import android.net.Uri;
import android.os.Bundle;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
  @Override
  public void onCreate(Bundle savedInstanceState) {
    setIntent(normalizePaymentShare(getIntent()));
    // The opt-in background sync (Settings → Background sync): a WorkManager
    // periodic wake that keeps the daemon-side scan warm and announces incoming
    // payments while the app is closed.
    registerPlugin(BackgroundSyncPlugin.class);
    super.onCreate(savedInstanceState);
  }

  @Override
  protected void onNewIntent(Intent intent) {
    Intent normalized = normalizePaymentShare(intent);
    super.onNewIntent(normalized);
    setIntent(normalized);
  }

  /** Turn Android's generic "share text" action into the same deep link the
   * Capacitor App plugin already delivers for QR/payment URI opens. */
  private Intent normalizePaymentShare(Intent intent) {
    if (Intent.ACTION_SEND.equals(intent.getAction()) && "text/plain".equals(intent.getType())) {
      String text = intent.getStringExtra(Intent.EXTRA_TEXT);
      if (text != null) text = text.trim();
      if (text != null && (text.startsWith("zkas:") || text.startsWith("firecash:"))) {
        intent.setAction(Intent.ACTION_VIEW);
        intent.setData(Uri.parse(text));
      }
    }
    return intent;
  }
}
