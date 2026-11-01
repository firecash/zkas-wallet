// "Run in this browser": the web counterpart of "Run on this phone". The wallet engine runs inside
// this page; the viewing key and the seed never leave it, and no wallet service is contacted.
// Public chain data comes from ZKas's chain files and gateway, which see this browser's IP.
import { useTranslation } from "react-i18next";
import { browserEngineAvailable, browserModeChosen } from "./webengine";

export function RunInBrowserOption({ busy, onStart }: { busy?: boolean; onStart: () => void | Promise<void> }) {
  const { t } = useTranslation();
  if (!browserEngineAvailable()) return null;
  const on = browserModeChosen();
  // Two spans, always: the option's layout styles the LAST span as the state chip (narrow,
  // right-aligned). With the chip omitted, the title and description became that chip — a
  // squeezed right-aligned column (seen on wallet.zkas.info, 1 Nov).
  return (
    <button type="button" className={"connection-option" + (on ? " active" : "")} disabled={!!busy} onClick={() => { if (!on) void onStart(); }}>
      <span>
        <b>{t("runInBrowserOption.title")}</b>
        <small>{t("runInBrowserOption.desc")}</small>
      </span>
      <span>{on ? t("connectionButton.on") : t("connectionButton.use")}</span>
    </button>
  );
}
