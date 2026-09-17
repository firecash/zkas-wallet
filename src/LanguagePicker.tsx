import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Languages } from "lucide-react";
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
      <Languages aria-hidden="true" size={15} strokeWidth={2.2} />
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
      <Languages className="warnbar-icon" aria-hidden="true" size={17} strokeWidth={2.2} />
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
