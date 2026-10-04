export const CHAT_RELAYS = [
  // Seed relay. Served from a path on an existing domain so it needs no DNS
  // record and no second certificate; TLS terminates at nginx and the relay
  // itself listens on loopback only.
  //
  // The app shipping a list at all is a bootstrap, not the design: the intent is
  // an on-chain registry, so that no app update can silently re-point everyone.
  "wss://zkas.info/chat-relay",
] as const;
