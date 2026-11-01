// Classic script (parses in any engine): probes the features the wallet needs and, when one is
// missing, replaces the splash with what to do. Served from the page's own origin, so the CSP
// needs no inline hash for it — an inline copy drifted from its hash and was silently blocked.
(function () {
  var ok = false;
  try {
    // No eval-based syntax probe here: it needs CSP 'unsafe-eval', which we
    // do NOT grant (a wallet holding a seed in localStorage must keep the
    // script surface minimal). Any engine with BigInt + WebAssembly +
    // crypto.getRandomValues already supports the es2020 syntax the bundle
    // uses, so these capability checks are a sufficient gate on their own.
    ok =
      typeof BigInt === "function" &&
      typeof WebAssembly === "object" &&
      typeof Promise !== "undefined" &&
      typeof crypto !== "undefined" &&
      typeof crypto.getRandomValues === "function";
  } catch (e) {
    ok = false;
  }
  if (!ok) {
    var el = document.querySelector(".boot");
    if (el) {
      el.innerHTML =
        '<div style="max-width:420px;padding:24px;text-align:center;color:#f6f6f8;">' +
        '<div style="font-size:24px;font-weight:700;margin-bottom:12px;"><span style="color:#19e37d;">Z</span>Kas</div>' +
        '<p style="color:#b9b9c6;line-height:1.5;">This device’s web engine is too old to run the wallet’s cryptography.</p>' +
        '<p style="color:#b9b9c6;line-height:1.5;">On Android, update <b>Android System WebView</b> (and Chrome) in the Play Store, then reopen the app. In a browser, please update it or try another one.</p>' +
        "</div>";
    }
  }
})();
