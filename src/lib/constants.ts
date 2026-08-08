import { isDesktop } from "../desktop";

export const EXPLORER = "https://explorer.zkas.info";
export const NET_LABEL = "mainnet";

export type Tab = "receive" | "send" | "history" | "signatures" | "settings";

export const TAB_LABEL: Record<Tab, string> = {
  receive: "Receive",
  send: "Send",
  history: "History",
  signatures: "Signatures",
  settings: "⚙",
};

export const ROOMY = () => isDesktop() || (typeof window !== "undefined" && window.innerWidth >= 900);

export const TABS: Tab[] = ROOMY() ? ["history", "signatures", "settings"] : ["history", "settings"];

export const CONF_LOOKUP_LIMIT = 12;
export const CONF_MAX_TRIES = 120;
export const CONF_RECENT_RETRY_MS = 60 * 60 * 1000;

export const HISTORY_PAGE = 50;

export const MISSING_TOLERANCE = 10;

export const MOBILE_SCROLL_MAX_WIDTH = 720;

export const FEE_FC = 0.03;
export const FEE_MAX_FC = 0.045;

export function scrollToPane(force = false) {
  if (typeof window === "undefined") return;
  if (!force && window.innerWidth > MOBILE_SCROLL_MAX_WIDTH) return;
  requestAnimationFrame(() => {
    document.querySelector(".pane")?.scrollIntoView({ behavior: "smooth", block: "start" });
  });
}
