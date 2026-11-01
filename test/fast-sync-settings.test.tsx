// Settings -> Fast sync must actually take effect, not only be stored: while the wallet runs on
// this phone the engine reads the setting at start, so Apply restarts it with the new choice.
import { describe, expect, it, beforeEach, vi } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";

const ensureEmbedded = vi.fn(async () => "http://127.0.0.1:18990");
let chosen = false;
vi.mock("../src/embedded", async (orig) => {
  const actual = await orig<typeof import("../src/embedded")>();
  return { ...actual, embeddedChosen: () => chosen, ensureEmbedded: (...a: unknown[]) => ensureEmbedded(...(a as [])) };
});

import "../src/i18n";
import { FastSyncSettings } from "../src/FastSyncSettings";
import { embeddedChainFilesUrl, embeddedFastSync } from "../src/embedded";

beforeEach(() => {
  localStorage.clear();
  ensureEmbedded.mockClear();
  chosen = false;
});

describe("Settings -> Fast sync", () => {
  it("restarts the running engine with a new address", async () => {
    chosen = true;
    render(<FastSyncSettings />);
    fireEvent.change(screen.getByLabelText("Fast sync address"), { target: { value: "https://mirror.example/chain" } });
    fireEvent.click(screen.getByRole("button", { name: "Apply" }));
    await waitFor(() => expect(ensureEmbedded).toHaveBeenCalledWith(undefined, undefined, true, { on: true, url: "https://mirror.example/chain" }));
    expect(await screen.findByText(/restarted with this setting/)).toBeInTheDocument();
  });

  it("stores the choice for the next start when the wallet does not run on this phone", async () => {
    render(<FastSyncSettings />);
    fireEvent.click(screen.getByRole("checkbox"));
    fireEvent.click(screen.getByRole("button", { name: "Apply" }));
    await screen.findByText(/next time the wallet runs on this phone/);
    expect(ensureEmbedded).not.toHaveBeenCalled();
    expect(embeddedFastSync()).toBe(false);
  });

  it("refuses an address that is not http(s), and keeps nothing", () => {
    render(<FastSyncSettings />);
    fireEvent.change(screen.getByLabelText("Fast sync address"), { target: { value: "ftp://nope" } });
    expect(screen.getByRole("button", { name: "Apply" })).toBeDisabled();
    expect(screen.getByText("Enter an https:// address.")).toBeInTheDocument();
    expect(embeddedChainFilesUrl()).toBe("");
  });
});
