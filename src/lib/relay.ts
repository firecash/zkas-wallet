// Private relay endpoint — the seam for the "built-in proxy" privacy option.
//
// A relay is just a wallet-service URL that forwards to `zkas-walletd` while
// hiding the client's IP from it: the wallet talks only to the relay, the relay
// talks to walletd, so walletd sees the relay's address, not the user's. Because
// that is, on the wire, indistinguishable from any other walletd base URL, the
// app needs nothing special to use one — only to know the URL and to present it
// as a first-class, clearly-labelled privacy choice.
//
// It is intentionally unset by default: the "Private relay" option only appears
// once a relay actually exists to point at. Configure it at build time with
//     VITE_PRIVATE_RELAY_URL=https://relay.zkas.info/daemon
// (or edit the fallback below) and the first-run screen + connection chooser
// light it up automatically. No relay is contacted until the user selects it.
export const PRIVATE_RELAY_URL: string =
  (import.meta.env.VITE_PRIVATE_RELAY_URL as string | undefined)?.trim() || "";
