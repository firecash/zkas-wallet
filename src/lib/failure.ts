import i18n from "../i18n";

/// The text to show for a thrown value, whatever shape it arrived in.
///
/// The signer and the wasm bridge throw BARE STRINGS, not Errors, so reading
/// `.message` off them yields `undefined` — which is how a failed send, and a
/// mistyped recovery phrase, each managed to render an empty error box: the
/// spinner stopped and nothing said why. Lives here rather than in App.tsx so
/// screens that App itself renders (LockScreen) can use it without an import
/// cycle.
export function failureText(e: unknown): string {
  if (typeof e === "string" && e.trim()) return serverText(e) ?? e;
  const msg = (e as { message?: unknown } | null)?.message;
  if (typeof msg === "string" && msg.trim()) return serverText(msg) ?? msg;
  const str = String(e ?? "");
  return str && str !== "[object Object]" ? str : i18n.t("send.unknownFailure");
}

/// The wallet service answers in English; the messages people actually meet are said here in
/// their language. Only what is recognised is replaced: anything else keeps the service's own
/// words. Code that decides on an error reads the raw message, never this text.
export function serverText(raw: string): string | null {
  const m = raw.toLowerCase();
  if (m.includes("cannot reach its node")) return i18n.t("serverError.noNode");
  if (m.includes("still preparing other payments")) return i18n.t("noncustodial.waitingPrevious");
  if (m.includes("being repaired after a reorg") || m.includes("anchor epoch changes")) return i18n.t("serverError.retryShortly");
  if (m.includes("has not established a matured anchor")) return i18n.t("serverError.stillSyncing");
  const sent = /already sent \(transaction ([0-9a-f]{8,64})\)/i.exec(raw);
  if (sent) return i18n.t("serverError.alreadySent", { txid: sent[1].slice(0, 12) });
  const merge = /note merge was prepared but never sent.*?(\d+) min/i.exec(raw);
  if (merge) return i18n.t("serverError.mergeCooldown", { min: merge[1] });
  if (m.includes("insufficient matured funds") || m.includes("must be ~10 min old")) return i18n.t("serverError.notMatured");
  if (m.includes("minimum network fee")) return i18n.t("serverError.belowMinFee");
  if (m.includes("not a shielded orchard address") || m.includes("invalid recipient address")) return i18n.t("serverError.badRecipient");
  // The node's own refusal, as the browser's gateway and the wallet service pass it on.
  if (m.includes("nullifier already claimed")) return i18n.t("serverError.alreadyClaimed");
  if (m.includes("rejected transaction") || m.includes("network refused the payment") || m.includes("would not accept this payment")) return i18n.t("serverError.refused");
  // The in-browser wallet's messages: its worker has no translations, so they are said here.
  if (m.includes("still starting in this browser")) return i18n.t("serverError.browserStarting");
  if (m.includes("took too long to prepare in this browser")) return i18n.t("serverError.browserSlow");
  if (m.includes("was stopped or switched before the payment was sent")) return i18n.t("serverError.browserStopped");
  if (m.includes("wallet engine is out of date")) return i18n.t("serverError.browserOutdated");
  if (m.includes("not known whether it went out")) return i18n.t("serverError.browserUnknown");
  if (m.includes("there is no wallet in this browser")) return i18n.t("serverError.browserNoWallet");
  if (m.includes("refused to store the setting")) return i18n.t("serverError.browserStorage");
  if (m.includes("needs clearnet access")) return i18n.t("serverError.browserClearnet");
  return null;
}
