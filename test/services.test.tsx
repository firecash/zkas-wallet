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
    expect(screen.getByRole("button", { name: "Use 3" })).toHaveClass("active");
    expect(screen.getAllByRole("article")).toHaveLength(3);
    await user.click(screen.getByRole("button", { name: "All 11" }));
    expect(screen.getAllByRole("article")).toHaveLength(11);
  });

  it("filters in place and honours a linked category", async () => {
    const user = userEvent.setup();
    const view = mount();
    await user.click(screen.getByRole("button", { name: "Earn 2" }));
    expect(screen.getAllByRole("article")).toHaveLength(2);

    view.unmount();
    mount("/services?filter=store");
    expect(screen.getAllByRole("article")).toHaveLength(3);
    expect(screen.getByRole("button", { name: "Store 3" })).toHaveClass("active");
  });
});
