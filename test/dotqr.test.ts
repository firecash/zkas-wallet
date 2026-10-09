import { describe, it, expect } from "vitest";
import QRCode from "qrcode";
import { dotQrSvg } from "../src/lib/dotqr";

const ADDR = "zkas:p8ydxzxc72s72kpw6kwu3ezpnf6m4pzfeylxykg77mt4rh5ypzmszslmq9mt40588jj3yxgmm279x9n";

// This is the code people point a camera at to send money, so the properties that
// keep it scannable are pinned here. Decoding itself is verified in a real browser
// with jsqr (scratchpad/qr) — jsdom cannot rasterise an SVG, and a decoder is not
// worth a new dependency.
describe("the drawn receive QR is faithful to the matrix", () => {
  it("draws exactly one dot per dark module outside the finders", () => {
    const qr = QRCode.create(ADDR, { errorCorrectionLevel: "M" });
    const n = qr.modules.size;
    const data = qr.modules.data;
    const inFinder = (r: number, c: number) =>
      (r < 7 && c < 7) || (r < 7 && c >= n - 7) || (r >= n - 7 && c < 7);
    let expected = 0;
    for (let r = 0; r < n; r++)
      for (let c = 0; c < n; c++) if (data[r * n + c] && !inFinder(r, c)) expected++;

    const svg = dotQrSvg(ADDR, { size: 440, margin: 2 });
    // one "M" sub-path per dot
    const drawn = (svg.match(/M[\d.]+ [\d.]+a/g) ?? []).length;
    expect(drawn).toBe(expected);
    // three ring finders = six circles
    expect((svg.match(/<circle /g) ?? []).length).toBe(6);
  });

  // A first version used radius 0.42 — dots with visible gaps, which looks better —
  // and did NOT decode at any size. The floor is clamped rather than merely
  // documented, so no caller can reintroduce an unscannable code.
  it("clamps the dot radius to the decodable floor", () => {
    const risky = dotQrSvg(ADDR, { size: 440, margin: 2, radius: 0.1 });
    const safe = dotQrSvg(ADDR, { size: 440, margin: 2 });
    const radiusOf = (s: string) => s.match(/a([\d.]+) /)?.[1];
    expect(radiusOf(risky)).toBe(radiusOf(safe));
  });

  it("round-trips a payment URI and a view key, not just an address", () => {
    for (const text of [`${ADDR}?amount=1.5&memo=hi`, "ab".repeat(48)]) {
      expect(() => dotQrSvg(text, { size: 440, margin: 2 })).not.toThrow();
    }
  });
});
