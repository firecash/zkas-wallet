package com.firecash.wallet;

import static android.content.ComponentCallbacks2.TRIM_MEMORY_BACKGROUND;
import static android.content.ComponentCallbacks2.TRIM_MEMORY_COMPLETE;
import static android.content.ComponentCallbacks2.TRIM_MEMORY_MODERATE;
import static android.content.ComponentCallbacks2.TRIM_MEMORY_RUNNING_CRITICAL;
import static android.content.ComponentCallbacks2.TRIM_MEMORY_RUNNING_LOW;
import static android.content.ComponentCallbacks2.TRIM_MEMORY_RUNNING_MODERATE;
import static android.content.ComponentCallbacks2.TRIM_MEMORY_UI_HIDDEN;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import org.junit.Test;

/**
 * The trim levels are NOT ordered by severity: UI_HIDDEN (20) sits above
 * RUNNING_CRITICAL (15), so a `level >= TRIM_MEMORY_RUNNING_LOW` test treats "the user
 * switched apps" as a memory emergency. That is what shipped, and it threw away the
 * engine's decoded-leaf cache on every tab-out — so the witness/subtree warm in flight
 * restarted each time, which users saw as a sync that goes back to the beginning
 * whenever they leave the app and never finishes.
 */
public class TrimMemoryPolicyTest {

  @Test
  public void tabbingOutDoesNotCostTheCache() {
    // The regression, pinned: UI_HIDDEN is routine and must never drop anything.
    assertFalse(MainActivity.shouldReleaseCache(TRIM_MEMORY_UI_HIDDEN, false));
    assertFalse(MainActivity.shouldReleaseCache(TRIM_MEMORY_UI_HIDDEN, true));
  }

  @Test
  public void realPressureWhileRunningDropsTheCache() {
    assertTrue(MainActivity.shouldReleaseCache(TRIM_MEMORY_RUNNING_LOW, false));
    assertTrue(MainActivity.shouldReleaseCache(TRIM_MEMORY_RUNNING_CRITICAL, false));
    // Holding the sync service does not exempt us from pressure we are causing.
    assertTrue(MainActivity.shouldReleaseCache(TRIM_MEMORY_RUNNING_LOW, true));
  }

  @Test
  public void routinePressureIsNotWorthARedecode() {
    assertFalse(MainActivity.shouldReleaseCache(TRIM_MEMORY_RUNNING_MODERATE, false));
  }

  @Test
  public void backgroundReclaimYieldsUnlessWeAreSyncing() {
    // Nothing in flight: help the system keep other apps alive.
    assertTrue(MainActivity.shouldReleaseCache(TRIM_MEMORY_BACKGROUND, false));
    // Mid-sync under the foreground service: gutting the cache defeats the service.
    // BACKGROUND arrives moments after any tab-out on a loaded phone, so it is the one
    // level a sync in flight is exempt from.
    assertFalse(MainActivity.shouldReleaseCache(TRIM_MEMORY_BACKGROUND, true));
  }

  @Test
  public void aSyncInFlightDoesNotOutrankBeingNextToDie() {
    // Past BACKGROUND the system is well into reclaiming and we are next. Holding the
    // cache to protect the warm risks the kill, which costs the warm AND the scan
    // progress since the last checkpoint — so the exemption stops here.
    assertTrue(MainActivity.shouldReleaseCache(TRIM_MEMORY_MODERATE, true));
    assertTrue(MainActivity.shouldReleaseCache(TRIM_MEMORY_MODERATE, false));
  }

  @Test
  public void aboutToBeKilledAlwaysDrops() {
    // A kill loses the scan progress since the last checkpoint; a re-decode does not.
    assertTrue(MainActivity.shouldReleaseCache(TRIM_MEMORY_COMPLETE, true));
    assertTrue(MainActivity.shouldReleaseCache(TRIM_MEMORY_COMPLETE, false));
  }
}
