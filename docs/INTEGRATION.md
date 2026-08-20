# Add ZKAS to your wallet — non-custodial, from zero

For developers of an existing wallet (mobile, desktop, exchange, PoS) who want to add
**ZKAS receive + view + send** the same way our light wallet does: **the customer's seed
never leaves their device**, and a keyless daemon does the heavy Halo 2 proving but
**can never move the funds**.

You do not implement any cryptography. You pull in three ready-made pieces:

| Piece | Role | Where |
|---|---|---|
| **`zkas-signer`** (WASM) | on-device keys: derive address, derive viewing key, **verify + sign** a payment | [`firecash/zkas-signer`](https://github.com/firecash/zkas-signer) · prebuilt in this repo at [`src/signer/`](../src/signer) |
| **`@zkas/sdk`** (npm) | typed client for the whole send flow, with progress + auto-chunking | [`firecash/zkas-sdk`](https://github.com/firecash/zkas-sdk) |
| **`zkas-walletd`** | keyless daemon that scans + proves + broadcasts (hosted, or run your own) | [`zkas-rusty`](https://github.com/firecash/zkas-rusty) |

**Trust model in one line:** you send the daemon a **viewing key** (it can watch), never
the seed (only the seed can spend), and the device **re-checks and signs every payment**
so a hostile daemon can neither redirect funds nor inflate the fee.

---

## Quickstart — 0 → sending in 4 calls

```bash
npm install @zkas/sdk
# build the signer WASM from github.com/firecash/zkas-signer (wasm-bindgen, no circuit),
# or copy the prebuilt src/signer/ from this repo.
```

```ts
import { ZKasClient, wasmPaymentSigner, DEFAULT_MAX_FEE_SOMPI } from "@zkas/sdk";
import { generateWallet, fvkHex, verifyAndSignPayment } from "./signer"; // the WASM wrapper

// 1. Keys on the device. `seedHex` is the secret — store it like any private key.
const { seedHex, address } = await generateWallet("mainnet");   // show `address` / QR to receive

// 2. Point at a daemon and register the VIEWING KEY (never the seed).
const client = new ZKasClient({ baseUrl: WALLETD_URL, token: perWalletToken });
await client.watch(await fvkHex(seedHex), /* birthday DAA */ 0);

// 3. Read state whenever you like. balance_sompi is a decimal string — BigInt it.
const bal = BigInt((await client.balance()).balance_sompi);   // 1 ZKAS = 100_000_000 sompi

// 4. Send. prepare → verify-on-device → sign → submit, all inside client.send().
const signer = wasmPaymentSigner({ seedHex, fvkHex, verifyAndSignPayment });
const res = await client.send(
  signer,
  { to: "zkas:…", amountSompi: 5_000_000_000n, maxFeeSompi: DEFAULT_MAX_FEE_SOMPI },
  (stage) => console.log(stage),   // "proving" | "signing" | "broadcasting"
);
console.log(res.txids, res.feeSompi);
```

That is a complete non-custodial integration. Everything below is either the **from-scratch
version** (if you can't use the SDK) or **reference**.

---

## The drop-in client (no SDK) — exactly what our light wallet does

If you drive the WASM yourself (another framework, another language via FFI, or you just
want no dependency), this ~90-line module is a faithful reduction of our wallet's
`src/noncustodial.ts`. **The safety checks are the point — do not remove them.**

```ts
// zkas.ts — a self-contained non-custodial ZKAS client.
import {
  generateWallet, addressFromSeed, fvkHex, verifyAndSignPayment,
} from "./signer"; // your wrapper around the zkas-signer WASM (see src/signer/index.ts)

const SOMPI_PER_ZKAS = 100_000_000n;

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
    if (!r.ok) throw new Error(`${path} → HTTP ${r.status}: ${await r.text()}`);
    return r.json() as Promise<T>;
  }

  // ---- keys (on device) ----
  static async create(net: "mainnet" | "testnet") { return generateWallet(net); }        // {seedHex,address}
  address(seedHex: string) { return addressFromSeed(seedHex, this.network); }

  // ---- register viewing key (never the seed) ----
  async watch(seedHex: string, birthdayDaa = 0) {
    await this.call("POST", "/api/wallet/watch", { fvk_hex: await fvkHex(seedHex), birthday: birthdayDaa });
  }

  // balance_sompi / balance_fc are decimal STRINGS (float-safe). Parse with BigInt(balance_sompi).
  balance() { return this.call<{ balance_sompi: string; balance_fc: string }>("GET", "/api/wallet/balance"); }

  // ---- non-custodial send: prepare → verify-on-device → sign → submit ----
  async send(seedHex: string, to: string, amountSompi: bigint, maxFeeSompi: bigint) {
    const fvk = await fvkHex(seedHex);

    // 1. Daemon builds + PROVES an UNSIGNED bundle from the viewing key. It cannot sign it.
    const prep = await this.call<PrepareResp>("POST", "/api/wallet/prepare", {
      fvk_hex: fvk, to, amount_sompi: amountSompi.toString(), allow_partial: false,
    });

    // 2. Refuse a daemon that quietly changed the amount. (Single-tx path: remaining must be 0.)
    const paid = BigInt(prep.amount_sompi_exact ?? Math.round(prep.amount_sompi));
    const remaining = BigInt(prep.remaining_sompi_exact ?? Math.round(prep.remaining_sompi ?? 0));
    if (paid !== amountSompi || remaining !== 0n)
      throw new Error("Daemon changed the requested amount. Refusing to sign.");

    // 3. Refuse an inflated fee BEFORE any signing (the signer re-checks from the bundle too).
    const fee = BigInt(prep.fee_sompi_exact ?? Math.round(prep.fee_sompi));
    if (fee > maxFeeSompi) throw new Error(`Daemon asked ${fee} sompi fee > ceiling ${maxFeeSompi}. Refusing.`);

    // 4. ON DEVICE: verify the bundle really pays `to` this amount (rest = change back to us),
    //    that the fee READ FROM THE BUNDLE is ≤ ceiling, recompute the sighash, and sign.
    //    Throws on any lie. This is what makes a hostile daemon powerless.
    const sigs = await verifyAndSignPayment(
      seedHex, this.network, to.trim(), amountSompi, maxFeeSompi,
      prep.bundle_hex, JSON.stringify(prep.disclosure), JSON.stringify(prep.spend_auth),
    );

    // 5. Daemon applies the signatures and broadcasts. It never held spend authority.
    return this.call<{ txid: string; amount_sompi: number; fee_sompi: number }>(
      "POST", "/api/wallet/submit", { session: prep.session, sigs });
  }
}

interface PrepareResp {
  session: string; bundle_hex: string;
  amount_sompi: number; fee_sompi: number; remaining_sompi?: number;
  amount_sompi_exact?: string; fee_sompi_exact?: string; remaining_sompi_exact?: string;
  spend_auth: { index: number; alpha: string }[];
  disclosure: { spend_value: number; out_value: number; out_recipient: string; out_rseed: string; rcv: string }[];
}
```

Usage:

```ts
const z = new Zkas("https://wallet.example/daemon", token, "mainnet");
const { seedHex, address } = await Zkas.create("mainnet");   // back up seedHex; show address
await z.watch(seedHex);
await z.send(seedHex, "zkas:…", 5_000_000_000n, 10_000_000n); // 50 ZKAS, ≤0.1 ZKAS fee
```

> **Fragmented wallets.** One transaction spends at most ~38 notes (the 500,000
> block-mass cap). A wallet holding many small notes (e.g. a miner's per-block coinbase)
> may need several transactions for one payment: pass `allow_partial: true`, read
> `remaining_sompi`, and loop prepare→sign→submit until it hits `0` — **but only after the
> user accepts split delivery, and record each broadcast chunk before any error** (a
> broadcast chunk is money already in flight). The SDK's `client.send()` does this for
> you; `src/noncustodial.ts` in this repo is the full reference implementation.

---

## Map it onto your wallet

| Our light wallet | What you write | Notes |
|---|---|---|
| `src/signer/index.ts` | your WASM wrapper (or copy ours) | `ensureSigner()` once, then the typed helpers |
| `src/api.ts` | the `call()`/`prepare`/`submit` above | one `X-Wallet-Token` header per wallet |
| `src/noncustodial.ts` | `Zkas.send()` above (or `@zkas/sdk`) | keep the amount + fee checks verbatim |
| per-browser `wallet_token` | one random 16-byte hex per wallet | picks the wallet on the daemon; **not** a secret — the seed is |
| seed in device storage | your secure key store | the only thing that must be backed up |

---

## What "ZKAS support" can mean — pick a tier

| Tier | You get | You add |
|---|---|---|
| **Receive** | show a `zkas:` address | signer's `address_from_seed` only — no daemon |
| **Watch-only** | balance + history | + register the FVK with a daemon (`/watch`) |
| **Non-custodial spend** ← *the quickstart* | private send, seed on device | + `verify_and_sign_payment` (SDK or drop-in) |
| **Fully local** | nothing trusts a service | run `zkas-walletd` yourself / the Rust crates |

---

## Addresses & units (reference)

ZKAS addresses are **shielded (Orchard)** and use the **same CashAddr encoding as
`kaspa:` addresses** — if you already parse Kaspa addresses, you add one version byte.

| Field | Value |
|---|---|
| HRP | `zkas` (mainnet) · `zkastest` · `zkasdev` · `zkassim`. Legacy `firecash*` still parses; always emit `zkas`. |
| Version byte | `9` = `ShieldedOrchard` |
| Payload | 43 bytes: 11-byte diversifier ‖ 32-byte `pk_d` |
| Checksum | BCH polymod over the HRP present (validate it — don't prefix-match) |

A shielded address has **no on-chain balance** — never look it up in a UTXO index; it is
only a destination.

**Units:** `1 ZKAS = 100,000,000 sompi`. **Always move integer sompi as a decimal string**
(bigints in JS) — never a float. Convert the user's decimal input to sompi once, at input.

---

## Why the daemon can't steal (the whole basis)

Orchard splits a spend in two:

1. **prove** — the heavy Halo 2 proof, built from the **viewing key only**. No spend power.
2. **authorize** — a RedPallas signature that needs `ask`, derived from the **seed**.

`ask` can't be derived from the viewing key (one-way). So a daemon with only the FVK can
build a fully-proven bundle that is **worthless until the device signs it** — and the
device only signs after `verify_and_sign_payment` confirms recipient, amount, and fee.
Design doc: `zkas-rusty/docs/NON_CUSTODIAL_WALLET.md`.

- **Seed** (32 B) → device only. The secret.
- **FVK** = `ak ‖ nk ‖ rivk` (96 B) → derived on-device, given to the daemon. Viewing, not spending.

---

## Signer WASM API (reference)

| Function | Returns | Use |
|---|---|---|
| `new_wallet(network)` | `{ seed_hex, address }` | generate |
| `address_from_seed(seed_hex, network)` | `string` | receive address |
| `fvk_hex(seed_hex)` | 96-byte hex | register watch-only |
| `sign` / `verify` | `{address, signature_hex}` / `bool` | prove address control (no spend) |
| **`verify_and_sign_payment(seed_hex, network, to, amount_sompi, max_fee_sompi, bundle_hex, disclosure_json, alphas_json)`** | `[{index, sig}]` JSON | **verify the prepared bundle on-device, then sign. Throws on any mismatch.** |
| `sign_spend_auth(seed_hex, alpha_hex, sighash_hex)` | 64-byte hex | low-level; prefer the one above |

## walletd REST (reference)

Every call carries `X-Wallet-Token`. A self-hosted daemon also enforces `--allow-origin`.

| Method | Path | Purpose |
|---|---|---|
| `POST` | `/api/wallet/watch` | register `{ fvk_hex, birthday }` — viewing key only |
| `GET`  | `/api/wallet/balance` · `/api/wallet/history` | state |
| `GET`  | `/api/status` | node/sync status — check `missing_history` (balance is a lower bound if the node pruned) |
| `POST` | `/api/wallet/prepare` → `/api/wallet/submit` | the non-custodial send pair |
| `POST` | `/api/wallet/sign` · `/api/verify` | message sign/verify |
| `POST` | `/api/wallet/create` · `import` · `GET /reveal` | **custodial only** — daemon holds the seed. Don't use these for a non-custodial wallet. |

Admin/operator warmup endpoints (`/api/admin/warm_chain_tree`, `/api/admin/warm_wallet`)
and full field docs are in `zkas-rusty/docs/WALLETD.md`.

---

## Security checklist (non-negotiable)

- [ ] **Never blind-sign.** Every spend goes through `verify_and_sign_payment` (or the SDK).
- [ ] **Amount reconciliation.** `paid + remaining === requested`, else refuse.
- [ ] **Fee ceiling.** The device reads the fee from the **bundle**, not the response, and refuses above the cap. Price it to the tx (≈2× relay min for that spend count), not one flat number.
- [ ] **Seed stays on device.** Only ever send the **FVK**. Never `create`/`import`/`reveal` in a non-custodial integration.
- [ ] **Pin your code.** A web page's residual risk is a tampered script reading the seed from storage — enforce a strict CSP (`script-src 'self'` + WASM; `connect-src` scoped to your daemon/services). A signed native build removes it.
- [ ] **Transport + CORS.** HTTPS from web; a native app may use `http://<LAN-IP>:8501`. Lock the daemon to your exact origin and require the token.
- [ ] **Back up the seed.** It is the only recovery. The wallet token is not a secret and loses nothing.
- [ ] **Record broadcast chunks** before surfacing any post-broadcast error (money in flight).

---

## Test, then ship

- **Testnet first:** `zkastest` HRP + a `--network testnet` daemon.
- **Local daemon for dev:**
  ```bash
  zkas-walletd --network mainnet --rpc-server 127.0.0.1:16110 \
    --wallet-dir ./fc-wallets --listen 127.0.0.1:8501 --allow-origin http://localhost:5173
  ```
- **Adversarial test for free:** `@zkas/sdk`'s `npm test` runs the full flow against a
  scripted **fake daemon**, including the on-device rejection of a lying prover — prove
  your integration refuses to sign a redirected payment.
- **Wire format is pinned:** `PreparedPaymentEnvelope` v2 has a golden vector on the Rust
  side; `zkas-sdk/src/types.ts` mirrors it field-for-field, so drift is a build error.

## Repos

- **[zkas-signer](https://github.com/firecash/zkas-signer)** — the WASM signer
- **[zkas-sdk](https://github.com/firecash/zkas-sdk)** — `@zkas/sdk` + `docs/ARCHITECTURE.md`, `docs/USAGE.md`
- **[zkas-rusty](https://github.com/firecash/zkas-rusty)** — node, `zkas-walletd`, Rust SDK crates, `shielded-pay`; `docs/WALLETD.md`, `docs/NON_CUSTODIAL_WALLET.md`
- **[zkas-wallet](https://github.com/firecash/zkas-wallet)** — this repo: the full reference wallet (web + desktop + mobile) built on exactly these pieces
