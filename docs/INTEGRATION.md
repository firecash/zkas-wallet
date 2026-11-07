# Add ZKAS to your product

For developers adding ZKAS to an existing wallet, exchange, payment page or point of sale.
Everything here is what our own light wallet, the hosted service, the OTC desk and the
payment gateway run today; where a feature needs a daemon build of a given date, it says so.

Three ready-made pieces do the cryptography. You write HTTP calls.

| Piece | Role | Where |
|---|---|---|
| **`zkas-signer`** (WASM, and a native library for Android/iOS) | keys on the device: recovery phrase, address, viewing key, and **verify + sign** a payment | [`zkas-group/zkas-signer`](https://zkas.info/code/signer) · prebuilt WASM in this repo at [`src/signer/`](../src/signer) |
| **`@zkas/sdk`** (npm) | typed client: status, watch-only registration, balance, history, the deposit journal, request status, and the whole verified send flow with multi-transaction chunking and progress | [`zkas-group/zkas-sdk`](https://zkas.info/code/sdk) |
| **`zkas-walletd`** | the daemon that scans, proves and broadcasts: hosted by us, self-hosted, or embedded in your app | [`zkas-rusty`](https://zkas.info/code/rusty), [`docs/WALLETD.md`](https://zkas.info/code/rusty/tree/main/docs/WALLETD.md) |

**Trust model in one line.** The daemon holds a **viewing key** (it can watch and build
proofs) and never the spending key; the device re-checks every prepared payment and signs
it, so a hostile daemon can neither redirect funds nor inflate the fee. Run the daemon on
the device and nobody holds even the viewing key.

---

## Where the daemon runs: the four modes

The REST API and the send flow are identical in all four; what differs is who can watch.

| Mode | Daemon | Who holds the viewing key | Sync source | Use it when |
|---|---|---|---|---|
| **Hosted** | ours: `https://wallet.zkas.info/daemon` (Tor: `plqu6zzg5u6lkofv76m3pnnxzbaus6pgs4thced4wejdroi7z7exd6qd.onion`, port 80). Watch-only tokens; custodial endpoints are not for third parties | our server (balance, history, send destinations are visible to it; it cannot spend) | its own node and chain files | zero setup; a web page or an app that cannot ship a native library |
| **Self-hosted** | `zkas-walletd` on your server or next to your node (`--listen 127.0.0.1:8501`, a TLS proxy or `--serve-public` with a pairing QR) | you | your node, plus `--chain-files` for fast restores | exchanges, merchants, pools, power users; see the exchange section of `WALLETD.md` for the launch configuration |
| **On device (Android, iOS, desktop)** | the same daemon as a library in your process: `zkas-walletd-mobile`, or the `zkas_walletd` crate in a Tauri/desktop shell | nobody but the device | any node's gRPC (`host:port`, optionally over a SOCKS proxy), chain files for fast sync | the strongest privacy; our Android *Run on this phone* and the desktop app |
| **In the browser** | a WASM engine (`zkas-wallet-engine`) in a Web Worker; source in this repo at `src/webengine/` | nobody but the browser | signed chain files (`https://zkas.info/shielded-chain` or the CDN) and a small read-only gateway (`https://zkas.info/chain-gateway`: `/tree?block=`, `/tree?below=`, `/blocks?after=`) | a web wallet that must not hand even a viewing key to a server; not packaged as a library yet |

### Chain files: the sync source every mode can use

A *chain file* is one 12-hour segment of the shielded chain (43,200 DAA scores), holding the
compact records a wallet needs (note commitments, nullifiers, ciphertexts), about 8 MB each
at today's volume, with a signed `manifest.json` listing every segment's hash and the tree
frontier at its end. A reader verifies each file against the manifest's signature and the
node before trusting it, so a stale or tampered file can cost time, never correctness.

| Source | Address | Role |
|---|---|---|
| Cloudflare R2 (public bucket) | `https://pub-ae5ed92258b2437e985b69ab9947ef60.r2.dev` | primary; what the apps and the daemon default to |
| zkas.info | `https://zkas.info/shielded-chain` | fallback mirror |
| Your own export | a local directory from `chain_export` (in `zkas-rusty`), run against your archival node | for an exchange or a hosted daemon that must not depend on a CDN |

The daemon's default (`PUBLIC_CHAIN_FILES`) is the two public addresses in that order.

| Mode | How it uses them |
|---|---|
| Self-hosted daemon | `--chain-files DIR,URL[,URL]`; the first start builds the shared tree from them and a restore takes minutes instead of hours. With `--shared-leaf-store`, downloaded segments are kept in `<wallet-dir>/chainfiles-cache/` so each is fetched once |
| On-device engine | the app's *Fast sync* setting (on by default, the CDN as default address; `chain_files_url` overrides it) |
| In the browser | always: the engine syncs from the files and only asks the `chain-gateway` for what files cannot give (the live tree state near the tip and the last pages) |
| Hosted | the daemon reads its own local export |

A wallet far below the oldest published segment is not sent to the files for nothing; it
reads from the node until the files reach it.

Memory and disk of a daemon serving many wallets (hosted or exchange) were measured on
7 November 2026: about 1.2 GB RSS with the shared tree at the tip and a few MB per
resident wallet; checkpoints of a few MB per wallet. `GET /api/admin/memory` on the
daemon's host shows the live breakdown.

---

## Every feature of the reference wallet, and the call behind it

The light wallet in this repo (web at `wallet.zkas.info`, Android, Windows/macOS/Linux
desktop) is built on the same public surface this document describes. This table is the
full inventory from `src/`; anything in it can be reproduced in your product with the
listed call. Device-only features need no daemon at all.

### Wallet and keys

| Feature | How it is built | Your call |
|---|---|---|
| Create wallet | 12-word phrase on the device, account 0 (`src/accounts.ts`) | signer `new_wallet_mnemonic`, `account_seed_hex(phrase, 0)` |
| Add account | next ZIP-32 index under the same phrase; each account is its own wallet token on the daemon | `account_seed_hex(phrase, n)`, then `/watch` with a fresh token |
| Restore | phrase or 64-hex seed, plus the birthday; accounts 1..n re-created from the backup's `accountList` | `is_valid_mnemonic`, `/watch { fvk_hex, birthday }` |
| Encrypted backup file | `SeedBackup` JSON: `{ magic, version, kind: "device-seed", network, birthday, accounts, accountList, saltB64, ivB64, ciphertextB64, createdUnix }`; PBKDF2-SHA256 → AES-256-GCM over the phrase or seed (`src/backup.ts`) | your own, or the same document |
| App lock | one device-wide passphrase sealing every wallet's secret (PBKDF2-SHA256 600k → AES-256-GCM), cleartext only in memory while unlocked (`src/applock.ts`) | device only |
| Viewing key export | `fvk_hex(seed)` shown as text and QR, for a watch-only copy elsewhere | signer only |
| Watch-only wallet | register a viewing key with no seed on the device | `/watch` |

### Receiving

| Feature | How it is built | Your call |
|---|---|---|
| Address + QR | the account's address; a wallet has unlimited diversified ones | `address_from_seed` / `GET /api/wallet/address?index=N` |
| Request an amount | a payment link `zkas:<address>?amount=<ZKAS decimal>&memo=<text>&label=<text>` as QR and copyable text; `memo` and `label` are sanitised before display | emit the same link |
| Scan a link / QR | `parsePaymentUri` (`src/lib/utils.ts`): bare address or address`?amount&memo&label`; a `web+zkas:` prefix is unwrapped (registered protocol handler on the web); Android handles `zkas:`, `firecash:` and `zkas-wallet:` intents | parse the same grammar |
| Incoming payment notice | balance polling on `/api/status`; Android: a WorkManager wake every ~15 min calls `/api/status` and posts a notification when the balance grew (`src/bgsync.ts`, `SyncWorker.java`) | poll `/api/status` or page `/api/wallet/deposits` |
| Home-screen widget (Android) | shows the last balance the app saw; reads nothing itself | device only |
| Memo on received payments | 512-byte UTF-8 Orchard memo field, decrypted by the scan | `history` rows / journal `memo` |

### Sending

| Feature | How it is built | Your call |
|---|---|---|
| Send | prepare → verify on device → sign → submit, chunked for fragmented wallets, one request id per payment (`src/noncustodial.ts`) | the drop-in client or `@zkas/sdk` `send()` |
| Memo on a send | up to 512 bytes UTF-8, encrypted to the recipient | `memo` on `/prepare` or `/send` |
| Send to many | one bundle paying several recipients; custodial daemons only (the app offers it when the daemon holds the seed). The non-custodial prepare pays one recipient per payment | `/api/wallet/send_many` |
| Fee | read from the bundle on device, refused above the ceiling; the daemon's fee follows the relay minimum for the spend count | `maxFeeSompi` |
| Pending list and reconciliation | local record of each send (`src/localtx.ts`) reconciled against `history` and `/requests/<id>`; a lost answer is "possibly paid", never "failed" | same |
| Consolidate | merge many small notes into few, so later sends fit one transaction | `/api/wallet/consolidate` |
| Private sends (opt-in setting) | the send carries no sender-recoverable ciphertext: nobody with the viewing key, including a hosted daemon, can ever read where it went; it does not survive a restore and cannot be proven | `POST /api/wallet/settings { private_sends: true }` |
| Spendability gate | Send enabled on `spend_ready`, catching-up shown from `blocks_behind` | `/api/status` |

### History, proofs and records

| Feature | How it is built | Your call |
|---|---|---|
| History | newest first, received rows with `credits[]` (address index, amount, memo), sent rows with recipient when recoverable | `GET /api/wallet/history?limit=&offset=` |
| CSV export | columns `kind, amount_zkas, fee_zkas, time_utc, daa_score, counterparty, memo, private_label, txid` | your own, from `history` |
| Private labels and contacts | per-wallet, device-only; the only place an address gets a name on a shielded chain (`src/contacts.ts`) | device only |
| Payment proof | `GET /api/wallet/proof?txid=` returns `{ proofs: [{ v, txid, daa, action_index, recipient, value, rseed, memo? }] }`; shared as JSON (memo optional); anyone verifies with `POST /api/proof/verify` (no token), the daemon recomputes the commitment from the chain | same two calls |
| Message signing | `POST /api/wallet/sign { message }` → `{ address, message, signature, note }`; `POST /api/verify` (no wallet) → `{ valid, reason }`. The signature discloses the viewing key: ownership and note detection, never spend authority | same |
| Rescan | from a given DAA score, when a restore used the wrong birthday | `POST /api/wallet/rescan` |

### Sync and services

| Feature | How it is built | Your call |
|---|---|---|
| Hosted / self-hosted / on device / browser | see the four modes above; the app switches between them in Settings | `baseUrl` |
| Pairing with your own daemon | one string carries address, access token and wallet token: `zkas+http://192.168.1.20:8501#token=<access>&wallet=<wallet>&net=mainnet` (secrets in the fragment; `zkas+https` for TLS). The desktop app and `zkas-walletd --serve-public` print it as a QR (`src/pairing.ts`) | emit or parse the same string |
| Carry a scan between services | `POST /api/wallet/scan-receipt` export → `{ receipt, bytes, notes, scannedDaa, anchorLeaves, lowBlock }`, then import on the new daemon → `{ adopted, notes, scannedDaa }`. Holds the wallet's notes and witnesses only, no nullifiers or keys; every note is checked against the named anchor (`src/scanreceipt.ts`) | same |
| Fast sync | chain files (above); Android *Fast sync* setting with a custom address | `--chain-files` / engine setting |
| Tor | the hosted daemon's onion; Android via Orbot's SOCKS (`socks` argument to the engine) | same |
| Warm-up | after opening, the daemon pre-builds witness caches so the first send is fast; `warming` in status | `POST /api/wallet/warm` |
| Status polling | one call, 1 Hz while open | `GET /api/status` |
| Background sync (Android, opt-in) | WorkManager periodic `/api/status`, no key material involved | your scheduler |
| Memory pressure (Android) | `onTrimMemory` → engine `releaseMemory()` | same |
| Keep the daemon honest | the app treats a 5xx HTML page, a timeout on `/submit` and `outcome_unknown` alike: possibly paid | same |

### Beyond the wallet

| Feature | How it is built | Your call |
|---|---|---|
| Explorer (in-app) | `https://wallet.zkas.info/chain` API; the desktop can run a local explorer | public, no token |
| Price | `https://mining-pool.zkas.info/api/otc/price` | public |
| Mining (desktop) | solo or pool, stratum port setting, against the desktop-managed node | the node's gRPC / stratum |
| Node runner (desktop) | downloads and runs the ZKas node (`zkas.info/downloads/node/<ver>/…`), optionally the Kaspa node and the merged-mining bridge | your own process management |
| Chat | Nostr relay at `wss://zkas.info/chat-relay`; identity derived from the wallet's own seed by a separate WASM (`chat-identity` in the signer repo, NIP-06); NIP-17 private messages in NIP-59 gift wraps, NIP-25 reactions, NIP-51 mute lists, NIP-56 reports. No payment key ever touches it | any Nostr client against the same relay |
| Languages | 25 locales under `src/i18n/locales` | your own |
| Diagnostics | redacted log bundle (`src/diag/`) for crash reports; the engine's own `logs()` on Android | device only |

Everything above is reachable in the shipped apps today except where marked desktop-only
or Android-only; the web wallet has no background sync, widget, node or mining.

---

## Keys: recovery phrase or raw seed

The official wallet creates a **12-word recovery phrase** (BIP-39, English word list,
128 bits of entropy, no passphrase). Accounts derive from it with ZIP-32 for Orchard:

```
phrase ──BIP-39 seed (empty passphrase)──▶ m / 32' / 111111' / account'  ──▶ 32-byte spending-key seed
```

- Coin type is **111111**. Account **0** is the wallet the phrase creates; "add account"
  takes the next index, and every account restores from the same twelve words.
- The 32-byte result is what everything downstream consumes: the address, the viewing
  key, signing, and `seed_hex` in `zkas-walletd` (`import`, `reveal`).
- Wallets created before phrases existed hold a **raw 32-byte seed as 64 hex characters**.
  Every function accepts either form; `looksLikeHexSeed()` tells them apart.
- Twelve words, not twenty-four: Orchard keys live on the Pallas curve, whose ~128-bit
  security is what any seed can buy.

Signer functions: `new_wallet_mnemonic(network)` → `{ mnemonic, address }`,
`is_valid_mnemonic(phrase)`, `account_seed_hex(phrase, account)`,
`account_address(phrase, network, account)`; for raw seeds `new_wallet(network)`,
`address_from_seed(seed_hex, network)`, `fvk_hex(seed_hex)`.

Back up the phrase (or the hex seed). The wallet **token** that selects a wallet on a
daemon is not a secret and loses nothing.

---

## Quickstart with the SDK

```bash
npm install @zkas/sdk
# build the signer WASM from https://zkas.info/code/signer (wasm-bindgen, no circuit),
# or copy the prebuilt src/signer/ from this repo.
```

```ts
import { ZKasClient, wasmPaymentSigner, DEFAULT_MAX_FEE_SOMPI, SubmitOutcomeUnknownError } from "@zkas/sdk";
import { generateMnemonicWallet, accountSeedHex, fvkHex, verifyAndSignPayment } from "./signer";

// 1. Keys on the device. The phrase is the secret; store it like any private key.
const { mnemonic, address } = await generateMnemonicWallet("mainnet");
const seedHex = await accountSeedHex(mnemonic, 0);

// 2. A daemon and a wallet token; register the VIEWING KEY, never the seed.
const client = new ZKasClient({ baseUrl: WALLETD_URL, walletToken: perWalletToken, network: "mainnet" });
await client.watch(await fvkHex(seedHex), /* birthday: DAA score at creation */ birthdayDaa);

// 3. State. Amounts are decimal strings: BigInt them. 1 ZKAS = 100_000_000 sompi.
const status = await client.status();           // gate Send on status.spend_ready
const balance = BigInt((await client.balance()).balance_sompi);

// 4. Send: prepare → verify on device → sign → submit, chunked over several
//    transactions when the wallet is fragmented. requestId makes a retry safe.
const signer = wasmPaymentSigner({ seedHex, fvkHex, verifyAndSignPayment });
try {
  const res = await client.send(
    signer,
    { to: "zkas:…", amountSompi: 5_000_000_000n, maxFeeSompi: DEFAULT_MAX_FEE_SOMPI, requestId: withdrawalId },
    (stage, p) => console.log(stage, p),   // preparing | verifying | signing | broadcasting | submitted
  );
  console.log(res.txids, res.feeSompi, res.parts.length);
} catch (e) {
  if (e instanceof SubmitOutcomeUnknownError) {
    // The daemon lost its connection to the node mid-broadcast, or a proxy gave up.
    // The payment MAY have gone out. Keep withdrawalId and retry with the SAME id later:
    // the daemon answers "already sent" if it did, and pays once if it did not.
  }
  throw e;
}
```

`status.spend_ready` is the field to enable Send on, not `synced` (see
[gating](#gate-sending-on-the-wallet-not-on-the-chain)). `status.missing_history` means the
node serving the wallet has pruned part of its history and the balance is a lower bound.

---

## The drop-in client (no SDK)

If you drive the WASM yourself, this is a faithful reduction of our wallet's
`src/noncustodial.ts`. **The checks are the point; do not remove them.**

```ts
// zkas.ts — a self-contained non-custodial ZKAS client.
import { addressFromSeed, fvkHex, verifyAndSignPayment } from "./signer";

export class Zkas {
  constructor(
    private base: string,       // walletd base URL, e.g. https://wallet.example/daemon
    private token: string,      // random 16-byte hex; selects this wallet on the daemon
    private network: "mainnet" | "testnet" = "mainnet",
  ) {}

  private async call<T>(method: string, path: string, body?: unknown): Promise<T> {
    const r = await fetch(this.base + path, {
      method,
      headers: { "X-Wallet-Token": this.token, ...(body ? { "Content-Type": "application/json" } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    const text = await r.text();
    if (!r.ok) {
      const err = new Error(`${path} → HTTP ${r.status}: ${text}`) as Error & { status: number; body: string };
      err.status = r.status; err.body = text;
      throw err;
    }
    return JSON.parse(text) as T;
  }

  address(seedHex: string) { return addressFromSeed(seedHex, this.network); }

  async watch(seedHex: string, birthdayDaa: number) {
    await this.call("POST", "/api/wallet/watch", { fvk_hex: await fvkHex(seedHex), birthday: birthdayDaa });
  }

  balance() { return this.call<{ balance_sompi: string; spendable_sompi: string }>("GET", "/api/wallet/balance"); }

  // prepare → verify on device → sign → submit. One transaction; see the note below for more.
  async send(seedHex: string, to: string, amountSompi: bigint, maxFeeSompi: bigint, requestId: string) {
    const fvk = await fvkHex(seedHex);

    // 1. The daemon builds and PROVES an unsigned bundle from the viewing key. It cannot sign it.
    const prep = await this.call<PrepareResp>("POST", "/api/wallet/prepare", {
      fvk_hex: fvk, to, amount_sompi: amountSompi.toString(), allow_partial: false, request_id: requestId,
    });

    // 2. Refuse a daemon that changed the amount (single-transaction path: remaining must be 0).
    const paid = BigInt(prep.amount_sompi_exact);
    const remaining = BigInt(prep.remaining_sompi_exact ?? "0");
    if (paid !== amountSompi || remaining !== 0n) throw new Error("daemon changed the requested amount; refusing to sign");

    // 3. Refuse an inflated fee before signing (the signer checks it again from the bundle).
    if (BigInt(prep.fee_sompi_exact) > maxFeeSompi) throw new Error("fee above the ceiling; refusing to sign");

    // 4. ON DEVICE: verify the bundle pays `to` exactly this amount with the rest returned as
    //    change, that the fee read from the bundle is within the ceiling, then sign.
    const sigs = await verifyAndSignPayment(
      seedHex, this.network, to.trim(), amountSompi, maxFeeSompi,
      prep.bundle_hex, JSON.stringify(prep.disclosure), JSON.stringify(prep.spend_auth),
    );

    // 5. The daemon applies the signatures and broadcasts. Read the answer table below.
    return this.call<{ txid: string; txids: string[]; amount_sompi_exact: string; fee_sompi_exact: string }>(
      "POST", "/api/wallet/submit", { session: prep.session, sigs });
  }
}

interface PrepareResp {
  session: string; bundle_hex: string;
  amount_sompi_exact: string; fee_sompi_exact: string; remaining_sompi_exact?: string;
  spend_auth: { index: number; alpha: string }[];
  disclosure: { spend_value: number; out_value: number; out_recipient: string; out_rseed: string; rcv: string }[];
}
```

What `/submit` (and `/send`) answer, and what to do:

| Answer | Meaning | Your ledger |
|---|---|---|
| **200** with `txids` | broadcast | record every txid under the request id |
| **409** `already_sent` | this request id already paid (same recipient and amount); the record is in the body | settle from the record; pay nothing |
| **409** `in_progress` | the same request is still being sent | retry later with the same id |
| **400 / 409 / 500 / 503** without `txids` | nothing was sent (bad input, not spend-ready, no node, fee refused) | retry freely |
| **502** with `txids` | a split payment was partly sent | record the listed transactions, finish the rest under a new id |
| **504** `outcome_unknown` with `txid` | the node connection failed mid-broadcast; **possibly paid** | keep the id; retry with the **same** id, never a new one |
| any **5xx HTML page** from a proxy | the proxy gave up on a slow broadcast; possibly paid | same as 504 |

A request id is 1–128 characters and should be your own withdrawal or payment id. The daemon
remembers each broadcast under it for 24 hours across restarts; a reused id for a
*different* recipient or amount is refused, never answered with the old transaction.
`GET /api/wallet/requests/<id>` reports what became of a request whose answer you lost:
`in_progress`, or `sent` with each transaction `landed` (block, depth from the chain's own
acceptance), `pending`, or `returned_or_settled`.

> **Fragmented wallets.** One transaction spends at most 38 notes. A wallet holding many
> small notes (a miner's coinbases, a merchant's many small sales) may need several
> transactions for one payment: pass `allow_partial: true`, read `remaining_sompi_exact`,
> and loop prepare → sign → submit until it is `0`, under request ids `id`, `id.1`, `id.2`…
> Only after the user accepted split delivery, and record each broadcast before surfacing
> any later error. `client.send()` in the SDK does all of this.

---

## Run the daemon on the device

`zkas-walletd-mobile` (in `zkas-group/zkas-signer`, next to `mobile/`) runs the same
`zkas-walletd` inside your process on a loopback port. Everything after that is the REST
API above; only `baseUrl` changes.

| Call | What it does |
|---|---|
| `start(nodeAddr, walletDir, secret?, socks?) -> u16` | binds a free `127.0.0.1` port, runs the daemon in-process, returns the port, **`0` on failure**. Idempotent while running |
| `stop()` | shuts it down (flushes checkpoints first) |
| `port() -> u16` | the live port, `0` when not running |
| `logs()` / `setDebugLogs(bool)` | the daemon's own log buffer, for crash reports |
| `releaseMemory() -> u64` | on a memory warning (`onTrimMemory`): drops the decoded page cache and the witness caches, returns the bytes freed; they rebuild on demand |

`nodeAddr` is any ZKas node's gRPC `host:port`. `socks` routes it through a SOCKS proxy
(how the shipped wallet offers Tor via Orbot). Fast sync: the engine reads published,
signed **chain files** from a CDN instead of asking the node page by page; the shipped app
exposes it as *Fast sync* with the public address as default, and every file is checked
against the node before it is trusted.

```kotlin
val port = start(nodeAddr = "185.147.157.125:16110", walletDir = context.filesDir.resolve("zkas").absolutePath,
                 secret = null, socks = null)            // "127.0.0.1:9050" for Tor
check(port != 0) { "engine failed to start - see logs()" }
val client = ZKasClient(baseUrl = "http://127.0.0.1:$port", network = "mainnet")
```

| Platform | How the engine ships |
|---|---|
| Android | `scripts/build-engine.sh` builds `arm64-v8a`, `armeabi-v7a`, `x86_64` into `jniLibs` and generates the Kotlin bindings. Nothing is published; you build it into your app, against the `zkas-rusty` commit in `ENGINE_PIN` |
| Desktop | the Tauri shell embeds the same `zkas_walletd` lib crate |
| iOS | `ZkasEngine.xcframework` (device arm64, simulator arm64 + x86_64) plus the generated Swift, published at `https://zkas.info/downloads/ios/engine/<version>/` with a `MANIFEST` of revisions and SHA-256s; `scripts/fetch-ios-engine.sh` installs it into `ios/ZkasEngine`, which `ios/App`'s Podfile links. Built on Linux without Xcode (`walletd-mobile/README.md`). Loopback only, no TLS self-hosting |

> **Two mobile libraries, do not mix them up.** `zkas-walletd-mobile` is the *whole daemon*
> (scans, proves, serves REST on loopback; you build it). `zkas-mobile` (`mobile/`) is the
> *device half only*: keys, viewing key, `verifyAndSignPayment`; it deliberately does not
> prove, and it is published for both platforms (AAR `info.zkas:zkas-mobile`, SwiftPM
> `ZkasMobile.xcframework`; see `mobile/README.md`).

> If you generate the bindings yourself: `uniffi-bindgen` reads the full symbol table, so
> build unstripped and strip on the way into `jniLibs`; it exits 0 when it produces nothing,
> so assert the generated file exists.

---

## Gate sending on the wallet, not on the chain

A spend roots at an **anchor**, a past tree state consensus accepts only inside a window:
at least `shielded_anchor_depth` deep (the notes have matured) and at most
`max_shielded_anchor_age` old. On mainnet at 1 BPS that is **600 to 27,000 blue units**.

A wallet still catching up can only anchor at its own scan position; once that is more than
the window behind the tip, every payment it builds is rejected. So:

```ts
const s = await client.status();
// Enable Send on spend_ready, not on synced. spend_ready: a tip is known, no reorg
// repair is in flight, the tree is usable, the anchor is inside the window.
if (!s.spend_ready) showCatchingUp(s.blocks_behind);
if (s.warming) showPreparingForFastSends();       // first payment after opening is slower, not blocked
if (s.missing_history) showBalanceIsALowerBound();
```

If you ask anyway, `/api/wallet/prepare` refuses with **409** and a message naming the gap,
before spending seconds on a proof that cannot land. Show that message; the state clears
when the scan catches up.

---

## Taking deposits as a service (exchange, merchant, pool)

A wallet has one key and **unlimited addresses**: `GET /api/wallet/address?index=N`
returns its N-th diversified address (any index up to 2^64−1; the answer carries
`index_exact`). All of them pay into the same wallet and are found by the same scan;
on chain they are unlinkable; a payment reports the address it was actually paid to.

- **Use the customer id as the index** and never issue an index to two customers.
- **Credit from the deposit journal**, `GET /api/wallet/deposits?after=<seq>`: one
  numbered `credit` event per output that paid the wallet, with `recipient`, `index`
  (the customer id, recovered from the address itself), `amountSompiExact`, `memo`,
  `daaScore`. Store the last `seq` you processed; nothing is skipped however long you
  were away, nothing comes twice; key your ledger on `(txid, i)`. A `memo` event follows
  once the full transaction was read; a `rebuild` event says the wallet is rescanning and
  every credit will be written again.
- Reading history instead: `kind: "received"` rows carry `credits[]` with the same fields.
  One transaction can pay several of your addresses; the row's own amount is their sum
  and its `recipient` is then `null`. Never credit from the row's top-level fields.
- A row or event exists only for a transaction the chain **applied**, at least ~3 minutes
  below the tip. Never credit from block inclusion, a txid lookup or an explorer: a mined
  shielded spend can be dropped by consensus and move nothing.

For withdrawals use `send`/`send_many` with the withdrawal id as `request_id` (or the
prepare/submit loop with a signer), as above. The complete launch guide for a custodial
daemon or a split-key setup, with the exact flags, polling and reconciliation, is the
exchange section of [`WALLETD.md`](https://zkas.info/code/rusty/tree/main/docs/WALLETD.md).

Merchants: the **payment gateway** ([`zkas-payment-gateway`](https://zkas.info/code/gateway))
issues per-invoice addresses, watches the wallet for you and fires signed webhooks;
WooCommerce plugin included. Fulfil only on `confirmed` or `overpaid`.

These need a daemon from `main` of **6 November 2026 or later** (`credits[].index`, the
journal, `/requests/<id>`, exact-amount fields); the hosted daemon has run it since 7 Nov.

---

## Map it onto your wallet

| Our light wallet | What you write | Notes |
|---|---|---|
| `src/signer/index.ts` | your WASM wrapper (or copy ours) | `ensureSigner()` once, then the typed helpers |
| `src/api.ts` | the `call()`/`prepare`/`submit` above | one `X-Wallet-Token` header per wallet; mark `outcome_unknown` and proxy 5xx as unknown, not failed |
| `src/noncustodial.ts` | `Zkas.send()` above, or `@zkas/sdk` | keep the amount and fee checks verbatim; one request id per payment, reused on retry |
| `src/accounts.ts` | phrase → accounts | `account_seed_hex(phrase, n)` |
| per-wallet token | one random 16-byte hex per wallet | selects the wallet; not a secret |
| phrase in device storage | your secure key store | the only thing that must be backed up |

---

## What "ZKAS support" can mean

| Tier | You get | You add |
|---|---|---|
| **On device** | nothing trusts a service; no server holds even the viewing key | embed `zkas-walletd-mobile` (Android AAR you build, iOS `ZkasEngine.xcframework`) or the `zkas_walletd` crate (desktop); talk to it on loopback |
| **Non-custodial spend** (the quickstart) | private send, seed on device, daemon hosted or yours | `verify_and_sign_payment` via the SDK, the drop-in, or the published `zkas-mobile` |
| **Watch-only** | balance and history, including where the wallet sent | register the viewing key with `/watch`; no signer |
| **Receive** | show a `zkas:` address | signer only; no daemon |

---

## Addresses and units

ZKAS addresses are **shielded (Orchard)** in the CashAddr encoding Kaspa uses: if you parse
`kaspa:` addresses you add one version byte.

| Field | Value |
|---|---|
| HRP | `zkas` (mainnet) · `zkastest` · `zkasdev` · `zkassim`; legacy `firecash*` still parses, always emit `zkas` |
| Version byte | `9` = `ShieldedOrchard` |
| Payload | 43 bytes: 11-byte diversifier ‖ 32-byte `pk_d` |
| Checksum | BCH polymod over the HRP; validate it |

A shielded address has no on-chain balance; it is only a destination. **Units:**
`1 ZKAS = 100,000,000 sompi`; move integer sompi as decimal strings (`*_exact` fields,
BigInt in JS), never floats; the JSON-number twins round above 2^53.

---

## Why the daemon cannot steal

Orchard splits a spend in two: the Halo 2 **proof**, built from the viewing key, and the
RedPallas **authorization**, which needs `ask`, derived from the seed and not derivable
from the viewing key. A daemon with the viewing key builds a fully proven bundle that is
worthless until the device signs it, and the device signs only after
`verify_and_sign_payment` has confirmed recipient, amount and fee from the bundle itself.
Design: `zkas-rusty/docs/NON_CUSTODIAL_WALLET.md`.

---

## Signer WASM API

| Function | Returns | Use |
|---|---|---|
| `new_wallet_mnemonic(network)` | `{ mnemonic, address }` | create (12-word phrase) |
| `is_valid_mnemonic(phrase)` | `bool` | validate input before opening |
| `account_seed_hex(phrase, account)` | 64-hex seed of that account | the seed everything else consumes |
| `account_address(phrase, network, account)` | `string` | preview or discover accounts |
| `new_wallet(network)` / `address_from_seed(seed_hex, network)` | `{ seed_hex, address }` / `string` | raw-seed wallets |
| `fvk_hex(seed_hex)` | 96-byte hex | register watch-only |
| `sign` / `verify` | `{ address, signature_hex }` / `bool` | prove address control (no spend) |
| **`verify_and_sign_payment(seed_hex, network, to, amount_sompi, max_fee_sompi, bundle_hex, disclosure_json, alphas_json)`** | `[{ index, sig }]` | **verify the prepared bundle on-device, then sign; throws on any mismatch** |
| `sign_spend_auth(seed_hex, alpha_hex, sighash_hex)` | 64-byte hex | low-level; prefer the one above |

## walletd REST reference

Every call carries `X-Wallet-Token`. A self-hosted daemon also enforces `--allow-origin`.
Full field documentation: `zkas-rusty/docs/WALLETD.md`.

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/health` | liveness, no token; process counters |
| `GET` | `/api/status` | the one call to poll: `spend_ready`, `blocks_behind`, `warming`, `missing_history`, `synced` |
| `POST` | `/api/wallet/watch` | `{ fvk_hex, birthday }`: register a viewing key; re-registering never moves the birthday later |
| `GET` | `/api/wallet/address?index=N` | the N-th diversified address (`index_exact`) |
| `GET` | `/api/wallet/balance` | total / spendable / maturing / pending as decimal strings |
| `GET` | `/api/wallet/history?limit=&offset=` | newest first; received rows carry `credits[]` with `index`, `amountSompiExact`, `memo` |
| `GET` | `/api/wallet/deposits?after=&limit=` | the deposit journal, oldest first by sequence number |
| `GET` | `/api/wallet/requests/{id}` | what became of a payment sent with that request id |
| `POST` | `/api/wallet/prepare` → `/api/wallet/submit` | the non-custodial pair; `request_id` on prepare |
| `GET` | `/api/wallet/proof?txid=` · `POST /api/proof/verify` | payment proof of a send, and its verification (no token) |
| `POST` | `/api/wallet/sign` · `/api/verify` | message sign and verify |
| `POST` | `/api/wallet/create` · `import` · `send` · `send_many` · `consolidate` · `GET /reveal` | **custodial only**: the daemon holds the seed; off with `--no-custodial`. Not for a non-custodial integration |

---

## Security checklist

- [ ] **Never blind-sign.** Every spend goes through `verify_and_sign_payment` (or the SDK).
- [ ] **Amount reconciliation.** `paid + remaining === requested`, else refuse.
- [ ] **Fee ceiling.** The device reads the fee from the bundle and refuses above the cap; size the cap to the transaction (about 2× the relay minimum for its spend count).
- [ ] **One request id per payment, reused on retry.** Treat `outcome_unknown` and a proxy's 5xx as *possibly paid*; never retry under a new id; `GET /requests/<id>` when in doubt.
- [ ] **Seed stays on device.** Send only the viewing key; never `create`/`import`/`reveal`.
- [ ] **Pin your code.** A web page's residual risk is a tampered script reading the phrase from storage: strict CSP (`script-src 'self'` + WASM, `connect-src` scoped). A signed native build removes it.
- [ ] **Transport.** HTTPS from the web; a native app may use `http://<LAN-IP>:8501`. Lock the daemon to your origin and require the token.
- [ ] **Back up the phrase.** It is the only recovery.
- [ ] **Record broadcast chunks** before surfacing any later error.

---

## Test, then ship

- **Testnet first:** `zkastest` addresses against a `--network testnet` daemon.
- **A local daemon for development** (fast sync from the public chain files):
  ```bash
  zkas-walletd --network mainnet --rpc-server 127.0.0.1:16110 --wallet-dir ./wallets \
    --listen 127.0.0.1:8501 --allow-origin http://localhost:5173 \
    --chain-files https://pub-ae5ed92258b2437e985b69ab9947ef60.r2.dev
  ```
- **Adversarial tests for free:** `@zkas/sdk`'s `npm test` runs the whole flow against a
  scripted fake daemon, including the device refusing a redirected payment, request ids
  across split payments, and unknown outcomes. Run your integration against the same shape.
- **The wire format is pinned:** `PreparedPaymentEnvelope` v2 has a golden vector on the
  Rust side and `zkas-sdk/src/types.ts` mirrors it field for field.

## Repos

- [zkas-signer](https://zkas.info/code/signer): the WASM signer, `zkas-mobile`, `zkas-walletd-mobile`
- [zkas-sdk](https://zkas.info/code/sdk): `@zkas/sdk`, `docs/ARCHITECTURE.md`, `docs/USAGE.md`
- [zkas-rusty](https://zkas.info/code/rusty): node, `zkas-walletd`, the Rust SDK crates; `docs/WALLETD.md`, `docs/NON_CUSTODIAL_WALLET.md`
- [zkas-payment-gateway](https://zkas.info/code/gateway): invoices, webhooks, WooCommerce
- [zkas-wallet](https://zkas.info/code/wallet): this repo, the reference wallet (web, desktop, Android) built on exactly these pieces
