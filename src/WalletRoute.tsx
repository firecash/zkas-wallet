import { lazy, useCallback } from "react";
import { useLocation, useNavigate } from "react-router-dom";

// Split from the explorer, service-directory and mining code a user may never
// open, so the wallet itself reaches first paint sooner.
const WalletApp = lazy(() => import("./App"));

/// The wallet is mounted on two routes: "/" (optionally carrying a ?tab= quick
/// action) and "/settings" (the mobile nav item).
///
/// React Router's hash history navigates with history.pushState, which fires NO
/// hashchange event — so a nav tap is invisible to any window.location listener.
/// The route therefore has to be handed down as a prop, and the wallet has to
/// leave it through navigate() rather than a raw history.replaceState, or the
/// router keeps believing we are on /settings: the nav stays lit on the wrong
/// tab and tapping Settings becomes a no-op until the app is reloaded.
export function WalletRoute() {
  const location = useLocation();
  const navigate = useNavigate();
  const sticky = location.pathname === "/settings";
  const quick = new URLSearchParams(location.search).get("tab");
  const clear = useCallback(() => navigate("/", { replace: true }), [navigate]);
  return <WalletApp routeTab={sticky ? "settings" : quick} routeSticky={sticky} onClearRoute={clear} />;
}
