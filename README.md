# firecash-wallet

A lightweight web **and mobile** wallet for
**[FireCash](https://github.com/firecash/firecash-rusty)** — the private-by-default,
shielded (Orchard / Halo 2) rusty-kaspa fork. Create a wallet, receive to a shielded
address, and send private payments straight from the browser or a native iOS/Android app.

**Live:** https://wallet.firecash.info · **Mobile:** see [`MOBILE.md`](./MOBILE.md)

This is a static React + Vite single-page app. It holds no keys itself — it is a thin
UI over a **[`firecash-walletd`](https://github.com/firecash/firecash-rusty)** daemon,
which owns the seed, scans the chain, builds Orchard proofs, and submits transactions.

## Features

- **Create / import** a shielded wallet from a 32-byte recovery seed, with a one-time
  seed-backup step.
- **Receive** — shows your `firecash:` shielded address and a QR code.
- **Send** — private Orchard payments; amount in `$firecash`, optional fee.
- **Balance & sync** — live balance, note count, and scan progress, polled every few seconds.
- **Sign / verify** — prove control of an address without spending (viewing-key disclosure).
- **Self-hosted or hosted** — point it at your own local daemon for full non-custodiality,
  or use the hosted daemon with a per-browser wallet token.

## Custody model

The wallet talks to a daemon at a configurable base URL (`Daemon:` line in the footer,
overridable in the UI):

| Mode | Daemon | Who holds the seed | Notes |
|---|---|---|---|
| **Hosted** (default) | same-origin `/<origin>/daemon` → `firecash-walletd` on the server | the hosted daemon, keyed by a **random per-browser token** | zero-install; clearing browser storage loses the token — restore from seed |
| **Self-hosted** | your own `http://127.0.0.1:8501` | **only your machine** | fully non-custodial; the seed never leaves localhost |
| **Mobile** (native app) | hosted daemon by default, or your own | same as the mode you point it at | Capacitor wrap of this SPA — see [`MOBILE.md`](./MOBILE.md) |

To go self-hosted, run `firecash-walletd` locally (see the
[core repo](https://github.com/firecash/firecash-rusty#firecash-walletd--wallet-daemon-rest-powers-the-web-wallet))
and set the daemon URL to `http://127.0.0.1:8501`.

> **🔑 Non-custodial roadmap.** In the default hosted mode the daemon holds the seed and
> *can* spend — convenient, but trusted. The seed never has to be on the server: Orchard
> splits a spend into **prove** (needs only the viewing key) and **sign** (the only step
> that needs the spend key). We are moving the seed onto the device so the server proves
> but **cannot** spend (Route A), then to fully local prove+sign (Route B). Details and
> status in [`MOBILE.md`](./MOBILE.md) and the core repo's `docs/NON_CUSTODIAL_WALLET.md`.

> **⚠️ Testnet.** FireCash is currently a test network — coins have no value and the chain
> may be reset. Your **recovery seed is the only way to restore a wallet**: back it up offline.

## Quick start (development)

```bash
npm install
npm run dev      # Vite dev server (default http://localhost:5173)
```

You need a reachable `firecash-walletd`. For local development, run one and allow the
dev origin:

```bash
firecash-walletd --network mainnet --rpc-server 127.0.0.1:16110 \
  --wallet-dir ./fc-wallets --listen 127.0.0.1:8501 \
  --allow-origin http://localhost:5173
```

Then set the daemon URL in the app footer to `http://127.0.0.1:8501`.

## Build & deploy

```bash
npm run build    # type-checks (tsc -b) then emits a static bundle to dist/
```

`dist/` is a fully static site — serve it from any web server / CDN. The hosted
deployment serves `dist/` and reverse-proxies `/daemon/` to `firecash-walletd`.

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

- Today the seed is generated and stored **by the daemon**, never by this page. In
  self-hosted mode it never leaves your machine; in hosted mode the daemon is trusted.
  The [non-custodial roadmap](#custody-model) moves the seed onto the device so even the
  hosted server cannot spend.
- `firecash-walletd` is hardened: CORS is locked to `--allow-origin`, the wallet token is
  required, and seeds can be encrypted at rest with `--wallet-secret`. Always launch it
  with the exact origin you serve this app from.
- Never paste your recovery seed into any site other than a wallet daemon you trust.

## Related repositories

- **[firecash-rusty](https://github.com/firecash/firecash-rusty)** — node, miner,
  `firecash-walletd`, explorer API
- **[firecash-explorer](https://github.com/firecash/firecash-explorer)** — block explorer SPA
- **[firecash-pool](https://github.com/firecash/firecash-pool)** — stratum mining pool

## Tech

React 19 · TypeScript · Vite · `qrcode`. No key material, no analytics, no external calls
beyond your chosen daemon.

## License

ISC — inherits the rusty-kaspa license. See [`LICENSE`](./LICENSE).
