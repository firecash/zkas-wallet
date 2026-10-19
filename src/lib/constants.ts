import { isDesktop } from "../desktop";
import i18n from "../i18n";

export const EXPLORER = "https://explorer.zkas.info";
export const NET_LABEL = "mainnet";

export type Tab = "receive" | "send" | "history" | "signatures" | "settings";

export const TAB_LABEL: Record<Tab, () => string> = {
  receive: () => i18n.t("libConstants.tabReceive"),
  send: () => i18n.t("libConstants.tabSend"),
  history: () => i18n.t("libConstants.tabHistory"),
  signatures: () => i18n.t("libConstants.tabSignatures"),
  settings: () => "⚙",
};

export const ROOMY = () => isDesktop() || (typeof window !== "undefined" && window.innerWidth >= 900);

export const TABS: Tab[] = ROOMY() ? ["history", "signatures", "settings"] : ["history", "settings"];

export const CONF_LOOKUP_LIMIT = 12;
export const CONF_MAX_TRIES = 120;
export const CONF_RECENT_RETRY_MS = 60 * 60 * 1000;

export const HISTORY_PAGE = 50;

export const MISSING_TOLERANCE = 10;

export const MOBILE_SCROLL_MAX_WIDTH = 720;

/// SUPERSEDED — do not import these for anything a user reads or a send relies on.
///
/// They are a FLAT fee: 0.03 was the typical one-or-two-note fee and 0.045 the worst case for
/// six. A real fee scales with the number of notes spent, and `fees.ts` computes it from the
/// node's own constants: 0.0185 ZKAS for 2 spends and 0.2458 for 38. A flat figure
/// under-states the fee by more than five times at the top of that range, and a flat fee below
/// the node's bytes x 200 minimum is rejected by relay outright — which has happened on this
/// project before.
///
/// App.tsx moved everything user-facing to `fees.ts` and records why; it keeps its own local
/// copies of these two names for one display fallback. Nothing imports THESE, and nothing
/// should: kept only so the names are not silently reused, and asserted unimported by
/// `no-shadowed-helpers.test.ts`.
export const FEE_FC = 0.03;
export const FEE_MAX_FC = 0.045;

