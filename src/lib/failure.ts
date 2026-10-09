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
  if (typeof e === "string" && e.trim()) return e;
  const msg = (e as { message?: unknown } | null)?.message;
  if (typeof msg === "string" && msg.trim()) return msg;
  const str = String(e ?? "");
  return str && str !== "[object Object]" ? str : i18n.t("send.unknownFailure");
}
