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
    // The on-device wallet engine (Settings → Wallet service → Run on this phone).
    registerPlugin(EmbeddedEnginePlugin.class);
    super.onCreate(savedInstanceState);
  }

  /**
   * Android is running short of memory and is deciding what to kill.
   *
   * The on-device engine is by far the largest thing in this process: a synced wallet
   * holds its leaf stream plus a decoded copy of it, which is tens to hundreds of MB. If
   * we sit on that, we are the obvious candidate — and being killed costs the user their
   * scan progress and makes the next open pay a full cold restore.
   *
   * So give back the part that is pure cache. It is rebuilt lazily the next time a spend
   * needs a witness; nothing persisted is lost. Only from TRIM_MEMORY_RUNNING_LOW upward —
   * the lighter levels fire routinely when the app is simply backgrounded, and dropping
   * the cache on every tab-out would just make the next send slow for no reason.
   */
  @Override
  public void onTrimMemory(int level) {
    super.onTrimMemory(level);
    if (level >= TRIM_MEMORY_RUNNING_LOW) {
      EngineControl.releaseMemory();
    }
  }

  @Override
  public void onLowMemory() {
    super.onLowMemory();
    EngineControl.releaseMemory();
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
