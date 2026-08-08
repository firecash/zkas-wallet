import type { CapacitorConfig } from "@capacitor/cli";

// ZKas mobile wallet — Capacitor wrapper around the same static SPA that
// serves wallet.zkas.info. The web bundle in `dist/` is loaded locally on
// the device; it talks to a `zkas-walletd` over HTTPS (see src/api.ts —
// on native it defaults to the hosted daemon's absolute URL, since a native
// bundle has no same-origin `/daemon` to proxy to).
const config: CapacitorConfig = {
  appId: "com.firecash.wallet",
  appName: "ZKas Wallet",
  webDir: "dist",
  backgroundColor: "#0b0b0f",
  android: {
    // Installed apps may connect straight to a walletd on the user's LAN. That
    // service commonly has no public DNS name/certificate, so HTTPS is not a
    // realistic requirement there. The browser build still enforces HTTPS.
    allowMixedContent: true,
    // Pinned, not defaulted: the WebView's origin IS the origin the daemon must
    // allow through CORS. Android serves the bundle from https://localhost, iOS
    // from capacitor://localhost — both are in walletd's --allow-origin list.
    androidScheme: "https",
  },
  ios: {
    // The app owns its safe-area spacing through CSS env() values. Asking the
    // native scroll view to inset as well doubles the top/bottom gap on notched
    // iPhones and iPads in split view.
    contentInset: "never",
    scheme: "capacitor",
  },
};

export default config;
