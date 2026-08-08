# ZKas mobile wallet

The ZKas wallet ships as a native **Android + iOS** app that wraps the same static SPA
serving [wallet.zkas.info](https://wallet.zkas.info), via
[**Capacitor**](https://capacitorjs.com/). One codebase, three targets (web, Android, iOS).

**The app is non-custodial.** The seed is generated on the device, in WebAssembly, and is never
sent anywhere. The daemon is registered with the wallet's **full viewing key** only: it can sync
the wallet and build spend *proofs*, but it holds no spend authority and cannot move the funds —
a compromised server leaks *visibility*, never coins. See
[Custody](#custody-how-the-server-is-kept-powerless).

## Build

The Android build runs headless on Linux — no Android Studio needed (`scripts/build-android.sh`
drives the SDK directly). iOS still needs macOS + Xcode.

```bash
npm install

# refresh both committed native projects after frontend/plugin changes
npm run mobile:sync

./scripts/build-android.sh          # debug APK       → android/app/build/outputs/apk/debug/
./scripts/build-android.sh release  # signed APK+AAB  → .../apk/release/, .../bundle/release/
npm run mobile:ios                  # build + cap sync + open Xcode
```

Toolchain the script expects (override with env vars): JDK 17 at `JAVA_HOME`, Android SDK
(platform 34, build-tools 34) at `ANDROID_HOME`.

**Release signing** reads a properties file kept **outside the repo** (`FC_SIGNING_PROPS`,
default `/root/work/.android-signing`):

```
FC_KEYSTORE=/path/firecash-release.jks
FC_KEYSTORE_PASS=…
FC_KEY_ALIAS=firecash
FC_KEY_PASS=…
```

The keystore itself is never committed. **Back it up offline** — Android identifies an app by its
signing key, so losing it means no user can ever install an update over their existing install.

App identity lives in `capacitor.config.ts` (`appId: com.firecash.wallet`); version lives in
`android/app/build.gradle` (`versionCode` / `versionName`).

## Custody: how the server is kept powerless

A shielded spend splits into two independent steps, and only the second needs spend authority
(`shielded-core/src/wallet.rs`):

1. **prove** — the heavy Halo 2 proof, built from the **full viewing key (FVK)** alone.
2. **sign** — one small RedPallas `spend_auth_sig` per note: the only step that needs `ask`,
   which is derived from the seed.

`ask` cannot be derived from the FVK, so whoever proves cannot sign. The app puts each step where
it belongs:

```
Phone (holds the seed)                      Daemon (FVK only — cannot spend)
----------------------                      --------------------------------
seed → FVK, ask   (WASM, on device)
POST /api/wallet/watch  {fvk}   ──────────► watch-only wallet: scans, balance, witnesses
POST /api/wallet/prepare {fvk,to,amt} ────► builds the Halo 2 proof; returns the sighash and
                                            one spend randomizer (alpha) per note
sign(sighash, ask.randomize(alpha))
POST /api/wallet/submit {sigs}  ──────────► injects the signatures, broadcasts to the node
```

The daemon refuses every spend path for such a wallet (`/send`, `/consolidate`, `/sign`,
`/reveal` → **403**): it has no seed to spend with. Verified end-to-end on mainnet — a
watch-only-registered wallet spent 1 ZKAS in tx
`35dd94a1d8d20d8b19e1b70531f105736071876945f04b2028d5b97fdeff43ff`, signed on the device.

**Honest tradeoff:** the daemon sees the FVK, so it can *watch* your balance and history — a
**privacy** cost, not a **custody** one. Run your own `zkas-walletd` (override the daemon URL
in the app) and even that goes away. Closing it for hosted users needs in-browser Halo 2 proving
(large WASM, seconds-long proofs on a phone) — feasible (Zcash's WebZjs does it), and gated behind
the same `bridgetree` work as the O(log N) witness rebuild.

The installed Android and iOS apps may connect directly to `http://<LAN-IP>:8501`. This is
intentional for a private network where a public TLS certificate is normally unavailable. The
hosted web wallet requires HTTPS and rejects a cleartext walletd URL before trying to connect.

The **Local** tab is fully offline: generate a cold wallet, derive an address, sign and verify
messages, with no daemon at all.

## Notes for native

- The WebView's origin (`https://localhost` on Android, `capacitor://localhost` on iOS) is what the
  daemon must allow through CORS — walletd's `--allow-origin` list carries both. Without them every
  request from the app fails, with no visible error but a permanently empty balance.
- The `firecash-signer` WASM is **base64-inlined** into the JS bundle, so it loads with no network
  fetch and works offline and under the `capacitor://` scheme.
- On native there is no same-origin `/daemon` to proxy to, so `src/api.ts` defaults to the hosted
  daemon's absolute URL. A self-hoster overrides it in the app.
- iOS uses CSS safe-area insets with Capacitor's native content inset disabled, avoiding doubled
  top/bottom spacing on notched phones and iPad split view.
- The responsive shell uses five large bottom actions on phones. Desktop-only Node and Host
  controls never consume mobile navigation space; narrow desktop windows retain a scrollable top bar.
- `zkas:` and `firecash:` links open a pre-filled Send screen. Android also accepts shared payment
  text and launcher shortcuts; iOS uses the same routes through Capacitor's URL bridge.
- The browser PWA caches only static UI assets. Capacitor does not register that service worker,
  preventing an installed native update from reopening an obsolete web bundle.

## Background sync (Android, opt-in)

Settings → **Background sync** registers a `WorkManager` periodic wake (~every 15 min, network
required — the platform minimum) implemented in `android/.../BackgroundSyncPlugin.java` +
`SyncWorker.java`, toggled from `src/bgsync.ts`. Each wake does ONE `GET /api/status`:

- it **touches** the wallet, so the daemon keeps its scan caught up (walletd only actively syncs
  wallets a client touched recently — this is what makes the next app open instant), and
- it compares balance + pending-in against the last value and posts a **local notification** when
  a payment arrived (channel `payments`; Android 13+ notification permission is requested when the
  feature is turned on, and a denial just keeps the sync silent).

No key material is involved — the worker holds only the wallet token (the same read credential the
app uses) against a watch-only daemon. The first wake records a baseline and announces nothing, so
enabling it never fires a "you received your entire balance" notification. Wallet switches and
daemon-URL changes reload the app, and the boot path re-points the worker at the active wallet.

The optional Android home widget reads that same last-synced balance from local preferences. It
does not contact walletd itself and contains no key. If the saved value is missing or corrupt it
shows “Open to sync” instead of crashing the launcher.
