import type { CapacitorConfig } from "@capacitor/cli";

// FireCash mobile wallet — Capacitor wrapper around the same static SPA that
// serves wallet.firecash.info. The web bundle in `dist/` is loaded locally on
// the device; it talks to a `firecash-walletd` over HTTPS (see src/api.ts —
// on native it defaults to the hosted daemon's absolute URL, since a native
// bundle has no same-origin `/daemon` to proxy to).
const config: CapacitorConfig = {
  appId: "com.firecash.wallet",
  appName: "FireCash Wallet",
  webDir: "dist",
  backgroundColor: "#0b0b0f",
  android: {
    // The daemon is HTTPS; no cleartext needed. Keep it locked down.
    allowMixedContent: false,
  },
  ios: {
    contentInset: "always",
  },
};

export default config;
