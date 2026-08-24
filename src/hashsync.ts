import { useEffect } from "react";
import { useLocation, useNavigate } from "react-router-dom";

/// Keeps the router in step with direct `location.hash` writes.
///
/// Deep links and the What's New card live OUTSIDE the router, so they move the
/// app by assigning location.hash. That fires hashchange — an event react-router's
/// hash history does not listen for (it handles popstate only, and drives its own
/// state when navigate() calls pushState). Without this the URL and the router
/// drift apart: the nav highlights the wrong page, route props go stale, and a
/// later navigate() to that path silently does nothing because the router already
/// believes it is there.
export function useHashRouterSync(): void {
  const navigate = useNavigate();
  const location = useLocation();
  const here = `${location.pathname}${location.search}`;
  useEffect(() => {
    const sync = () => {
      const target = window.location.hash.replace(/^#/, "") || "/";
      if (target !== here) navigate(target, { replace: true });
    };
    window.addEventListener("hashchange", sync);
    return () => window.removeEventListener("hashchange", sync);
  }, [navigate, here]);
}
