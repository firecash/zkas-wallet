import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { describe, expect, it } from "vitest";

import { Services } from "../src/pages/Services";

function mount(path = "/services") {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Routes><Route path="/services" element={<Services />} /></Routes>
    </MemoryRouter>,
  );
}

describe("services directory", () => {
  it("opens on wallet-use services without an intro or search bar", async () => {
    const user = userEvent.setup();
    mount();
    expect(screen.queryByText("Use the network")).not.toBeInTheDocument();
    expect(screen.queryByRole("searchbox")).not.toBeInTheDocument();
    expect(screen.getByRole("group", { name: "Filter services" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Use 1" })).toHaveClass("active");
    expect(screen.getAllByRole("article")).toHaveLength(1);
    await user.click(screen.getByRole("button", { name: "All 13" }));
    expect(screen.getAllByRole("article")).toHaveLength(13);
  });

  // The landing category is chosen for the user, and the directory it filters is
  // remotely updatable — so a directory with nothing in that category must show
  // the whole list, not an empty page the user reads as a broken app.
  it("never opens on an empty category", () => {
    localStorage.setItem("zkas_services_directory_v1", JSON.stringify({
      schema_version: 1,
      updated_at: "2026-08-10T00:00:00Z",
      services: [{
        id: "core-source", name: "Core Source", description: "Source for node, consensus and wallet.",
        categories: ["build"], status: "Live", tags: ["Rust"], action: "View repository",
        href: "https://github.com/firecash/zkas-rusty", icon: "git",
      }],
    }));
    try {
      mount();
      expect(screen.getByRole("button", { name: "Use 0" })).not.toHaveClass("active");
      expect(screen.getByRole("button", { name: "All 1" })).toHaveClass("active");
      expect(screen.queryByText("No matching services.")).not.toBeInTheDocument();
      expect(screen.getAllByRole("article")).toHaveLength(1);
    } finally {
      localStorage.removeItem("zkas_services_directory_v1");
    }
  });

  it("filters in place and honours a linked category", async () => {
    const user = userEvent.setup();
    const view = mount();
    await user.click(screen.getByRole("button", { name: "Earn 2" }));
    expect(screen.getAllByRole("article")).toHaveLength(2);

    view.unmount();
    mount("/services?filter=store");
    expect(screen.getAllByRole("article")).toHaveLength(4);
    expect(screen.getByRole("button", { name: "Store 4" })).toHaveClass("active");
  });
});
