// "Run in this browser": the web counterpart of "Run on this phone". The wallet engine runs inside
// this page; the viewing key and the seed never leave it, and no wallet service is contacted.
// Public chain data comes from ZKas's chain files and gateway, which see this browser's IP.
import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { browserEngineAvailable, browserModeChosen } from "./webengine";

export function RunInBrowserOption({ busy, tag, onStart }: { busy?: boolean; tag?: ReactNode; onStart: () => void | Promise<void> }) {
  const { t } = useTranslation();
  if (!browserEngineAvailable()) return null;
  return (
    <button type="button" className={"connection-option" + (browserModeChosen() ? " active" : "")} disabled={!!busy} onClick={() => void onStart()}>
      <span>
        <b>{t("runInBrowserOption.title")}</b>
        <small>{t("runInBrowserOption.desc")}</small>
      </span>
      {tag != null && <span>{tag}</span>}
    </button>
  );
}
