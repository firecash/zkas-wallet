import { isNative } from "./api";
import { isDesktop } from "./desktop";

// Injected at build time by vite.config.ts.
declare const __APP_VERSION__: string;
declare const __APP_BUILT__: string;

/// The release this build came from, e.g. "1.0.22".
export const APP_VERSION: string = typeof __APP_VERSION__ === "string" ? __APP_VERSION__ : "dev";

/// When this bundle was built, UTC, to the minute.
///
/// The version alone is not enough to identify what someone is running: the web
/// can be redeployed ahead of a tagged release, so two people on "1.0.22" may not
/// have the same code. The stamp settles it.
export const APP_BUILT: string = typeof __APP_BUILT__ === "string" ? __APP_BUILT__ : "";

/// Where this copy is running — the other half of a useful bug report.
export function platformName(): string {
  const cap = (globalThis as { Capacitor?: { getPlatform?: () => string } }).Capacitor;
  const native = isNative() ? cap?.getPlatform?.() : "";
  if (native === "android") return "Android";
  if (native === "ios") return "iOS";
  if (isDesktop()) return "Desktop";
  return "Web";
}

/// Short form for a badge: "v1.0.22".
export function versionTag(): string {
  return `v${APP_VERSION}`;
}

/// Everything worth pasting into a bug report, in one line.
export function versionLine(): string {
  const built = APP_BUILT ? ` · built ${APP_BUILT} UTC` : "";
  return `ZKas Wallet ${APP_VERSION} · ${platformName()}${built}`;
}
