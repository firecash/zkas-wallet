import { Component, lazy, StrictMode, Suspense, useEffect, useMemo, useState, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { HashRouter, Routes, Route, Navigate, Outlet, useLocation, useNavigate } from "react-router-dom";
import { Blocks, HardDrive, LayoutGrid, Pickaxe, Server, WalletCards } from "lucide-react";
import { LockScreen } from "./LockScreen";
import { AppLockScreen } from "./AppLockScreen";
import { installAutoLock, isLockEnabled, isUnlocked } from "./applock";
import { ToastHost } from "./toast";
import { applyStoredTheme } from "./theme";
import { initDesktop, isDesktop, vaultStatus } from "./desktop";
import { FirstRunNode, needsNodeChoice, markNodeChoiceMade } from "./FirstRunNode";
import { FirstRunConnect } from "./FirstRunConnect";
import { WhatsNew, shouldShowWhatsNew } from "./WhatsNew";
import { BootLoader } from "./components/BootLoader";
import { listWallets } from "./wallets";
import { isNative, loadStatusCache } from "./api";
import { internalRouteFromLink, queuePaymentLink } from "./paymentlinks";
import "./styles.css";

// Every tool page used to ship in the first JavaScript download, including QR,
// explorer, service-directory and mining code a user may never open. Load a
// route when it is selected so the wallet itself reaches first paint sooner.
const WalletApp = lazy(() => import("./App"));
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
      <Suspense fallback={<BootLoader label="Opening…" />}>
        <Routes>
          <Route element={<AppShell />}>
            <Route path="/" element={<WalletApp />} />
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
  const navigate = useNavigate();
  const location = useLocation();
  const desktop = isDesktop();
  const android = isNative() && (globalThis as { Capacitor?: { getPlatform?: () => string } }).Capacitor?.getPlatform?.() === "android";
  const servicesTheme = location.pathname.startsWith("/services");
  const pages = useMemo(() => [
    { path: "/", label: "Wallet", icon: WalletCards },
    ...(desktop ? [{ path: "/node", label: "Node", icon: Server }] : []),
    { path: "/mine", label: "Mine", icon: Pickaxe },
    { path: "/explore", label: "Explore", icon: Blocks },
    { path: "/services", label: "Services", icon: LayoutGrid },
    ...(desktop ? [{ path: "/self-host", label: "Host", icon: HardDrive }] : []),
  ], [android, desktop]);
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
      <nav className="app-switcher" aria-label="Main">
        <div className="app-nav-bar">
          <button className="app-wordmark" onClick={() => navigate("/")} aria-label="ZKAS wallet home">
            <span>Z</span>KAS
          </button>
          <div className="app-page-links">
            {pages.map((page, index) => {
              const active = location.pathname === page.path || (page.path === "/explore" && location.pathname.startsWith("/explore/"));
              const Icon = page.icon;
              return <button key={page.path} title={`${page.label}${desktop ? ` · Ctrl+${index + 1}` : ""}`} aria-current={active ? "page" : undefined} className={active ? "active" : ""} onClick={() => navigate(page.path)}><Icon aria-hidden="true" size={18} strokeWidth={1.8} /><span className="app-nav-label">{page.label}</span></button>;
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
          <h2 style={{ marginTop: 0 }}>Something went wrong</h2>
          <p className="muted small">
            The wallet display hit an error. Your wallet and funds are not affected — reloading almost always fixes
            this.
          </p>
          <p className="muted small mono" style={{ wordBreak: "break-all" }}>
            {String(this.state.err)}
          </p>
          <button className="btn" onClick={() => location.reload()}>
            Reload wallet
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
  if (!locked) await initDesktop().catch(() => null);

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
  const hasWalletHistory =
    listWallets().length > 0 || !!loadStatusCache() || !!localStorage.getItem("wallet_token");
  if (hasWalletHistory && needsNodeChoice()) markNodeChoiceMade();
  const askNode = needsNodeChoice() && (isDesktop() || isNative());
  // Existing users skip first-run, so announce the new connection/privacy/theme
  // features once via a "what's new" popup instead.
  const whatsNew = shouldShowWhatsNew(hasWalletHistory);

  // Dark is the identity and the only theme now (light was dropped). Clear any
  // stored light/system preference so an early adopter is not stuck on it.
  try { localStorage.removeItem("theme"); } catch { /* ignore */ }
  applyStoredTheme();

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
    }).catch(() => {});
  }
  // Installable web app with an OFFLINE UI shell. The service worker explicitly
  // excludes every wallet/chain API, so offline never means showing cached money.
  // Native bundles ship their assets with the application and already have a
  // native background worker. A browser service worker inside Capacitor can
  // retain an obsolete frontend after an app update, so only enable the PWA
  // cache in an actual web browser.
  if (!isDesktop() && !isNative() && "serviceWorker" in navigator && location.protocol === "https:") {
    void navigator.serviceWorker.register("/sw.js").catch(() => {});
  }
}

boot();
