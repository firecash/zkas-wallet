// Network-privacy endpoints the wallet can offer as one-tap choices.
//
// ONION_WALLETD_URL is the official ZKas wallet daemon reached over Tor: a hidden
// service (run on the ops box) that forwards to `zkas-walletd`. Connecting to it
// means the wallet service never learns the client's IP, and Tor encrypts the
// path — with no Tor client bundled in the app. It only actually routes when the
// device has a Tor transport up (Orbot's VPN on Android, or Tor on desktop);
// otherwise the connection attempt fails and the UI points the user at Orbot.
// Baked so "Connect over Tor" is genuinely one tap, and overridable at build time.
export const ONION_WALLETD_URL: string =
  (import.meta.env.VITE_ONION_WALLETD_URL as string | undefined)?.trim() ||
  "http://plqu6zzg5u6lkofv76m3pnnxzbaus6pgs4thced4wejdroi7z7exd6qd.onion";

// A private relay (a plain forward/reverse proxy in front of walletd) is a second,
// optional seam. Unset by default, so its option only appears once configured.
export const PRIVATE_RELAY_URL: string =
  (import.meta.env.VITE_PRIVATE_RELAY_URL as string | undefined)?.trim() || "";

// Where to send a user who taps "Connect over Tor" without a Tor transport up.
export const ORBOT_PLAY_URL = "https://play.google.com/store/apps/details?id=org.torproject.android";
