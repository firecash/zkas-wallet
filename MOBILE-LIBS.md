# Native mobile libraries for ZKas — a plan

## What exists today, and what does not

The SDK ships **TypeScript bindings only** (`sdk/bindings/typescript`). There is no
Swift, no Kotlin, no UniFFI definition, no JNI.

The core is Rust and is the right core — but the claim that it "already compiles
for mobile" is false, and was checked rather than assumed. `cargo check -p
zkas-signer --target aarch64-linux-android` **fails**:

    error occurred in cc-rs: failed to find tool "aarch64-linux-android-clang"
    error: failed to run custom build command for `blake3 v1.8.3`

Three facts came out of that check, and the blocker is now fixed.

**1. `blake3` was the only thing standing in the way — and it is one line.** It
reached the signer through `zkas-signer → kaspa-shielded-core → kaspa-seq-commit →
kaspa-merkle → kaspa-hashes → blake3`, and compiles C/SIMD by default. blake3
ships a `pure` feature (pure Rust, no C). Declaring it in `sdk/signer/Cargo.toml`
turns it on across the graph, because cargo features are additive:

    [target.'cfg(any(target_os = "android", target_os = "ios"))'.dependencies]
    blake3 = { version = "1", default-features = false, features = ["pure", "std"] }

Scoped to mobile deliberately: `pure` trades assembly for portable Rust, which is
the right trade on a phone doing a few hashes per signature and the WRONG trade on
a node, where blake3 throughput matters. With that in place, **`cargo check`
passes for `aarch64-linux-android` and `aarch64-apple-ios`, and the host build is
unchanged** — all three verified. No NDK is needed to compile; the toolchains are
still needed later to LINK a `cdylib`.

**2. `wasm-bindgen` is an unconditional dependency of `kaspa-hashes`,** and it is
not trivially removable: `kaspa-hashes/src/lib.rs` uses `use
wasm_bindgen::prelude::*` and `#[wasm_bindgen]` attributes without any
`cfg(target_arch = "wasm32")` guard. Gating the dependency means gating those
attributes in a crate the whole node depends on, and re-running the node suite. It
costs 9 crates of browser plumbing in a native build — dead weight that compiles
fine. An optimization, not a blocker, and not one to slip into a mobile branch.

**3. The tree is 221 crates for Android.** Heavy for a signing library, but not
because of proving: `shielded-core` keeps `circuit` opt-in, so Halo 2 is already
out. The weight is hashing and serialization arriving via `kaspa-hashes`.

Our own Android app is not a counter-example — it is a WebView running the same
React app with the signer compiled to WASM. Mobile support today means *an app*,
not *a library*.

## What the library must contain

The wallet's device-half is small and already bounded. `zkas-signer` is the core:

    Signer::new(seed: [u8; 32])
    .address_bytes()
    .full_viewing_key()
    .sign_message(domain, message)
    .verify_and_sign(...)        // anti-blind payment authorization

`firecash-signer` adds the parts a wallet needs around it: recovery-phrase
generation, ZIP-32 account derivation (`m/32'/111111'/account'`), address
encoding, and hex plumbing — eleven functions in total. That set is the library.

## What it must NOT contain: proving

Keep Halo 2 proving on the daemon. This is not a shortcut, it is the correct split
for a phone: proving costs **~0.79 core-seconds per note spent** (measured
2026-07-28), so a ten-note payment is ~8 core-seconds of sustained CPU. The
protocol already accounts for this — the daemon builds the proof, and the device
verifies the bundle pays exactly what was intended and only then signs. The device
half is cheap; the expensive half is already somewhere sensible.

A native library therefore needs the signing half plus an HTTP client for
`/api/wallet/watch`, `/prepare`, `/submit`.

## Binding technology: UniFFI

One interface definition yields **both** Swift and Kotlin, with memory management,
error types and async handled for us. The alternative — hand-rolled `extern "C"`
plus cbindgen, then separate Swift and JNI shims — is two hand-written unsafe
layers to keep in step, for a wallet, where a mistake is somebody's money.

## The two risks that actually matter

### 1. Divergence from the WASM implementation

If the native library derives even one byte differently, an integrator's users get
addresses nobody can spend from. This is the risk that decides whether the project
is safe, so it is handled first and mechanically:

- A shared **test-vector file** — phrases, accounts, expected keys, addresses,
  viewing keys and signatures — committed once and executed by the Rust tests, the
  WASM tests, the Swift tests and the Kotlin tests.
- Vectors generated from the CURRENT wallet, so they encode shipped behaviour
  rather than intended behaviour.
- The existing `check:signer` genesis guard ported into the library, so a build
  pointed at the wrong network fails loudly instead of deriving plausible
  addresses on the wrong chain.

### 2. Key handling across the FFI

The present API takes `seed_hex: &str` everywhere, which is right for WASM and
wrong for a phone: platform strings are immutable, copied freely, and never
zeroized, so the spending key ends up in several places the app cannot clean up.

The native API should instead:

- take the key **once**, as bytes, into a `Signer` object (which is what
  `zkas-signer::new` already does) and zeroize on drop;
- expose **`verifyAndSignPayment`, not raw spend-auth signing**. The anti-blind
  check is the security property of the whole protocol; a binding that exposes the
  raw signature call invites an integrator to blind-sign whatever the daemon sent.
  If the raw call is exposed at all it needs a name that says so.
- document that the key belongs in **Keychain / Keystore**, and never in
  `UserDefaults`, `SharedPreferences` or a file.

## Phases

**0 — Make it build at all. DONE.** blake3 `pure`, scoped to mobile targets;
`cargo check` verified green for `aarch64-linux-android` and `aarch64-apple-ios`,
host build unchanged. Still outstanding from this phase: the NDK and Xcode
toolchains for LINKING a `cdylib`, and optionally gating `wasm-bindgen` out of
`kaspa-hashes` (9 crates of dead weight, needs code changes plus the node suite).

**1 — Test vectors.** Generate from the current signer; wire into the existing
Rust and WASM test runs. Nothing else can be trusted without them.

**2 — `zkas-mobile` crate.** A thin UniFFI wrapper over `zkas-signer` plus the
derivation helpers from `firecash-signer`. No new cryptography — it re-exports what
already ships. Rust tests run the shared vectors.

**3 — Swift package.** XCFramework for `aarch64-apple-ios` and the simulator
targets, distributed via SwiftPM. Swift tests run the same vectors.

**4 — Android package.** AAR for `arm64-v8a` and `x86_64`, via Maven or JitPack.
Kotlin tests run the same vectors.

**5 — A worked example per platform.** Not a README snippet: a small app that
creates a wallet, registers the viewing key, prepares a payment, verifies and
signs it on-device, and submits. This is what proves the split is usable, and it
is where the API's rough edges surface.

**6 — Documentation.** The protocol, not just the function list: what the daemon
learns (the viewing key: every amount and memo, forever), what it cannot do
(spend), and why the device verifies before signing.

## Open decisions

- **Does the library include the HTTP client, or only signing?** Including it makes
  the example trivial and the dependency heavier; excluding it means every
  integrator writes the same three calls, and some will get the verify step wrong.
  Recommendation: include a thin, optional client behind a feature flag.
- **Which is the first target?** Doing both at once doubles the unknowns. iOS is
  the better first move: we do not ship an iOS app, so there is no alternative for
  those users today, and Keychain gives the key storage the web cannot.
- **Published where?** SwiftPM and Maven need a public repo and a release process
  the wallet's own release script does not currently cover.
