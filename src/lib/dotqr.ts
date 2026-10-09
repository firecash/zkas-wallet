// The receive code, drawn rather than rasterised.
//
// `QRCode.toDataURL` paints black squares onto a canvas and hands back a PNG. We
// draw the same matrix ourselves as circular dots with ring-and-dot finder
// patterns — the shape Vizor uses — which is the single most-looked-at object in
// the wallet and the one that most makes a receive screen look finished.
//
// THE CONSTRAINT, measured, not assumed: dot radius must be at least half a
// module. A first version at 0.42 — dots with visible gaps, which looks better —
// rendered beautifully and DID NOT DECODE, at 220px or at 440px. At 0.5 (dots
// exactly one module across, touching at their edges) it decoded at every size
// tried: 120, 140, 160, 180, 200, 220 and 440px. 120px is far below anything we
// render, so there is real margin. The spaced-dot look is simply not available.
//
// The ring finders are not the risk: swept against square finders they behaved
// identically at every radius. A 1-module-thick ring at 3-module radius with a
// 1.5-module centre reads across the middle as dark-light-dark-light-dark in
// about 1:1:3:1:1 — the standard finder ratio. Those numbers are functional.
//
// Cheaper than what it replaces, too: this is string building, where toDataURL
// rasterises a canvas (measured at ~363ms of a 500ms Receive tap on a slow phone).
import QRCode from "qrcode";

/** Below this the dots stop touching and decoders start failing. Do not lower it. */
const MIN_RADIUS = 0.5;

export function dotQrSvg(
  text: string,
  { size = 440, margin = 2, dark = "#000", bg = "#fff", radius = MIN_RADIUS } = {},
): string {
  const qr = QRCode.create(text, { errorCorrectionLevel: "M" });
  const n = qr.modules.size;
  const data = qr.modules.data;
  const total = n + margin * 2;
  const m = size / total;
  const rr = m * Math.max(radius, MIN_RADIUS);
  // The three finder patterns are drawn as rings, so their modules are skipped here.
  const inFinder = (r: number, c: number) =>
    (r < 7 && c < 7) || (r < 7 && c >= n - 7) || (r >= n - 7 && c < 7);

  let dots = "";
  for (let r = 0; r < n; r++) {
    for (let c = 0; c < n; c++) {
      if (!data[r * n + c] || inFinder(r, c)) continue;
      const cx = (c + margin + 0.5) * m;
      const cy = (r + margin + 0.5) * m;
      // One sub-path per dot, all in a single <path>: ~1300 <circle> nodes would
      // be its own performance problem on a slow Android.
      dots +=
        `M${(cx - rr).toFixed(2)} ${cy.toFixed(2)}` +
        `a${rr.toFixed(2)} ${rr.toFixed(2)} 0 1 0 ${(rr * 2).toFixed(2)} 0` +
        `a${rr.toFixed(2)} ${rr.toFixed(2)} 0 1 0 ${(-rr * 2).toFixed(2)} 0`;
    }
  }

  let finders = "";
  for (const [fr, fc] of [[0, 0], [0, n - 7], [n - 7, 0]]) {
    const cx = (fc + margin + 3.5) * m;
    const cy = (fr + margin + 3.5) * m;
    finders +=
      `<circle cx="${cx.toFixed(2)}" cy="${cy.toFixed(2)}" r="${(m * 3).toFixed(2)}" fill="none" stroke="${dark}" stroke-width="${m.toFixed(2)}"/>` +
      `<circle cx="${cx.toFixed(2)}" cy="${cy.toFixed(2)}" r="${(m * 1.5).toFixed(2)}" fill="${dark}"/>`;
  }

  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">` +
    `<rect width="${size}" height="${size}" rx="${(size * 0.045).toFixed(1)}" fill="${bg}"/>` +
    `<path d="${dots}" fill="${dark}"/>${finders}</svg>`
  );
}

/** The same thing as a data URI, so it drops straight into an existing `<img src>`. */
export function dotQrDataUrl(text: string, opts?: Parameters<typeof dotQrSvg>[1]): string {
  return "data:image/svg+xml;base64," + btoa(dotQrSvg(text, opts));
}
