# FireCash mobile wallet

The FireCash wallet ships as a native **iOS + Android** app by wrapping the exact same
static SPA that serves [wallet.firecash.info](https://wallet.firecash.info) with
[**Capacitor**](https://capacitorjs.com/). One codebase, three targets (web, Android, iOS).

The web bundle in `dist/` is loaded locally on the device and talks to a
`firecash-walletd` over HTTPS. On native platforms it defaults to the hosted daemon
(`https://wallet.firecash.info/daemon`) because a device-local bundle has no same-origin
`/daemon` to proxy to (see `src/api.ts`); a self-hoster can override the daemon URL in the
app just like on the web.

## Build the app

Native builds need the platform SDKs, so they run on a dev machine — **not** in CI-lite
or a headless server:

- **Android:** Android Studio + SDK (any OS)
- **iOS:** macOS + Xcode

```bash
npm install                       # pulls in @capacitor/* (added to package.json)

# one-time: generate the native project(s)
npm run mobile:add:android        # → ./android  (git-ignored)
npm run mobile:add:ios            # → ./ios      (macOS only)

# build the web bundle, copy it in, and open the native IDE
npm run mobile:android            # build + cap sync + open Android Studio
npm run mobile:ios                # build + cap sync + open Xcode
```

From Android Studio / Xcode you can run on a simulator/device and produce a signed
`.apk` / `.aab` / `.ipa` for the stores. `npm run mobile:sync` just re-copies a fresh
web build into the existing native projects.

The `android/` and `ios/` folders are **generated** and git-ignored — regenerate them
with `npx cap add`. App identity lives in `capacitor.config.ts` (`appId:
com.firecash.wallet`).

## Custody today vs. the non-custodial roadmap

Right now the mobile app inherits the **web wallet's custody model**: it points at a
hosted `firecash-walletd` that holds the seed. That is convenient (zero-config) but the
server can spend. A self-hoster who runs their own daemon is already fully non-custodial.

The goal for mobile is **the server cannot spend, ever** — the seed lives on the phone.
This is possible on a shielded chain because Orchard splits a spend into two independent
steps (`shielded-core/src/wallet.rs`):

1. **prove** — the heavy Halo 2 proof, built from only the **full viewing key (FVK)**. No
   spend authority.
2. **sign** — one small RedPallas `spend_auth_sig` per note, the **only** step that needs
   `ask` (derived from the seed).

`ask` cannot be derived from the FVK, so whoever proves cannot sign, and whoever signs
need not prove. orchard 0.14 exposes this as a first-class **PCZT** pipeline
(`orchard::pczt` — `prover` → `signer` → `finalizer`/`extractor`), where
`Action::sign(sighash, ask, rng)` signs an arbitrary 32-byte sighash using the action's
stored randomizer. FireCash's wire format already has the exact injection seam: the
`to_wire(bundle, spend_auth_sig_closure, …)` function in `shielded-core`.

### Route A — hybrid (ship first): phone signs, server proves

```
Phone (holds seed)                        Server (walletd, FVK only — cannot spend)
------------------                        -----------------------------------------
seed → FVK, ask
register FVK  ──────────────────────────► watch-only: scan, track notes + witnesses
"send X"      ──────────────────────────► build_for_pczt + create_proof (no ask)
sign(sighash, ask) per note  ◄─────────── proven PCZT + our sighash
submit signed  ─────────────────────────► inject sigs via to_wire → relay to node
```

- **Server cannot steal** (never holds `ask`); a server hack leaks *viewing* keys, not coins.
- **Phone stays light** — key derivation + one signature per note. No Halo 2 prover on the
  device, no multi-MB download, no multi-second freeze. Best mobile UX.
- **Honest tradeoff:** the server sees the FVK, so it can *watch* balances/history — a
  **privacy** loss, not a **custody** loss. Closed by Route B.

### Route B — full local (gold standard): phone proves + signs

Compile `shielded-core` **with** the `circuit` feature to `wasm32`: keygen + scan +
witness + prove + sign, all on the device. Seed never leaves the phone and the server
degrades to a dumb, untrusted light-server (serve tree frontier / submit tx). Fully
private **and** non-custodial. Costs: large WASM (Halo 2 prover), seconds-long proofs on
phone, proving params cached once. Feasible today (Zcash's WebZjs does in-browser Orchard
proving). Prereq shared with everything else: the O(N)-per-note witness rebuild must
become O(log N) via a `bridgetree`.

**Plan:** ship Route A to kill custody risk with a light client, then invest in Route B
for full privacy. The staged implementation (shielded-core split + `firecash-signer`
WASM + walletd `prepare`/`submit` endpoints + on-device key storage) is tracked in the
core repo's `docs/NON_CUSTODIAL_WALLET.md`.
