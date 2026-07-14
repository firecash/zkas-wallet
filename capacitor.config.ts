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
    // The daemon is HTTPS; no cleartext needed. Keep it locked down.
    allowMixedContent: false,
    // Pinned, not defaulted: the WebView's origin IS the origin the daemon must
    // allow through CORS. Android serves the bundle from https://localhost, iOS
    // from capacitor://localhost — both are in walletd's --allow-origin list.
    androidScheme: "https",
  },
  ios: {
    contentInset: "always",
    scheme: "capacitor",
  },
};

export default config;
