import { Component, lazy, StrictMode, Suspense, useEffect, useMemo, useState, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { HashRouter, Routes, Route, Navigate, Outlet, useLocation, useNavigate } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { Blocks, HardDrive, LayoutGrid, Pickaxe, Server, Settings, WalletCards } from "lucide-react";
import { LockScreen } from "./LockScreen";
import { AppLockScreen } from "./AppLockScreen";
import { installAutoLock, isLockEnabled, isUnlocked } from "./applock";
import { ToastHost } from "./toast";
import { applyStoredTheme } from "./theme";
// Importing the instance also initialises i18next with the merged English catalogue and
// applies the stored/browser language before the first render. The instance itself is
// for the class-based Boundary and the pre-React boot guard, which cannot use hooks.
import i18n from "./i18n";
import { initDesktop, isDesktop, vaultStatus } from "./desktop";
import { FirstRunNode, needsNodeChoice, markNodeChoiceMade } from "./FirstRunNode";
import { FirstRunConnect } from "./FirstRunConnect";
import { WhatsNew, shouldShowWhatsNew } from "./WhatsNew";
import { WalletRoute } from "./WalletRoute";
import { useHashRouterSync } from "./hashsync";
import { versionLine, versionTag } from "./version";
import { adoptViewKeyFromUrl } from "./lib/watchadopt";
import { BootLoader } from "./components/BootLoader";
import { listWallets } from "./wallets";
import { isNative, loadStatusCache, setBase } from "./api";
import { embeddedChosen, ensureEmbedded } from "./embedded";
import { internalRouteFromLink, queuePaymentLink } from "./paymentlinks";
import "./styles.css";

// Every tool page used to ship in the first JavaScript download, including QR,
// explorer, service-directory and mining code a user may never open. Load a
// route when it is selected so the wallet itself reaches first paint sooner.

const NodeRunner = lazy(() => import("./pages/NodeRunner").then((module) => ({ default: module.NodeRunner })));
const Mining = lazy(() => import("./pages/Mining").then((module) => ({ default: module.Mining })));
const Explorer = lazy(() => import("./pages/Explorer").then((module) => ({ default: module.Explorer })));
const Services = lazy(() => import("./pages/Services").then((module) => ({ default: module.Services })));
const SelfHost = lazy(() => import("./pages/SelfHost").then((module) => ({ default: module.SelfHost })));

// On desktop the wallet is gated behind a passphrase: the embedded daemon does
// not run (and the seed cannot be decrypted) until the user unlocks. So the boot
// order is — ask the shell whether this device is locked, show the lock screen if
// it is, and only mount the wallet once the daemon is up. In the browser there is
// no vault and this resolves straight to the app.
function Root({ locked, askNode, whatsNew }: { locked: boolean; askNode: boolean; whatsNew: boolean }) {
  const { t } = useTranslation();
  const [unlocked, setUnlocked] = useState(!locked);
  const [nodeChosen, setNodeChosen] = useState(!askNode);
  const [showWhatsNew, setShowWhatsNew] = useState(whatsNew);
  // The app lock (PIN/passphrase over the on-device seed) is independent of the
  // desktop vault: it guards the key this device holds, on every platform, and
  // is what mobile uses. Re-locks itself after time in the background.
  const [appUnlocked, setAppUnlocked] = useState(!isLockEnabled() || isUnlocked());
  useEffect(() => {
    installAutoLock(() => setAppUnlocked(false));
  }, []);
  if (isLockEnabled() && !appUnlocked) return <AppLockScreen onUnlocked={() => setAppUnlocked(true)} />;
  if (!unlocked) return <LockScreen onUnlocked={() => setUnlocked(true)} />;
  // Asked after unlock: the connection choice changes what the wallet talks to,
  // and there is no point configuring one for a wallet still locked. Desktop
  // picks a NODE for its embedded daemon (FirstRunNode); mobile/web pick the
  // wallet SERVICE (FirstRunConnect) — and crucially contact nothing until then.
  if (!nodeChosen)
    return isDesktop()
      ? <FirstRunNode onDone={() => setNodeChosen(true)} />
      : <FirstRunConnect onDone={() => setNodeChosen(true)} />;

  return (
    <>
      {showWhatsNew && <WhatsNew onClose={() => setShowWhatsNew(false)} />}
      <HashRouter>
      <Suspense fallback={<BootLoader label={t("mainRoot.opening")} />}>
        <Routes>
          <Route element={<AppShell />}>
            <Route path="/" element={<WalletRoute />} />
            {/* Settings is a wallet tab, but the mobile nav needs a real location
                so the bar can highlight it and Back behaves. */}
            <Route path="/settings" element={<WalletRoute />} />
            <Route path="/node" element={<NodeRunner />} />
            <Route path="/mine" element={<Mining />} />
            <Route path="/explore" element={<Explorer />} />
            <Route path="/explore/:kind/:id" element={<Explorer />} />
            <Route path="/services" element={<Services />} />
            {/* Pay moved into the wallet's own sections. The route stays so
                existing links, shortcuts and bookmarks land on it rather than
                nowhere. */}
            <Route path="/tools" element={<Navigate to="/?tab=tools" replace />} />
            <Route path="/self-host" element={<SelfHost />} />
          </Route>
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </Suspense>
      </HashRouter>
    </>
  );
}

function AppShell() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const location = useLocation();
  const desktop = isDesktop();
  const android = isNative() && (globalThis as { Capacitor?: { getPlatform?: () => string } }).Capacitor?.getPlatform?.() === "android";
  const servicesTheme = location.pathname.startsWith("/services");
  // Mining is a desktop activity: the app supervises a node and a stratum bridge
  // there. On a phone it was a tab nobody could use, taking a quarter of the bar
  // from Settings — which every user needs. The mobile bar is therefore
  // Wallet · Explore · Services · Settings.
  const pages = useMemo(() => [
    { path: "/", label: t("mainNav.wallet"), icon: WalletCards },
    ...(desktop
      ? [
          { path: "/node", label: t("mainNav.node"), icon: Server },
          { path: "/mine", label: t("mainNav.mine"), icon: Pickaxe },
        ]
      : []),
    { path: "/explore", label: t("mainNav.explore"), icon: Blocks },
    { path: "/services", label: t("mainNav.services"), icon: LayoutGrid },
    ...(desktop
      ? [{ path: "/self-host", label: t("mainNav.host"), icon: HardDrive }]
      : [{ path: "/settings", label: t("mainNav.settings"), icon: Settings }]),
  ], [android, desktop, t]);
  useHashRouterSync();
  // Reset scroll on every top-level route change (Wallet ↔ Explore ↔ Services ↔
  // Settings…) — a new screen otherwise keeps the previous one's scroll offset.
  useEffect(() => { try { window.scrollTo(0, 0); } catch { /* SSR */ } }, [location.pathname, location.search]);
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (!(event.ctrlKey || event.metaKey) || event.altKey || event.shiftKey) return;
      const index = Number(event.key) - 1;
      if (Number.isInteger(index) && index >= 0 && index < pages.length) {
        event.preventDefault();
        navigate(pages[index].path);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [navigate, pages]);
  return (
    <div className={`app-shell${desktop ? " desktop-shell" : ""}${servicesTheme ? " services-theme" : ""}`}>
      <nav className="app-switcher" aria-label={t("mainNav.mainAria")}>
        <div className="app-nav-bar">
          <button className="app-wordmark" onClick={() => navigate("/")} aria-label={t("mainNav.homeAria")}>
            <span>Z</span>KAS{/* i18n-ignore: logo wordmark */}
          </button>
          {/* Desktop has the room, so the version lives in the chrome where it is
              always visible — no digging through Settings to answer "what are you
              running?". The full line, including the build stamp, is the tooltip.
              Phones do not get this: the bar is four tabs and a thumb. */}
          {desktop && (
            <span className="version-badge" title={versionLine()} aria-label={versionLine()}>
              {versionTag()}
            </span>
          )}
          <div className="app-page-links">
            {pages.map((page, index) => {
              const active = location.pathname === page.path || (page.path === "/explore" && location.pathname.startsWith("/explore/"));
              const Icon = page.icon;
              return <button key={page.path} title={desktop ? t("mainNav.tabShortcut", { label: page.label, n: index + 1 }) : page.label} aria-current={active ? "page" : undefined} className={active ? "active" : ""} onClick={() => navigate(page.path)}><Icon aria-hidden="true" size={18} strokeWidth={1.8} /><span className="app-nav-label">{page.label}</span></button>;
            })}
          </div>
        </div>
      </nav>
      <div className="app-shell-content"><Outlet /></div>
    </div>
  );
}

