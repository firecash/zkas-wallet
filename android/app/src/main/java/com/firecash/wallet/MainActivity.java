package com.firecash.wallet;

import android.os.Bundle;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
  @Override
  public void onCreate(Bundle savedInstanceState) {
    // The opt-in background sync (Settings → Background sync): a WorkManager
    // periodic wake that keeps the daemon-side scan warm and announces incoming
    // payments while the app is closed.
    registerPlugin(BackgroundSyncPlugin.class);
    super.onCreate(savedInstanceState);
  }
}
