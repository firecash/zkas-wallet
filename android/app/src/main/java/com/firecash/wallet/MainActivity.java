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
   * needs a witness; nothing persisted is lost.
   *
   * WHICH levels is the whole fix here. These constants are not ordered by severity, so
   * `level >= TRIM_MEMORY_RUNNING_LOW` did the opposite of what the rule above intended:
   *
   *   RUNNING_MODERATE  5   real pressure, app in use
   *   RUNNING_LOW      10   real pressure
   *   RUNNING_CRITICAL 15   real pressure
   *   UI_HIDDEN        20   the user tabbed out. NOT a memory signal at all
   *   BACKGROUND       40   in the background LRU, system reclaiming
   *   MODERATE         60   further down that list
   *   COMPLETE         80   next to be killed
   *
   * UI_HIDDEN is 20, so it passed the test, and the cache was thrown away every single
   * time the user left the app — the one case the comment set out to avoid. On a phone
   * the next pass then re-decodes everything it had already decoded, which is why a sync
   * "starts again from the beginning when I go to another app" and why it never seems to
   * finish. Android documents UI_HIDDEN as a cue to release UI resources, not caches.
   *
   * So: real pressure while running, always. Merely hidden, never. In the background LRU,
   * only when we are NOT holding the sync foreground service — that service is this app's
   * bid to stay alive and finish the sync, and gutting the cache underneath it defeats
   * the point. COMPLETE is the exception: that is the last warning before a kill, and a
   * kill costs more than a re-decode.
   */
  @Override
  public void onTrimMemory(int level) {
    super.onTrimMemory(level);
    if (shouldReleaseCache(level, EngineForegroundService.isRunning())) {
      EngineControl.releaseMemory();
    }
  }

  /**
   * Whether a trim at `level` should cost the engine its decoded-leaf cache.
   *
   * Static and pure so it can be unit-tested on the JVM: the bug this replaces was
   * nothing but a misreading of these constants' ordering, which compiles, lints and
   * runs perfectly while doing the opposite of what it says.
   */
  static boolean shouldReleaseCache(int level, boolean holdingSyncService) {
    // Not a memory signal — just "your UI is no longer visible".
    if (level == TRIM_MEMORY_UI_HIDDEN) return false;
    // Last warning before the process is killed; a kill costs more than a re-decode.
    if (level >= TRIM_MEMORY_COMPLETE) return true;
    // Genuine pressure while the app is running and in use.
    if (level == TRIM_MEMORY_RUNNING_LOW || level == TRIM_MEMORY_RUNNING_CRITICAL) return true;
    // MODERATE means the system is well into reclaiming, and the next step is us. Keeping
    // the cache here is the trade that loses: being killed costs the scan progress since
    // the last checkpoint AND the warm, while dropping the cache costs only the warm. So
    // a sync in flight does not buy an exemption this far down.
    if (level >= TRIM_MEMORY_MODERATE) return true;
    // BACKGROUND is the routine "you are in the LRU" signal, which arrives moments after
    // any tab-out on a loaded phone. Yield it — unless the foreground service is this
    // app's open bid to stay alive and finish a sync, in which case gutting the cache
    // underneath it defeats the point of holding the process at all.
    if (level >= TRIM_MEMORY_BACKGROUND) return !holdingSyncService;
    // RUNNING_MODERATE and anything lower: too routine to pay a re-decode for.
    return false;
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
