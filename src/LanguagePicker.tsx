import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import { Globe } from "lucide-react";
import { LANGUAGES, currentLanguage, hasChosenLanguage, languageName, setLanguage } from "./i18n";

function LanguageSelect({ label }: { label: string }) {
  const current = currentLanguage();
  return (
    <select
      value={LANGUAGES.some((l) => l.code === current) ? current : "en"}
      onChange={(e) => void setLanguage(e.target.value)}
      aria-label={label}
    >
      {LANGUAGES.map((l) => (
        <option key={l.code} value={l.code} lang={l.code}>
          {l.name}
        </option>
      ))}
    </select>
  );
}

/// Language choice for Settings → Appearance. Native names, so a user finds their own
/// language without reading the current one. The switch is immediate and persisted.
export function LanguagePicker() {
  const { t, i18n } = useTranslation();
  return (
    <div className="card">
      <h2>{t("languagePicker.label")}</h2>
      <LanguageSelect label={t("languagePicker.label")} />
      <p className="muted small" style={{ marginBottom: 0 }}>
        {i18n.language === "en" ? t("languagePicker.hintEnglish") : t("languagePicker.hint")}
      </p>
    </div>
  );
}

/// One line on the welcome screen: the first thing a new user can change is the
/// language, before reading anything else in a language that was only guessed.
export function LanguageInline() {
  const { t } = useTranslation();
  return (
    <div className="lang-inline">
      <Globe aria-hidden="true" size={15} strokeWidth={2.2} />
      <LanguageSelect label={t("languagePicker.label")} />
    </div>
  );
}

/// Existing users after the update, and anyone whose device language we guessed: a
/// one-time bar saying which language the app picked, with the switcher right there.
/// "OK" records the current language as chosen, so the bar never returns; picking
/// another language records that one. English users see nothing — there was no guess.
export function LanguageNotice() {
  const { t } = useTranslation();
  const [gone, setGone] = useState(false);
  const current = currentLanguage();
  if (gone || current === "en" || hasChosenLanguage()) return null;
  return (
    <div className="warnbar lang-notice" role="note">
      <Globe className="warnbar-icon" aria-hidden="true" size={17} strokeWidth={2.2} />
      <div className="lang-notice-body">
        <span>{t("languagePicker.autoNotice", { name: languageName(current) })}</span>
        <LanguageSelect label={t("languagePicker.label")} />
        <button
          className="linkbtn"
          onClick={() => {
            void setLanguage(current);
            setGone(true);
          }}
        >
          {t("languagePicker.keep")}
        </button>
      </div>
    </div>
  );
}

/// The globe. Always visible — top line of the wallet, first-run screens, lock screens —
/// so nobody has to know that the language lives under Settings → Appearance. Opens a
/// list of native names; one tap switches and remembers.
export function LanguageButton({ compact = false }: { compact?: boolean }) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const current = currentLanguage();
  const pick = (code: string) => {
    void setLanguage(code);
    setOpen(false);
  };
  // While open, the modal owns Back (hardware/gesture on Android, see main.tsx) and
  // Escape: claiming "zkas:back" keeps the press from walking the router history.
  useEffect(() => {
    if (!open) return;
    const onBack = (event: Event) => {
      event.preventDefault();
      setOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    window.addEventListener("zkas:back", onBack);
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("zkas:back", onBack);
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);
  return (
    <>
      <button
        className={"lang-button" + (compact ? " compact" : "")}
        onClick={() => setOpen(true)}
        aria-label={t("languagePicker.label")}
        title={t("languagePicker.label")}
      >
        <Globe aria-hidden="true" size={17} strokeWidth={2.2} />
        {!compact && <span>{current.toUpperCase()}</span>}
      </button>
      {open &&
        createPortal(
          <div className="modalwrap" onClick={() => setOpen(false)}>
            <div className="card modalcard lang-modal" onClick={(e) => e.stopPropagation()} role="dialog" aria-label={t("languagePicker.label")}>
              <h2 style={{ marginTop: 0 }}>{t("languagePicker.label")}</h2>
              <div className="lang-list">
                {LANGUAGES.map((l) => (
                  <button
                    key={l.code}
                    className={"lang-item" + (l.code === current ? " on" : "")}
                    lang={l.code}
                    onClick={() => pick(l.code)}
                    aria-pressed={l.code === current}
                  >
                    {l.name}
                  </button>
                ))}
              </div>
            </div>
          </div>,
          document.body,
        )}
    </>
  );
}
