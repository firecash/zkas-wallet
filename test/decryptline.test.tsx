import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import { DecryptLine } from "../src/AppLockScreen";

afterEach(cleanup);

// The unlock screen's status line. It is bound to the REAL decryption: while
// Argon2 is running nothing settles, and only when the seed is actually open does
// the text resolve. A line that resolved on a timer would be theatre.
describe("unlock status line", () => {
  it("shows the plain words when the device asks for reduced motion", () => {
    vi.stubGlobal("matchMedia", () => ({ matches: true, addEventListener() {}, removeEventListener() {} }));
    render(<DecryptLine text="Decrypting your wallet" active resolve={false} />);
    expect(screen.getByText("Decrypting your wallet")).toBeTruthy();
    vi.unstubAllGlobals();
  });

  it("renders the words verbatim when it is not active", () => {
    render(<DecryptLine text="Decrypted" active={false} resolve={false} />);
    expect(screen.getByText("Decrypted")).toBeTruthy();
  });
});