// A render error anywhere in the tree would otherwise unmount EVERYTHING —
// the user sees a blank window over their money and calls it a crash. Catch it,
// say what happened, and offer the one action that usually clears transient
// state: reload. The wallet itself (seed, settings) is in storage, not in React.
class Boundary extends Component<{ children: ReactNode }, { err: Error | null }> {
  state = { err: null as Error | null };
  static getDerivedStateFromError(err: Error) {
    return { err };
  }
  componentDidCatch(err: Error, info: { componentStack?: string | null }) {
    console.error("wallet UI crashed:", err, info.componentStack);
  }
  render() {
    if (!this.state.err) return this.props.children;
    return (
      <div className="lockwrap">
        <div className="card lockcard">
          <h2 style={{ marginTop: 0 }}>{i18n.t("errorBoundary.title")}</h2>
          <p className="muted small">
            {i18n.t("errorBoundary.body")}
          </p>
          <p className="muted small mono" style={{ wordBreak: "break-all" }}>
            {String(this.state.err)}
          </p>
          <button className="btn" onClick={() => location.reload()}>
            {i18n.t("errorBoundary.reload")}
          </button>
        </div>
      </div>
    );
  }
}

async function boot() {
  let locked = false;
  if (isDesktop()) {
    try {
      const v = await vaultStatus();
      // Only an ENCRYPTED seed file needs unlocking. A cleartext wallet is
      // already usable (the app nags to encrypt it from Settings rather than
      // locking anyone out of their money), and a watch-only wallet has no seed
      // here at all — demanding a passphrase for it would protect nothing while
      // making the app look broken.
      locked = v.state === "encrypted" && !v.unlocked;
      // Settings → "Set a passphrase" on a cleartext wallet asks for the setup
      // screen even though the wallet is perfectly usable as-is.
      if (sessionStorage.getItem("vault_setup") === "1") {
        sessionStorage.removeItem("vault_setup");
        locked = true;
      }
    } catch {
      locked = false; // never strand the user behind a broken probe
    }
  }
  // The daemon's port/token must be installed BEFORE the app mounts (api.ts reads
  // them at call time). Unlocking installs them too, so this is for the already-
  // unlocked / browser paths.
  // Retry once, and never swallow the reason. When this failed silently the SPA
  // mounted with no daemon address at all and every call fell back to a port the
  // engine may not even be on, surfacing as a raw transport error with nothing
  // to act on.
  if (!locked) {
    try {
      await initDesktop();
    } catch (first) {
      try {
        await initDesktop();
      } catch (second) {
        const reason = (second as Error)?.message || String(second) || String(first);
        console.error("desktop bootstrap failed:", reason);
        try { localStorage.setItem("desktop_boot_error", reason); } catch { /* best effort */ }
      }
    }
  }

  // On-device engine: if the user chose "Run on this phone", start it now and
  // point the app at its fresh loopback port BEFORE anything polls a server —
  // the whole point is that no viewing key ever leaves the device. The port is
  // new on each launch, so this must run every boot, not just first-run. Falls
  // back to whatever base was set if it cannot start, so the wallet is never
  // bricked by an engine hiccup.
  if (embeddedChosen()) {
    try {
      const url = await ensureEmbedded();
      setBase(url);
    } catch (e) {
      console.error("on-device engine did not start:", (e as Error)?.message ?? e);
    }
  }

  // A view-key link turns this browser into a read-only window on a wallet. Do
  // it before the first-run gate: the link IS the user's choice of service, and
  // asking them to pick one first would be asking a question they already
  // answered by opening the link.
  try {
    if (await adoptViewKeyFromUrl()) {
      location.reload();
      return;
    }
  } catch (e) {
    console.error("could not adopt the view key:", (e as Error)?.message ?? e);
  }

  // First-run connection gate. It matters where the app bundle is LOCAL and its
  // first act would otherwise be to contact a server: native mobile (privacy-
  // first service chooser) and desktop (its existing node chooser). Plain web is
  // excluded — the host already served the page, so gating the walletd poll adds
  // friction without adding privacy.
  //
  // Fresh installs only. A device that has already used the wallet has a wallet,
  // a token or a cached status — it effectively chose its server long ago, so an
  // upgrade must not drop it onto a setup screen. Settle the choice silently so
  // the gate never reappears for them, and so no poll is deferred for a returning
  // user who already consented by using the app.
  //
  // Guarded: with site storage blocked (Safari "Block all cookies", Chrome "Don't
  // allow sites to save data") the localStorage accessor itself throws, and this
  // was the first unguarded read on the boot path — the splash then stayed up
  // forever. Treat a throw as no history; the boot().catch below explains.
  let hasWalletHistory = false;
  try {
    hasWalletHistory =
      listWallets().length > 0 || !!loadStatusCache() || !!localStorage.getItem("wallet_token");
    if (hasWalletHistory && needsNodeChoice()) markNodeChoiceMade();
  } catch {
    /* storage unavailable — a fresh-install boot, at best */
  }
  const askNode = needsNodeChoice() && (isDesktop() || isNative());
  // Existing users skip first-run, so announce the new connection/privacy/theme
  // features once via a "what's new" popup instead.
  const whatsNew = shouldShowWhatsNew(hasWalletHistory);

  // Dark is the identity and the only theme now (light was dropped). Clear any
  // stored light/system preference so an early adopter is not stuck on it.
  try { localStorage.removeItem("theme"); } catch { /* ignore */ }
  applyStoredTheme();
  // Renderers that composite blur/backdrop-filter without the GPU get a lighter
  // skin: WebKitGTK (the Linux desktop app) is software-rendered on most setups,
  // and a low-core phone spends that budget better on scrolling. Everything stays
  // legible — only the decorative layers go.
  try {
    const ua = navigator.userAgent;
    const webkitGtk = /\bWebKitGTK\b/i.test(ua) || (/AppleWebKit/.test(ua) && !/Chrome|Safari\/\d|Edg/.test(ua));
    const weakDevice = (navigator.hardwareConcurrency ?? 8) <= 4 && /Android/i.test(ua);
    if (webkitGtk || weakDevice) document.body.classList.add("reduced-effects");
  } catch {
    /* never block boot on a UA probe */
  }

  // QR images are cached per address and were only ever swept when a wallet was
  // removed — addresses of long-gone wallets accumulated forever. Keep entries
  // for addresses this device still knows (registry + cached status); the rest
  // are regenerated on demand.
  try {
    const known = new Set(listWallets().map((w) => w.address).filter((a): a is string => !!a));
    const cached = loadStatusCache();
    if (cached?.address) known.add(cached.address);
    for (let i = localStorage.length - 1; i >= 0; i--) {
      const k = localStorage.key(i);
      if (k?.startsWith("qr_") && !known.has(k.slice(3))) localStorage.removeItem(k);
    }
  } catch {
    /* best-effort housekeeping — a cache miss is regenerated anyway */
  }

  // Ask the browser not to evict our storage. Safari deletes a site's
  // localStorage after 7 days without a visit — and for an on-device wallet
  // that storage holds the SEED. Best-effort; browsers may ignore it, which is
  // why the backup nag exists.
  try {
    void navigator.storage?.persist?.();
  } catch {
    /* older engines have no storage manager */
  }

  createRoot(document.getElementById("root")!).render(
    <StrictMode>
      <ToastHost>
        <Boundary>
          <Root locked={locked} askNode={askNode} whatsNew={whatsNew} />
        </Boundary>
      </ToastHost>
    </StrictMode>,
  );

  // Desktop: the WebView has no new-window handler, so an `<a target="_blank">`
  // opened nothing at all (Mining.tsx documented the symptom). Route those
  // clicks — and only those — to the system browser through the opener plugin
  // the shell registers (src-tauri: tauri-plugin-opener + `opener:default`).
  // Loaded on demand so the web/mobile bundles never pull the Tauri module in.
  if (isDesktop()) {
    document.addEventListener("click", (ev) => {
      if (ev.defaultPrevented || ev.button !== 0) return;
      const a = (ev.target as Element | null)?.closest?.("a[href]");
      if (!(a instanceof HTMLAnchorElement) || a.target !== "_blank") return;
      const href = a.href;
      if (!/^(https?|mailto):/i.test(href)) return;
      ev.preventDefault();
      void import("@tauri-apps/plugin-opener")
        .then(({ openUrl }) => openUrl(href))
        .catch((e) => console.error("could not open the link in the system browser:", (e as Error)?.message ?? e));
    });
  }

  const openLink = (url: string) => {
    const route = internalRouteFromLink(url);
    if (route) {
      location.hash = `#${route}`;
      return;
    }
    if (queuePaymentLink(url)) location.hash = "#/";
  };
  const webPayment = new URLSearchParams(location.search).get("payment");
  if (webPayment) {
    openLink(webPayment);
    history.replaceState(null, "", `${location.pathname}${location.hash}`);
  }
  if ((globalThis as { Capacitor?: { isNativePlatform?: () => boolean } }).Capacitor?.isNativePlatform?.()) {
    void import("@capacitor/app").then(async ({ App: CapacitorApp }) => {
      const launch = await CapacitorApp.getLaunchUrl();
      if (launch?.url) openLink(launch.url);
      await CapacitorApp.addListener("appUrlOpen", ({ url }) => openLink(url));
      // Hardware/gesture Back. @capacitor/app's default only walks WebView history
      // and does NOTHING at the root, so the app could never be left with Back and
      // state-only overlays (QR scanner, dialogs) could not be dismissed. An open
      // overlay claims the press by calling preventDefault() on "zkas:back";
      // otherwise Back walks the router history and, at the root, minimizes.
      await CapacitorApp.addListener("backButton", ({ canGoBack }) => {
        const claimed = !window.dispatchEvent(new CustomEvent("zkas:back", { cancelable: true }));
        if (claimed) return;
        if (canGoBack) history.back();
        else void CapacitorApp.minimizeApp();
      });
    }).catch(() => {});
  }
  // Installable web app with an OFFLINE UI shell. The service worker explicitly
  // excludes every wallet/chain API, so offline never means showing cached money.
  // Native bundles ship their assets with the application and already have a
  // native background worker. A browser service worker inside Capacitor can
  // retain an obsolete frontend after an app update, so only enable the PWA
  // cache in an actual web browser.
  if (!isDesktop() && !isNative() && "serviceWorker" in navigator && location.protocol === "https:") {
    // Rescue a device pinned to a stale cache. When an UPDATED worker takes
    // control (its cache name now carries the new version, so it purged the old
    // one on activate), reload ONCE to drop any poisoned chunks the dead page
    // was holding — this is what unsticks the "__wbindgen_is_object requires a
    // callable" reports after a bad release. Guarded so a first-ever install
    // (no prior controller) never triggers a reload.
    const hadController = !!navigator.serviceWorker.controller;
    let reloaded = false;
    navigator.serviceWorker.addEventListener("controllerchange", () => {
      if (hadController && !reloaded) {
        reloaded = true;
        location.reload();
      }
    });
    void navigator.serviceWorker.register("/sw.js").catch(() => {});
  }
}

// A rejected boot() used to leave the index.html splash animating forever with
// nothing to read — the same "white screen" the old-engine guard there exists
// to prevent. The usual cause is site storage being blocked, which makes the
// first localStorage access throw; say so in plain text, the way that guard does.
boot().catch((err: unknown) => {
  console.error("wallet boot failed:", err);
  const el = document.querySelector(".boot");
  if (!el) return; // React already mounted; its own Boundary owns the screen now
  const box = document.createElement("div");
  box.style.cssText = "max-width:420px;padding:24px;text-align:center;color:#f6f6f8;";
  const mark = document.createElement("div");
  mark.style.cssText = "font-size:24px;font-weight:700;margin-bottom:12px;";
  mark.textContent = "ZKas";
  const what = document.createElement("p");
  what.style.cssText = "color:#b9b9c6;line-height:1.5;";
  what.textContent = i18n.t("bootGuard.couldNotStart", { host: location.hostname || i18n.t("bootGuard.thisSite") });
  const why = document.createElement("p");
  why.style.cssText = "color:#7a7a8c;line-height:1.5;font-size:12px;word-break:break-all;";
  why.textContent = String((err as Error)?.message ?? err);
  box.append(mark, what, why);
  el.replaceChildren(box);
});
