// Settings -> Fast sync: the on-device engine's chain-file address, changeable without leaving
// "Run on this phone". Applied the way the engine reads it — at start — so while the wallet runs
// on this phone, Apply restarts the engine with the new choice (and only a start that succeeds
// stores it); otherwise the choice is stored for the next start.
import { useState } from "react";
import { useTranslation } from "react-i18next";
import {
  DEFAULT_CHAIN_FILES_URL,
  embeddedChainFilesUrl,
  embeddedChosen,
  embeddedFastSync,
  embeddedPrimaryNode,
  embeddedTor,
  ensureEmbedded,
  isPublicZkasNode,
  normalizeChainFilesUrl,
  setEmbeddedChainFilesUrl,
  setEmbeddedFastSync,
  validChainFilesUrl,
} from "./embedded";
import { setBase } from "./api";

export function FastSyncSettings() {
  const { t } = useTranslation();
  const tor = embeddedTor();
  const [fast, setFast] = useState(() => embeddedFastSync());
  const [url, setUrl] = useState(() => embeddedChainFilesUrl() || DEFAULT_CHAIN_FILES_URL);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const urlOk = validChainFilesUrl(url);
  const customUrl = normalizeChainFilesUrl(url) !== "";
  const applies = !tor && (isPublicZkasNode(embeddedPrimaryNode()) || customUrl);
  const unchanged = fast === embeddedFastSync() && normalizeChainFilesUrl(url) === embeddedChainFilesUrl();

  const apply = async () => {
    if (fast && !urlOk) return;
    setBusy(true);
    setMsg(null);
    try {
      if (embeddedChosen()) {
        // Restarts the engine only if the choice differs from what it runs with; stores it on success.
        const u = await ensureEmbedded(undefined, undefined, true, { on: fast, url });
        setBase(u);
        setMsg({ ok: true, text: t("fastSyncSettings.applied") });
      } else {
        setEmbeddedFastSync(fast);
        setEmbeddedChainFilesUrl(url);
        setMsg({ ok: true, text: t("fastSyncSettings.saved") });
      }
    } catch (e) {
      setMsg({ ok: false, text: t("fastSyncSettings.failed", { error: String((e as Error)?.message ?? e) }) });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="card">
      <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
        <label className="row" style={{ gap: 10, alignItems: "center", cursor: tor ? "default" : "pointer" }}>
          <input type="checkbox" checked={fast && !tor} disabled={busy || tor} onChange={(e) => setFast(e.target.checked)} />
          <b>{t("runOnPhoneOption.fastTitle")}</b>
        </label>
        {fast && !tor && (
          <input
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            placeholder={t("runOnPhoneOption.fastUrlPlaceholder")}
            aria-label={t("runOnPhoneOption.fastUrlLabel")}
            disabled={busy}
            spellCheck={false}
            autoCapitalize="off"
            autoCorrect="off"
            inputMode="url"
          />
        )}
        <span className="muted small">
          {tor
            ? t("runOnPhoneOption.fastOffTor")
            : !fast
              ? t("runOnPhoneOption.fastOff")
              : !urlOk
                ? t("runOnPhoneOption.fastBadUrl")
                : !applies
                  ? t("runOnPhoneOption.fastOffOwnNode")
                  : customUrl
                    ? t("runOnPhoneOption.fastHint")
                    : t("runOnPhoneOption.fastHintDefault")}
        </span>
        <div className="row" style={{ gap: 8, flexWrap: "wrap" }}>
          <button type="button" className="btn" disabled={busy || tor || unchanged || (fast && !urlOk)} onClick={() => void apply()}>
            {busy ? t("fastSyncSettings.applying") : t("fastSyncSettings.apply")}
          </button>
          {fast && customUrl && (
            <button type="button" className="btn ghost" disabled={busy} onClick={() => setUrl(DEFAULT_CHAIN_FILES_URL)}>
              {t("fastSyncSettings.useDefault")}
            </button>
          )}
        </div>
        {msg && <div className={"msg" + (msg.ok ? "" : " err")}>{msg.text}</div>}
      </div>
    </div>
  );
}

/** The Settings row summary: On / Off. */
export function fastSyncSummary(on: string, off: string): string {
  return embeddedFastSync() && !embeddedTor() ? on : off;
}
