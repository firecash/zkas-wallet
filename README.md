# zkas-wallet

A lightweight web **and mobile** wallet for
**[ZKas](https://github.com/firecash/zkas-rusty)** — the private-by-default,
shielded (Orchard / Halo 2) rusty-kaspa fork. Create a wallet, receive to a shielded
address, and send private payments straight from the browser, the desktop app, or the
native Android app.

**Live:** https://wallet.zkas.info · **Mobile:** see [`MOBILE.md`](./MOBILE.md)

> **⚠️ The hosted web wallet is non-custodial, but not bulletproof.** The daemon
> **cannot spend your funds** — your seed is generated in your browser, only the
> *viewing* key is sent to the server, and every spend is signed on your device
> (the server proves, the phone/browser signs). A malicious server can refuse
> service or watch your balance, but it **cannot move a coin**. What it *could* do
> is serve tampered page code that reads your seed out of browser storage — so a
> strict Content-Security-Policy is enforced, but the residual "you trust the code
> the server hands you each visit" risk is inherent to any website. For the
> strongest guarantee, run your own daemon (self-hosted), use the desktop or mobile
> app (fixed, signed code), or keep funds in a **paper wallet** (cold). See
> [Custody model](#custody-model).

This is a static React + Vite single-page app. It holds no keys itself — it is a thin
UI over a **[`zkas-walletd`](https://github.com/firecash/zkas-rusty)** daemon,
which owns the seed, scans the chain, builds Orchard proofs, and submits transactions.

## Features

- **Create / import** a shielded wallet from a 32-byte recovery seed, with a one-time
  seed-backup step.
- **Receive** — shows your `zkas:` shielded address and a QR code.
- **Send** — private Orchard payments; amount in ZKAS, optional fee.
- **Balance & sync** — live balance, note count, and scan progress, polled every few seconds.
- **Sign / verify** — prove control of an address without spending (viewing-key disclosure).
- **Self-hosted or hosted** — point it at your own local daemon for full non-custodiality,
  or use the hosted daemon with a per-browser wallet token.

## Custody model

The wallet talks to a daemon at a configurable base URL (`Daemon:` line in the footer,
overridable in the UI):

| Mode | Daemon | Who holds the seed | Notes |
|---|---|---|---|
| **Hosted web** (default) | same-origin `/<origin>/daemon` → `zkas-walletd` on the server | **only your browser** — the daemon gets the viewing key, not the seed | non-custodial: the seed is generated in-browser and the device signs, so the daemon **cannot spend**. Residual risk is the served page code (mitigated by a strict CSP) and the seed sitting in browser storage — back it up and clear storage loses nothing but the local copy |
| **Self-hosted web** | your own `http://127.0.0.1:8501` | **only your machine** | fully non-custodial; the seed never leaves localhost |
| **Desktop** (Tauri app) | an **embedded** `zkas-walletd`, on a random loopback port with a per-install token | **only your machine** | fully non-custodial; seed files live in the OS app-data dir and are decrypted at load by a passphrase that is never written. mac / Linux / Windows |
| **Mobile** (Android app) | hosted or your own — either way **watch-only** | **only your device** | non-custodial: the seed is generated on-device (WebAssembly) and the daemon is registered with the **full viewing key only**, so it can watch and build proofs but **cannot sign or spend**. See [`MOBILE.md`](./MOBILE.md) |
| **Paper** (cold) | none | **you, offline** | derive an address and receive with no daemon at all; import the seed later to spend |

To go self-hosted, run `zkas-walletd` locally (see the
[core repo](https://github.com/firecash/zkas-rusty#zkas-walletd--wallet-daemon-rest-powers-the-web-wallet))
and set the daemon URL to `http://127.0.0.1:8501`.

> **🔑 Keeping the server powerless.** Only the **hosted web default** trusts a remote daemon
> with the seed. Everywhere else the seed stays with you: the web **Local** tab runs the
> [`zkas-signer`](https://github.com/firecash/zkas-signer) in your browser (WebAssembly) to
> generate a cold wallet, derive an address and sign/verify **without the seed leaving your
> device**; the **desktop** app runs its own loopback daemon; and the **mobile** app is fully
> non-custodial via Orchard's split — **prove** needs only the viewing key, **sign** needs the
> spend key, so the phone signs and the daemon (viewing key only) can never spend. This is live
> and verified on mainnet — details in [`MOBILE.md`](./MOBILE.md) and the core repo's
> `docs/NON_CUSTODIAL_WALLET.md`. The remaining cost of a hosted daemon is **privacy** (it sees
> your viewing key), not **custody**.

> **⚠️ Mainnet.** ZKas is live on mainnet. Your **recovery seed is the only way to
> restore a wallet**: back it up offline.

## Quick start (development)

```bash
npm install
npm run dev      # Vite dev server (default http://localhost:5173)
```

You need a reachable `zkas-walletd`. For local development, run one and allow the
dev origin:

```bash
zkas-walletd --network mainnet --rpc-server 127.0.0.1:16110 \
  --wallet-dir ./fc-wallets --listen 127.0.0.1:8501 \
  --allow-origin http://localhost:5173
```

Then set the daemon URL in the app footer to `http://127.0.0.1:8501`.

## Build & deploy

```bash
npm run build    # type-checks (tsc -b) then emits a static bundle to dist/
```

`dist/` is a fully static site — serve it from any web server / CDN. The hosted
deployment serves `dist/` and reverse-proxies `/daemon/` to `zkas-walletd`.

## Configuration

Both settings live in the browser (`localStorage`), managed from the UI:

- `walletd_base` — daemon base URL (default: `<origin>/daemon`, or `http://127.0.0.1:8501`
  outside a browser).
- `wallet_token` — a random 16-byte hex token, sent as `X-Wallet-Token`, selecting this
  browser's wallet on the daemon. Generated on first load; **back up your seed**, not this token.

## Daemon API used

Requests carry `X-Wallet-Token`. See `src/api.ts` for the typed client.

| Method | Path | Purpose |
|---|---|---|
| `GET`  | `/api/status` | wallet + node + sync status |
| `GET`  | `/api/wallet/balance` | balance + notes |
| `POST` | `/api/wallet/create` | create a new wallet (returns seed once) |
| `GET`  | `/api/wallet/reveal` | reveal the recovery seed |
| `POST` | `/api/wallet/import` | import from seed (`seed_hex`, optional `birthday`) |
| `POST` | `/api/wallet/send` | send (`to`, `amount_fc`, optional `fee`) |
| `POST` | `/api/wallet/sign` | sign a message |
| `POST` | `/api/verify` | verify a signature |

## Security notes

- The seed is generated **in your browser** (the `zkas-signer` WASM), stored locally,
  and **never sent to the daemon** — the daemon only receives the *viewing* key. Every
  spend is checked and signed on-device: the device recomputes each output note's
  commitment from the server's disclosure, refuses any output that isn't to your
  recipient or your own change, caps the fee, and signs a sighash it recomputes itself.
  So a compromised daemon **cannot move funds or trick you into signing** — the worst it
  can do is stop serving or watch your balance. (Legacy wallets created under the old
  hosted model still have their seed on the daemon until they are restored to a device.)
- The page enforces a strict **Content-Security-Policy** (`script-src 'self'` + the WASM
  and one hashed inline bootstrap; `connect-src` same-origin + localhost only), so an
  injected script can neither run nor exfiltrate the seed to another host. The one risk a
  website can't fully remove is the server serving tampered code — for that, prefer the
  desktop/mobile app (fixed, signed builds) or self-host.
- `zkas-walletd` is hardened: CORS is locked to `--allow-origin`, the wallet token is
  required, and any seed it does hold (self-host / legacy) can be encrypted at rest with
  `--wallet-secret`. Always launch it with the exact origin you serve this app from.
- Never paste your recovery seed into any site other than a wallet daemon you trust.

## Related repositories

- **[zkas-rusty](https://github.com/firecash/zkas-rusty)** — node, miner,
  `zkas-walletd`, explorer API
- **[firecash-explorer](https://github.com/firecash/zkas-explorer)** — block explorer SPA
- **[firecash-pool](https://github.com/firecash/zkas-pool)** — stratum mining pool

## Tech

React 19 · TypeScript · Vite · `qrcode`. No key material, no analytics, no external calls
beyond your chosen daemon.

## License

ISC — inherits the rusty-kaspa license. See [`LICENSE`](./LICENSE).
