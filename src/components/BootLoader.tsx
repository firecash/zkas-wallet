// The loading window shown while a route chunk (or the wallet itself) is still
// arriving. It is a pixel-for-pixel continuation of the inline boot splash in
// `index.html` — the same ZKas mark, halo, spacing and progress line — so the
// browser's first paint, this React screen and the app read as one continuous
// opening rather than three different loading states. Styles: src/styles.boot.css.
//
// The mark is the real app icon (public/zkas-mark.png), requested relatively so
// the same markup resolves under https, Capacitor and the Tauri shell. By the
// time this component can render, that file is already in the HTTP cache: the
// splash showed the identical image inline moments earlier.
import { useTranslation } from "react-i18next";

export function BootLoader({ label }: { label?: string }) {
  const { t } = useTranslation();
  const text = label ?? t("bootLoader.opening");
  return (
    <div className="boot-screen" role="status" aria-live="polite" aria-label={text}>
      <div className="bl-stack">
        <div className="bl-logo">
          <img src="./zkas-mark.png" width={88} height={88} alt="" aria-hidden="true" />
        </div>
        <div className="bl-tag">{text}</div>
        <div className="bl-bar" aria-hidden="true">
          <span />
        </div>
      </div>
    </div>
  );
}
