# zkas-wallet

A lightweight web **and mobile** wallet for
**[ZKas](https://github.com/firecash/zkas-rusty)** — the private-by-default network
combining GHOSTDAG/kHeavyHash with Orchard/Halo 2. Create a wallet, receive to a shielded
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
> strongest guarantee use the **desktop app** or the Android app in **Run on this
> phone** mode: both run `zkas-walletd` *inside the app*, so no server ever sees even
> your viewing key — or self-host the daemon, or keep funds in a **paper wallet**
> (cold). See [Custody model](#custody-model).

This is a static React + Vite single-page app. It is a thin UI over a
**[`zkas-walletd`](https://github.com/firecash/zkas-rusty)** daemon, which scans the
chain, builds Orchard proofs, and submits transactions. Where that daemon runs is the
whole trust model: on our server (hosted web, hosted mobile), on your own server
(self-hosted), or **inside the app on your own device** (desktop, and Android with
*Run on this phone*). The seed is generated and kept on your device in every mode.

## Features

- **Create / import** a shielded wallet from a 32-byte recovery seed, with a one-time
  seed-backup step.
- **Receive** — shows your `zkas:` shielded address and a QR code.
- **Send** — private Orchard payments; amount in ZKAS, optional fee.
- **Balance & sync** — live balance, note count, and scan progress, polled every few seconds.
- **Sign / verify** — prove control of an address without spending (viewing-key disclosure).
- **Self-hosted or hosted** — point it at your own local daemon for full non-custodiality,
  or use the hosted daemon with a per-browser wallet token.
- **All-in-one desktop** — install and supervise a local ZKas node, run direct
  ZKAS or KAS+ZKAS mining, connect an ASIC, and inspect live service logs/status.
- **In-app network explorer** — live BlockDAG/network/privacy data and block/transaction
  details without pretending shielded addresses have public balances.
- **Payments** — amount/memo request QR, POS mode, private transaction labels,
  accounting export, and guarded self-hosted batch/consolidation tools.
- **Platform integration** — desktop tray/start-on-boot, mobile payment links,
  Android shortcuts/widget/background notifications, and a safe offline PWA shell.

## Custody model

The wallet talks to a daemon at a configurable base URL (`Daemon:` line in the footer,
overridable in the UI):

| Mode | Where `zkas-walletd` runs | Who holds the seed | What a third party learns |
|---|---|---|---|
| **Desktop** (Tauri app) | **inside the app**, on a random loopback port with a per-install token; syncs from the public node or a node the app installs and supervises | **only your machine** | nothing about your wallet — the node only serves blocks (it sees your IP; point the app at your own node or Tor and not even that) |
| **Mobile — Run on this phone** (Android, opt-in) | **inside the app**: the same daemon as a native library (`zkas-walletd-mobile`), trial-decrypting on the phone; syncs from the public node or yours, optionally over Tor via Orbot | **only your phone** | same as desktop: no daemon anywhere sees your keys, balance or history. A foreground notification keeps the sync alive while it runs |
| **Mobile — hosted** (Android, default) | `zkas-walletd` on our server, reached over HTTPS or the Tor onion | **only your phone** — the server gets the viewing key | the server can see balance and history (privacy cost); it **cannot spend** |
| **Hosted web** (wallet.zkas.info) | same-origin `/daemon` → `zkas-walletd` on the server | **only your browser** — the server gets the viewing key | same as hosted mobile, plus the inherent "you trust the page code served each visit" risk of any website |
| **Self-hosted web** | your own **HTTPS** walletd endpoint | **only your machine/server** | whatever you run it on; the hosted HTTPS page cannot connect to a cleartext HTTP service — use an installed app for HTTP on a LAN |
| **Paper** (cold) | none | **you, offline** | nothing; derive an address and receive with no daemon at all, import the seed later to spend |

**Spending is the same in every mode.** A payment is built and *proved* from the viewing
key, then *signed* on the device that holds the seed; the daemon, wherever it runs, can
never authorize a spend. The modes differ only in **who can watch**: with the daemon on
your own device, nobody.

To go self-hosted, run `zkas-walletd` locally (see the
[core repo](https://github.com/firecash/zkas-rusty#zkas-walletd--wallet-daemon-rest-powers-the-web-wallet))
and select it from the connection control. Use HTTPS from the web wallet; the installed
mobile app may use `http://<LAN-IP>:8501`. Desktop already runs walletd over private loopback HTTP
and accepts custom chain-node endpoints as `host:port`.

> **🔑 Two guarantees, pick your level.** *Custody* is solved in every mode by Orchard's
> split: **prove** needs only the viewing key, **sign** needs the spend key, so the device
> signs and a daemon holding the viewing key can never spend (live and verified on mainnet;
> see [`MOBILE.md`](./MOBILE.md) and the core repo's `docs/NON_CUSTODIAL_WALLET.md`).
> *Privacy* is solved by running the daemon on your own device: the **desktop** app always
> does, and the Android app does in **Run on this phone** mode — then no server holds your
> viewing key, and the public node it syncs from learns only your IP (or nothing, over Tor
> or against your own node). The hosted service stays the zero-setup default; its only cost
> is that our server can see your balance and history.

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

## All-in-one desktop

The desktop application has seven focused pages: **Wallet**, **Node**, **Mine**,
**Explore**, **Services**, **Pay** and **Host**. A beginner can install pinned, SHA-256-verified node/mining components
from the UI; no binary paths or command-line flags are required. Advanced users
can use existing ZKas and Kaspa gRPC nodes instead.

### First launch

The desktop builds are **ad-hoc signed on macOS and not notarized**, and the Windows
and Linux builds carry **no code signature** at all (there is no Apple Developer or
Authenticode certificate in the pipeline yet). Every OS therefore warns once on first
launch; the release is what you verify, not the signature:

- **macOS** — the first open says *"Apple could not verify…"*. Click **Done**, then
  open **System Settings → Privacy & Security**, scroll to the *Security* section and
  click **Open Anyway** next to ZKas Wallet, then confirm. (On macOS 15 the old
  right-click → Open shortcut no longer bypasses this; the Settings route is the only
  one.) If the app was quarantined by a download manager instead of Safari, `xattr -d
  com.apple.quarantine "/Applications/ZKas Wallet.app"` clears it.
- **Windows** — SmartScreen shows *"Windows protected your PC"*. Click **More info**,
  then **Run anyway**. The installer name and version are shown on that panel; check
  them against the release page.
- **Linux** — `.AppImage`: `chmod +x` it and run; `.deb`: `sudo apt install ./<file>.deb`.
  No prompt, but nothing is verified either.

Download only from the [GitHub release page](https://github.com/firecash/zkas-wallet/releases);
with no notarization or Authenticode, the download origin is the only provenance a
desktop build has today.

The managed port layout deliberately keeps both chains separate: ZKas RPC/P2P is
`16810/16811`, Kaspa parent RPC/P2P is `16110/16111`, and local ASIC Stratum is
`5555` by default. RPC binds to loopback even when inbound P2P is enabled. See
[`planfront2.txt`](./planfront2.txt) for the complete implementation, platform
matrix, security rules and verified release sources.

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
| `POST` | `/api/wallet/send-many` | self-hosted batch payout |
| `POST` | `/api/wallet/consolidate` | self-hosted note consolidation |
| `POST` | `/api/wallet/watch` | register a viewing-key-only device wallet |
| `POST` | `/api/wallet/prepare` | prepare/prove a device-signed payment |
| `POST` | `/api/wallet/submit` | submit device signatures and broadcast |
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
- The page is served under a strict **Content-Security-Policy** (`default-src 'none'`;
  `script-src 'self' 'wasm-unsafe-eval'` + one hashed inline bootstrap; `connect-src`
  same-origin + the services host + the price feed + localhost), so an injected script
  can neither run nor exfiltrate the seed to another host. The policy is enforced at the
  web host (nginx) and its canonical copy lives in this repo at
  [`deploy/wallet-sec.conf`](deploy/wallet-sec.conf) so it can be reviewed and diffed
  here. The one risk a website can't fully remove is the server serving tampered code —
  for that, prefer the desktop/mobile app (a fixed build you install once; note the
  desktop builds are ad-hoc signed / unsigned, not notarized — see *First launch* above)
  or self-host.
- `zkas-walletd` is hardened: CORS is locked to `--allow-origin`, the wallet token is
  required, and any seed it does hold (self-host / legacy) can be encrypted at rest with
  `--wallet-secret`. Always launch it with the exact origin you serve this app from.
- Never paste your recovery seed into any site other than a wallet daemon you trust.

## Integrate ZKAS into your own wallet

Building an existing wallet, exchange, or point-of-sale and want to add ZKAS
receive/view/send? You don't need to reimplement any cryptography — the on-device
`zkas-signer` (WASM), the `@zkas/sdk` TypeScript client, and the keyless `zkas-walletd`
daemon give you a **fully non-custodial** integration where the seed never leaves the
device. See the developer guide:

- **[`docs/INTEGRATION.md`](./docs/INTEGRATION.md)** — integration tiers (receive →
  watch-only → non-custodial spend → fully local), the address format and units, the
  key model, the signer and REST APIs, copy-paste send recipes, and the security rules
  that keep a hosted daemon powerless.

## Related repositories

- **[zkas-rusty](https://github.com/firecash/zkas-rusty)** — node, miner,
  `zkas-walletd`, explorer API
- **[firecash-explorer](https://github.com/firecash/zkas-explorer)** — block explorer SPA
- **[firecash-pool](https://github.com/firecash/zkas-pool)** — stratum mining pool

## Tech

React 19 · TypeScript · Vite · Tauri 2 · `qrcode`. No analytics. Network calls are
limited to the selected wallet/node services, pinned component downloads and
read-only chain data.

## License

ISC — inherits the rusty-kaspa license. See [`LICENSE`](./LICENSE).
