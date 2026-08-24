// Regression guard for the mobile Settings tab.
//
// React Router's hash history navigates with history.pushState, which fires NO
// hashchange event. A wallet that learned its route by listening on window
// hashchange therefore never saw a nav tap — Settings lit up and the wallet
// carried on showing History. Answering that with a raw history.replaceState
// made it worse: the router still believed it was on /settings, so tapping
// Settings became a no-op until reload. Both halves are pinned here.

import { describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { HashRouter, Routes, Route, useLocation, useNavigate } from "react-router-dom";
import { WalletRoute } from "../src/WalletRoute";
import { useHashRouterSync } from "../src/hashsync";

// Stand in for the real wallet: report the route props, and offer the two moves
// a user can make from inside it.
vi.mock("../src/App", () => ({
  default: ({ routeTab, routeSticky, onClearRoute }: {
    routeTab?: string | null; routeSticky?: boolean; onClearRoute?: () => void;
  }) => (
    <div>
      <span data-testid="routeTab">{routeTab ?? "none"}</span>
      <span data-testid="sticky">{String(!!routeSticky)}</span>
      <button onClick={() => onClearRoute?.()}>leave settings</button>
    </div>
  ),
}));

// Mirrors the nav in AppShell: it drives navigation and highlights from the
// router's own location, which is what makes a stale router state visible.
function Nav() {
  const navigate = useNavigate();
  const location = useLocation();
  useHashRouterSync();
  return (
    <div>
      <span data-testid="path">{location.pathname}</span>
      {["/", "/settings"].map((p) => (
        <button key={p} data-testid={`nav${p}`} aria-current={location.pathname === p ? "page" : undefined}
          onClick={() => navigate(p)}>{p}</button>
      ))}
    </div>
  );
}

function mount() {
  return render(
    <HashRouter>
      <Nav />
      <Routes>
        <Route path="/" element={<WalletRoute />} />
        <Route path="/settings" element={<WalletRoute />} />
      </Routes>
    </HashRouter>,
  );
}

describe("settings route", () => {
  it("does not rely on hashchange, which a nav tap never fires", async () => {
    const onHashChange = vi.fn();
    window.addEventListener("hashchange", onHashChange);
    try {
      mount();
      await userEvent.click(await screen.findByTestId("nav/settings"));
      expect(await screen.findByTestId("path")).toHaveTextContent("/settings");
      // The whole reason the route travels as a prop.
      expect(onHashChange).not.toHaveBeenCalled();
    } finally {
      window.removeEventListener("hashchange", onHashChange);
    }
  });

  it("hands /settings to the wallet as a sticky route", async () => {
    mount();
    await userEvent.click(await screen.findByTestId("nav/settings"));
    expect(await screen.findByTestId("routeTab")).toHaveTextContent("settings");
    expect(screen.getByTestId("sticky")).toHaveTextContent("true");
  });

  it("leaving settings moves the router, so the nav follows and Settings stays tappable", async () => {
    mount();
    await userEvent.click(await screen.findByTestId("nav/settings"));
    expect(await screen.findByTestId("path")).toHaveTextContent("/settings");

    // Switching to another wallet tab clears the route from inside the wallet.
    await userEvent.click(screen.getByText("leave settings"));
    expect(await screen.findByTestId("path")).toHaveTextContent("/");
    // The router really moved: the nav un-highlights Settings...
    expect(screen.getByTestId("nav/settings")).not.toHaveAttribute("aria-current");
    // ...and Settings can be opened again without a reload. A raw replaceState
    // would have left the router on /settings, making this click do nothing.
    await userEvent.click(screen.getByTestId("nav/settings"));
    expect(await screen.findByTestId("routeTab")).toHaveTextContent("settings");
  });

  it("goes stale if the URL is rewritten behind the router's back", async () => {
    // This is the shipped bug, reproduced. history.replaceState fires neither
    // popstate nor hashchange, and hash history only listens for popstate — so
    // the router never learns it left /settings. Kept as a standing warning
    // against "just rewrite the hash" fixes.
    mount();
    await userEvent.click(await screen.findByTestId("nav/settings"));
    expect(await screen.findByTestId("path")).toHaveTextContent("/settings");

    history.replaceState(null, "", `${window.location.pathname}#/`);
    expect(window.location.hash).toBe("#/");
    // URL says "/", router still says "/settings": the nav stays lit on the
    // wrong tab, and navigate("/settings") is now a no-op.
    expect(screen.getByTestId("path")).toHaveTextContent("/settings");
    expect(screen.getByTestId("nav/settings")).toHaveAttribute("aria-current", "page");
  });

  it("treats ?tab= as a one-shot quick action and consumes it", async () => {
    window.location.hash = "#/?tab=send";
    mount();
    expect(await screen.findByTestId("routeTab")).toHaveTextContent("send");
    expect(screen.getByTestId("sticky")).toHaveTextContent("false");
  });
});

// Deep links (zkas: URIs, notification taps) and the What's New card sit outside
// the router and move the app by writing location.hash. useHashRouterSync turns
// that into a real navigate.
//
// Caveat, so nobody over-trusts these: react-router's hash history computes its
// location from window.location.hash on every render, so under jsdom the tree
// often converges even with the sync disabled. These pin the end behaviour, not
// the hook in isolation — the hook is what guarantees the router is NOTIFIED,
// which is what App's deleted hashchange listener used to provide.
describe("direct location.hash writes", () => {
  it("pulls the router to a hash written from outside it", async () => {
    mount();
    expect(await screen.findByTestId("path")).toHaveTextContent("/");

    window.location.hash = "#/settings";
    await screen.findByTestId("path");
    await waitFor(() => expect(screen.getByTestId("path")).toHaveTextContent("/settings"));
    // The route reached the wallet, and the nav agrees with the URL.
    expect(screen.getByTestId("routeTab")).toHaveTextContent("settings");
    expect(screen.getByTestId("nav/settings")).toHaveAttribute("aria-current", "page");
  });

  it("applies a quick action written as a hash, then consumes it", async () => {
    mount();
    await screen.findByTestId("path");

    // What's New opens settings this way.
    window.location.hash = "#/?tab=send";
    await waitFor(() => expect(screen.getByTestId("routeTab")).toHaveTextContent("send"));
    expect(screen.getByTestId("sticky")).toHaveTextContent("false");
  });
});
