# Integrating ZKAS into an existing wallet

This guide is for developers of an **existing wallet** (custodial exchange wallet,
multi-asset mobile/desktop wallet, point-of-sale, or accounting backend) who want to
**add ZKAS support** — receive, view, and send — without reimplementing any
cryptography.

**ZKAS** is a private-by-default Kaspa fork: GHOSTDAG/kHeavyHash for consensus,
**Orchard + Halo 2** for value privacy. Every balance and payment lives in the shielded
pool, so a ZKAS address has **no public balance** and a payment reveals neither sender,
recipient, nor amount on-chain. That shapes what "wallet support" means here — you never
scan a UTXO set for an address; you hold a **viewing key** and let a daemon scan for you.

> The good news: the split between *proving* a spend and *authorizing* it means you can
> add **fully non-custodial** ZKAS spending to a light client — the seed never leaves the
> device and the heavy Halo 2 proving is done by a service that **cannot move the funds**.
> See [Why non-custody works](#why-non-custody-works).

---

## 1. Pick your integration tier

| Tier | Capability | What you integrate | Keys you hold |
|---|---|---|---|
| **0 — Receive** | Show a `zkas:` address, accept a QR/deeplink | Address derivation only (the signer WASM, or the Rust `zkas-signer` crate) | 32-byte seed (or import an address to display) |
| **1 — Watch-only** | Balance, history, per-invoice reconciliation | Tier 0 **+** `zkas-walletd` (yours or hosted); register the **full viewing key (FVK)** | FVK only — cannot spend |
| **2 — Non-custodial spend** | Send private payments; seed stays on-device | Tier 1 **+** the signer's `verify_and_sign_payment`, via `@zkas/sdk` or raw REST | Seed on device; FVK at the service |
| **3 — Fully local** | Everything private from any service | Run `zkas-walletd` in-process (Rust crates), or embed it | Everything local |

Most integrations want **Tier 2**: it is non-custodial, the client stays light (no Halo 2
in the browser/app), and it is the model the official web/mobile wallets ship.

---

## 2. The building blocks (the files/packages you actually pull in)

| Component | What it is | Where |
|---|---|---|
| **`@zkas/sdk`** | Typed TypeScript client for the hosted non-custodial flow: `status`, `watch`, `balance`, `history`, and the full verified `send` (prepare → verify on-device → sign → submit) with automatic multi-tx chunking and progress events. **The fast path.** | [`firecash/zkas-sdk`](https://github.com/firecash/zkas-sdk) · `npm i @zkas/sdk` |
| **`zkas-signer`** (a.k.a. `firecash-signer`) | The on-device key primitive, compiled to **WebAssembly** (no proving circuit — small, ~665 KB). This is the piece that makes non-custody real: it derives addresses, derives the FVK, signs messages, and does the **anti-blind-signing** payment check + spend-auth signature. Files: `firecash_signer.js`, `firecash_signer.d.ts`, `firecash_signer_bg.wasm`. | [`firecash/zkas-signer`](https://github.com/firecash/zkas-signer) (wasm-bindgen). A prebuilt copy also lives in this repo at [`src/signer/`](../src/signer). |
| **`zkas-walletd`** | The wallet daemon: a keyless (FVK-only) REST service that scans the chain, builds Orchard proofs, and broadcasts. You can point at the **hosted** daemon or **run your own**. | [`zkas-rusty`](https://github.com/firecash/zkas-rusty) → `zkas-walletd`. REST reference: `docs/WALLETD.md`; design: `docs/NON_CUSTODIAL_WALLET.md`. |
| **Rust crates** `zkas-sdk` · `zkas-signer` · `zkas-wallet-engine` | The canonical implementation for **native/local (Tier 3)** integrations, developed inside the node workspace so the daemon and SDK can never drift. | [`zkas-rusty/sdk`](https://github.com/firecash/zkas-rusty/tree/main/sdk) |
| **`shielded-pay`** | A CLI for offline/scripted use: derive an address, export an FVK from a seed **without putting it in argv** (`sign --seed-stdin`), sign/verify a message, or send. Good for backend jobs and cold key handling. | `zkas-rusty` → `shielded-pay`; see `docs/CLI-WALLET.md`. |

If you are TypeScript/JS: use **`@zkas/sdk` + the `zkas-signer` WASM**. If you are native
(Rust, or FFI from another language): use the **Rust crates**, or shell out to
**`shielded-pay`**, or run **`zkas-walletd`** and speak REST.

---

## 3. Addresses & units

ZKAS addresses are **shielded (Orchard)** and use the same **CashAddr** encoding as
`kaspa:` addresses, so if you already parse Kaspa addresses you are 90% there — you only
add one version byte and a longer payload.

| Field | Value |
|---|---|
| **HRP (prefix)** | `zkas` (mainnet), `zkastest` (testnet), `zkasdev` (devnet), `zkassim` (simnet) |
| Legacy HRP | `firecash*` still parses forever (pre-rebrand addresses); always **emit** `zkas`. |
| **Version byte** | `9` = `ShieldedOrchard` (Kaspa's own addresses are `0`/`1`/`8`) |
| **Payload** | the **43-byte** raw Orchard address = 11-byte diversifier ‖ 32-byte `pk_d` |
| Encoding | CashAddr: charset `qpzry9x8gf2tvdw0s3jn54khce6mua7l`, BCH polymod checksum over the HRP actually present |
| Example shape | `zkas:qz…` (single string; validate the checksum, do not string-match the prefix) |

A shielded address has **no on-chain balance** and maps to **no transparent script** — do
not try to look it up in a UTXO index. Treat it purely as a payment destination.

**Units.** `1 ZKAS = 100,000,000 sompi` (1e8). **Always move integer sompi across any wire
as a decimal string** — never a JS float. Do the one decimal→integer conversion where the
user types the amount, never in transport.

```
1 ZKAS            = 100_000_000 sompi
0.001 ZKAS        =     100_000 sompi
amount_sompi      = "150000000000"   // 1,500 ZKAS, as a string
```

---

## 4. Why non-custody works

Orchard splits a spend into two independent steps:

1. **`create_proof(fvk, …)`** — the heavy Halo 2 proof. Needs **only the full viewing
   key (FVK)**, notes, and witnesses. **No spend authority.**
2. **`apply_signatures(…, ask)`** — the RedPallas spend-authorization signature. This is
   the **only** step that needs `ask`, the secret derived from the 32-byte seed.

`ask` **cannot** be derived from the FVK (one-way). So a service holding only the FVK can
build a fully-proven bundle that is **worthless until the seed-holder signs it**. That is
the entire basis for the hosted-hybrid model:

- **Seed** (32 bytes) → stays on the device. The secret. Whoever holds it owns the funds.
- **FVK** (`ak ‖ nk ‖ rivk`, 96 bytes) → derived on-device, handed to the daemon. Grants
  **viewing** (scan for your notes, build proofs) but **not spending**.

The daemon can see your balance and history. It **cannot** move a coin, and — because of
the on-device check in §6 — it cannot trick the device into signing a payment it did not
intend.

---

## 5. The signer WASM API

From `zkas-signer` (`firecash-signer`). Every function runs **entirely on-device**; no key
material leaves the page. `network` is `"mainnet"` or `"testnet"`.

| Function | Returns | Use |
|---|---|---|
| `new_wallet(network)` | `{ seed_hex, address }` | Generate a wallet (browser CSPRNG). |
| `address_from_seed(seed_hex, network)` | `string` | Derive the `zkas:` address (Tier 0). |
| `fvk_hex(seed_hex)` | `string` (96-byte hex) | Derive the FVK to register with the daemon (Tier 1+). |
| `sign(seed_hex, network, message)` | `{ address, signature_hex }` | Prove address control without spending. `signature_hex` is `fvk ‖ sig`. |
| `verify(address, message, signature_hex)` | `boolean` | Verify such a signature (network taken from the address prefix). |
| `sign_spend_auth(seed_hex, alpha_hex, sighash_hex)` | `string` (64-byte hex) | Low-level: sign one spend's `alpha` over a sighash. Prefer `verify_and_sign_payment`. |
| **`verify_and_sign_payment(seed_hex, network, to, amount_sompi, max_fee_sompi, bundle_hex, disclosure_json, alphas_json)`** | `string` → `[{index, sig}]` JSON | **The anti-blind-signing entry point.** Verifies the daemon's unsigned bundle actually pays `to`/`amount_sompi` (everything else change back to you), that the **fee the bundle really pays** is ≤ `max_fee_sompi`, recomputes the sighash itself, and only then signs. Throws with a reason on any mismatch. |

The `src/signer/index.ts` wrapper in this repo shows the idiomatic async binding
(`ensureSigner()` then the typed helpers `generateWallet`, `addressFromSeed`, `fvkHex`,
`verifyAndSignPayment`, …). The WASM is base64-inlined so it works identically in a hosted
page and a native (Capacitor/Tauri) build.

---

## 6. The `zkas-walletd` REST API

All requests carry an `X-Wallet-Token` header (a random per-wallet token that selects
which wallet on the daemon you mean). A self-hosted daemon also enforces
`--allow-origin`.

| Method | Path | Purpose |
|---|---|---|
| `GET`  | `/api/status` | wallet + node + sync status. Check `missing_history` — if true the node pruned history and the balance is a **lower bound**; show it, do not rescan through this node. |
| `POST` | `/api/wallet/watch` | register a **viewing-key-only** wallet: `{ fvk_hex, birthday }`. Never sends a seed. |
| `GET`  | `/api/wallet/balance` | balance + note count |
| `GET`  | `/api/wallet/history` | chain-derived history (mints, receives, and — via the OVK — own sends) |
| `POST` | `/api/wallet/prepare` | build+prove an **unsigned** payment (see below) |
| `POST` | `/api/wallet/submit` | apply device signatures and broadcast |
| `POST` | `/api/wallet/sign` · `/api/verify` | message sign / verify |
| `POST` | `/api/wallet/create` · `GET /api/wallet/reveal` · `POST /api/wallet/import` | **custodial/self-hosted only** — the daemon holds the seed. Do **not** use these for a non-custodial integration. |
| `POST` | `/api/wallet/send-many` · `/api/wallet/consolidate` | self-hosted batch payout / note consolidation |

**`/api/wallet/prepare`** request:

```json
{ "fvk_hex": "…96-byte hex…", "to": "zkas:…", "amount_sompi": "150000000000",
  "fee": null, "memo": null, "allow_partial": false }
```

**`/api/wallet/prepare`** response (the fields the device must verify are in **bold**):

```jsonc
{
  "session": "…",              // opaque handle to pass back to /submit
  "sighash": "…",              // do NOT trust this — the device recomputes it
  "amount_sompi": 150000000000,
  "fee_sompi": 25000,
  "remaining_sompi": 0,        // >0 only when allow_partial and the wallet is fragmented
  "spend_auth": [ { "index": 0, "alpha": "…" } ],   // one alpha per real spend
  "bundle_hex": "…",           // ** the unsigned bundle the device reconstructs **
  "disclosure": [              // ** per-action claim of what it pays **
    { "spend_value": …, "out_value": …, "out_recipient": "…", "out_rseed": "…", "rcv": "…" }
  ]
}
```

**`/api/wallet/submit`** request: `{ "session": "…", "sigs": [ { "index": 0, "sig": "…" } ] }`
→ `{ "txid": "…", "amount_sompi": …, "fee_sompi": … }`.

The **golden rule**: pass `bundle_hex`, `disclosure`, and `spend_auth` into the signer's
`verify_and_sign_payment` and sign **only** what it returns. Never sign the server's
`sighash` directly — that is blind signing, and it is what the on-device check exists to
prevent.

---

## 7. Recipe A — receive-only (Tier 0)

The minimum to accept ZKAS. No daemon needed to *derive and display* an address.

```ts
import { generateWallet, addressFromSeed } from "./signer"; // wraps the zkas-signer WASM

// New wallet (seed is the secret — store it the way you store any private key):
const { seedHex, address } = await generateWallet("mainnet");
showQr(address);          // "zkas:qz…"

// Or an address for a seed you already hold:
const addr = await addressFromSeed(seedHex, "mainnet");
```

To also **see incoming funds**, register the FVK with a daemon (Tier 1):

```ts
import { fvkHex } from "./signer";
await fetch(`${walletd}/api/wallet/watch`, {
  method: "POST",
  headers: { "X-Wallet-Token": token, "Content-Type": "application/json" },
  body: JSON.stringify({ fvk_hex: await fvkHex(seedHex), birthday: creationDaaScore }),
});
// then poll GET /api/wallet/balance and /api/wallet/history
```

`birthday` is the DAA score at wallet creation; it bounds the scan so a new wallet syncs
fast. Use `0` to scan from genesis.

---

## 8. Recipe B — non-custodial send with `@zkas/sdk` (Tier 2, recommended)

```ts
import { ZKasClient, wasmPaymentSigner, DEFAULT_MAX_FEE_SOMPI } from "@zkas/sdk";
import { fvkHex, verifyAndSignPayment } from "./signer"; // the zkas-signer WASM

const client = new ZKasClient({ baseUrl: walletdUrl, token });

// one-time: register viewing key (never a seed)
await client.watch(await fvkHex(seedHex), birthdayDaa);

// send — the SDK runs prepare → on-device verify+sign → submit, and chunks a
// fragmented wallet across standard transactions automatically.
const signer = wasmPaymentSigner({ seedHex, fvkHex, verifyAndSignPayment });
const result = await client.send(
  signer,
  { to: "zkas:…", amountSompi: 150_000_000_000n, maxFeeSompi: DEFAULT_MAX_FEE_SOMPI },
  (stage, p) => console.log(stage, p),   // "proving" | "signing" | "broadcasting"
);
console.log(result.txids, result.feeSompi);
```

`amountSompi` and `maxFeeSompi` are **bigints** — exact integers, never floats.

---

## 9. Recipe C — non-custodial send over raw REST (no SDK)

If you cannot use the TS SDK (e.g. you drive the WASM from another host), the whole
protocol is four calls. The device signs **only the bundle it verified**:

```ts
// 1. viewing key, on-device
const fvk = await fvkHex(seedHex);

// 2. ask the (keyless) daemon to build + prove an UNSIGNED bundle
const prep = await post("/api/wallet/prepare", {
  fvk_hex: fvk, to, amount_sompi: amountSompi.toString(), allow_partial: false,
});

// 3. ON DEVICE: verify it really pays `to`/amount (rest = change), fee within ceiling,
//    recompute the sighash, and sign. Throws if the daemon lied.
const sigs = await verifyAndSignPayment(
  seedHex, "mainnet", to, amountSompi, maxFeeSompi,
  prep.bundle_hex, JSON.stringify(prep.disclosure), JSON.stringify(prep.spend_auth),
); // -> [{ index, sig }]

// 4. hand the signatures back; the daemon finalizes and broadcasts
const { txid } = await post("/api/wallet/submit", { session: prep.session, sigs });
```

A wallet fragmented into many small notes may not fit one transaction (standard cap
≈ **38 spends** / 500,000 block-mass). Pass `allow_partial: true`, read
`remaining_sompi`, and repeat prepare→sign→submit until it reaches `0` — but only after
the user explicitly accepts split delivery, and record every broadcast chunk before
showing any error (a broadcast chunk is real money in flight).

---

## 10. Security requirements (non-negotiable)

These are enforced by the signer and the daemon, not by convention. If you skip them you
lose the property that makes hosted ZKAS safe.

- **Never blind-sign.** Always route a spend through `verify_and_sign_payment` (or the
  SDK, which does). Signing the server's `sighash` directly hands a malicious daemon your
  funds.
- **Enforce a fee ceiling.** The device reads the fee from the **bundle's own public value
  balance**, never from a number the server reports, and refuses anything above
  `max_fee_sompi`. Without it a lying daemon can burn your entire change as "fee"
  (collectable by a miner — plausibly the daemon's own pool). Price the ceiling to the
  transaction (≈2× the relay minimum for that spend count), not one flat number.
- **The seed stays on-device.** Only ever send the **FVK** to a daemon. Never
  `/api/wallet/create` / `import` / `reveal` in a non-custodial integration — those are
  for a daemon that deliberately holds the seed.
- **Pin the code you run.** A hosted web page's residual risk is the server serving
  tampered code that reads the seed from storage. Mitigate with a strict CSP
  (`script-src 'self'` + the WASM; `connect-src` scoped to your daemon and services). For
  the strongest guarantee, ship a fixed/signed native build or self-host.
- **Transport.** The hosted HTTPS page can only reach an HTTPS daemon; a native app may
  reach an `http://<LAN-IP>:8501` daemon directly. Lock the daemon's CORS to your exact
  origin (`--allow-origin`) and require the wallet token.
- **Back up the seed.** It is the only way to restore a wallet. Losing the per-browser
  `wallet_token` loses nothing; losing the seed loses the funds.

---

## 11. Test, then go live

- **Testnet first.** Use the `zkastest` HRP and a testnet daemon (`--network testnet`).
- **Run a local daemon** for development and allow your dev origin:

  ```bash
  zkas-walletd --network mainnet --rpc-server 127.0.0.1:16110 \
    --wallet-dir ./fc-wallets --listen 127.0.0.1:8501 \
    --allow-origin http://localhost:5173
  ```

- **The SDK ships a scripted fake daemon** (`npm test` in `zkas-sdk`) so you can exercise
  the full prepare→verify→sign→submit path — including the on-device rejection of a lying
  daemon — with no chain.
- **Golden vectors.** The prepared-payment wire format (`PreparedPaymentEnvelope`,
  version 2) is pinned by a golden test on the Rust side; the TS types in
  `zkas-sdk/src/types.ts` mirror it field-for-field, so a mismatch is a build failure, not
  a runtime surprise.

---

## Reference repositories

- **[zkas-rusty](https://github.com/firecash/zkas-rusty)** — node, miner, `zkas-walletd`,
  the Rust SDK crates, `shielded-pay`. Docs: `docs/WALLETD.md`,
  `docs/NON_CUSTODIAL_WALLET.md`, `docs/CLI-WALLET.md`.
- **[zkas-sdk](https://github.com/firecash/zkas-sdk)** — `@zkas/sdk` TypeScript client +
  `docs/ARCHITECTURE.md`, `docs/USAGE.md`.
- **[zkas-signer](https://github.com/firecash/zkas-signer)** — the on-device WASM signer.
- **[zkas-wallet](https://github.com/firecash/zkas-wallet)** — this repo: a complete
  reference wallet (web + desktop + mobile) built on exactly the pieces above.
