# Security Audit Report — firecash/zkas-wallet

| | |
|---|---|
| **Repository** | https://github.com/firecash/zkas-wallet |
| **Commit audited** | `master` @ clone of 2026-08-22 |
| **Version** | UI `1.0.17-rc3` (package.json), desktop shell `1.0.5` (Cargo.toml) |
| **Auditor scope** | Full source: `src/**` (TypeScript/React), `src-tauri/src/**` (Rust), configs (`tauri.conf.json`, `capacitor.config.ts`, `vite.config.ts`, CI), scripts |
| **Out of scope** | `zkas-walletd` daemon itself (path dep into sibling repo `rusty-kaspa/zkas-walletd` — NOT in this repo), Android/iOS native projects beyond config review |

---

## 1. Executive Summary

ZKas wallet is a multi-surface (web / Capacitor mobile / Tauri desktop) non-custodial shielded wallet. The seed is generated on-device; only a viewing key (FVK) is registered with the remote daemon. Desktop embeds `zkas-walletd` on a loopback port behind an `X-Wallet-Token`.

**Overall posture: above-average for a crypto wallet codebase.** The non-custodial prepare/verify/sign protocol is genuinely well-designed — the device reconstructs the bundle and re-computes the sighash before signing (src/noncustodial.ts, src/signer/index.ts). Binary supply chain is pinned by SHA-256 (services.rs). Several historical bugs are documented and fixed in-line.

However, there are **material weaknesses**, concentrated in three areas:

1. **Key material at rest** — the spending seed lives in `localStorage`, in cleartext by default, with multiple plaintext fallback paths that can silently re-materialize it.
2. **Network exposure choices** — LAN/WAN modes bind unauthenticated or bearer-only services to `0.0.0.0`; the CSP is effectively `http: https:` wide open.
3. **Trust boundaries around the hosted service** — default web/mobile users route through `wallet.zkas.info`; several code paths can push seeds or reveal data to that server.

Severity counts: **2 Critical, 6 High, 9 Medium, 8 Low / Hardening**.

---

## 2. Findings

### CRITICAL

---

#### C-1. Spending seed persisted in cleartext `localStorage` unless App Lock is manually enabled — plus silent plaintext fallbacks

**Files:** `src/lib/deviceseed.ts` (whole file), `src/applock.ts:127–149`, `src/walletstate.ts`

```ts
// deviceseed.ts:20–33
export function setDeviceSeed(seed: string) {
  if (!seed) return;
  if (isLockEnabled()) {
    const token = localStorage.getItem("wallet_token") || "default";
    void sealNewSeed(token, seed).then((ok) => {
      if (!ok) {
        localStorage.setItem(deviceSeedKey(), seed);            // ← plaintext fallback
        localStorage.setItem(`seed_unsealed_${token}`, "1");    // ← flag admitting it
      }
    });
    return;
  }
  localStorage.setItem(deviceSeedKey(), seed);                  // ← default path
}
```

* The 64-hex spending seed sits under `device_seed_<token>` in plain localStorage **by default** on every platform (desktop WebView storage, browser origin storage, mobile WebView).
* Even **with** App Lock enabled, if `sealNewSeed()` fails (app reloading mid-seal, storage quota, race) the code writes the **raw seed to disk anyway** and merely sets a marker flag. There is no retry-to-seal path surfaced to the user; the "sealed" guarantee silently degrades to plaintext.
* `getDeviceSeed()` honors that flag: any process able to read the WebView's storage (malware running as the user, a synced/profile-copied machine, another local app on Windows where WebView2 storage is not OS-key-protected per-origin) recovers the full spending key.
* Backup nag exists, but nothing forces lock setup; the threat model comment in `applock.ts` ("a locked device holds nothing that can spend") is only true when the user opts in.

**Impact:** Full fund theft from disk access alone. On Windows especially, WebView2 `localStorage` is plain files under `%LOCALAPPDATA%` — no DPAPI envelope.
**Recommendation:** Store the seed exclusively via OS keystore (Tauri keyring plugin / iOS Keychain / Android Keystore) or at minimum seal it always with a generated-and-keychained secret; delete the plaintext fallback entirely and fail loudly instead.

---

#### C-2. `resolveDeviceSeed()` fetches the seed over HTTP via `/api/wallet/reveal` — custodial regression surface

**File:** `src/lib/deviceseed.ts:77–93`; endpoint declared in `src/api.ts:521`

```ts
const r = await api.reveal();      // GET /api/wallet/reveal → { seed_hex }
setDeviceSeed(r.seed_hex);
```

* When the local device has no seed cached, the app asks the daemon to hand back the seed. On the **hosted daemon** (`https://wallet.zkas.info/daemon`, the default for mobile and web), this means the operator's server returns the raw spending key for a token — i.e., for wallets created via `api.create`/`api.import` (both upload `seed_hex`, `api.ts:513,522`) the server holds the cleartext seed and this call ships it to the client over the network.
* Any XSS or malicious dependency in the page context can call `/reveal` against whatever base is configured and exfiltrate the key. The desktop bridge allowlist includes `/api/wallet/reveal` too (`lib.rs:1004`).
* This contradicts the project's own non-custodial claim for anything but the FVK-watch flow.

**Impact:** Server-side or transport compromise = total loss for all custodial-mode wallets; enlarges XSS blast radius everywhere else.
**Recommendation:** Remove client reliance on `/reveal` for non-custodial wallets; treat seed-on-server as an explicitly-labeled custodial legacy mode, warn loudly, and never auto-call it during background maintenance paths.

---

### HIGH

---

#### H-1. Desktop CSP allows arbitrary `http:`/`https:` connect-src and frames localhost

**File:** `src-tauri/tauri.conf.json:21`

```
connect-src 'self' ipc: http://ipc.localhost http://127.0.0.1:* http: https:;
frame-src http://127.0.0.1:*
```

* `http:` and `https:` in `connect-src` make the CSP a no-op for exfiltration: any injected script can POST the seed/keys anywhere on the internet. Combined with C-1/C-2 this removes the last containment layer for a stored-XSS-in-localStorage class of bug.
* `frame-src http://127.0.0.1:*` permits framing any local service; combined with the sandboxed iframe below, a local port-scan/DNS-rebinding style probe from inside the privileged webview becomes trivial.

**Recommendation:** Pin `connect-src` to the exact daemon origins (`http://127.0.0.1:*` only) plus the two real hosts (`wallet.zkas.info`, explorer, onion). Drop bare schemes.

---

#### H-2. Mining dashboard iframe uses `sandbox="allow-scripts allow-same-origin"`

**File:** `src/pages/Mining.tsx:512–517`

```tsx
<iframe src={`http://127.0.0.1:${BRIDGE_DASHBOARD_PORT}/`}
        sandbox="allow-scripts allow-same-origin" />
```

* `allow-scripts` + `allow-same-origin` together is the documented way to *disable* the sandbox when content is same-origin. Here the frame is cross-origin (loopback vs `tauri://localhost`) which mitigates it today, but the combo also lets the framed content reach `localStorage` of its own origin and defeats future refactors (e.g., proxying the dashboard same-origin would instantly give it script+DOM powers over the wallet page).
* The bridge dashboard is third-party binary output — it should be treated as hostile input.

**Recommendation:** Use `sandbox="allow-scripts"` only; keep it strictly cross-origin; consider rendering metrics via the existing logs/status APIs instead of embedding the vendor HTML.

---

#### H-3. LAN/WAN host-access binds the authenticated wallet API to `0.0.0.0` — WAN mode relies on operator honesty for TLS

**File:** `src-tauri/src/lib.rs:150–156, 526–597, 628`

```rust
let mut bind_host = if exposed { "0.0.0.0" } else { "127.0.0.1" };
...
require_bearer: exposed.then(|| self.wallet_access_token.clone()),
tls: None,   // ← embedded daemon is ALWAYS plain HTTP
```

* `wan` mode is gated in the UI by demanding an HTTPS public URL, but the actual listener stays **cleartext HTTP on all interfaces**; TLS terminates elsewhere (operator's reverse proxy) or nowhere. A misconfigured WAN deployment sends bearer tokens + balance + tx payloads in clear text across the internet, exactly what the comment says must "never" happen.
* Bearer is the only gate; there is no rate limiting, no lockout, no source allowlist. The 64-hex token is strong, but it transits `Authorization` headers on plaintext hops in LAN mode too (LAN sniffing captures it once, forever).

**Recommendation:** For `wan`, refuse to start the raw listener without a locally-managed TLS cert, or bind loopback and require the reverse proxy; add per-source throttling and optional IP allowlist for `lan`.

---

#### H-4. No attempt-limit / hardening on unlock secrets; PIN entropy is brute-forceable offline

**Files:** `src/applock.ts` (seal = PBKDF2-SHA256 600k + AES-GCM, `backup.ts:17`), `src/AppLockScreen.tsx:89–91`, `src-tauri/src/lib.rs:1131–1151 (unlock)`

* The UI explicitly states *"there is no lockout"* (`AppLockScreen.tsx:90`). Online guessing of a 4–6 digit PIN against the sealed record is trivially automated; PBKDF2@600k slows but does not stop (~µs-scale per guess amortized across cores/GPU ⇒ minutes-to-hours for 6-digit space).
* Worse: because the ciphertext is local, the attacker doesn't even need the app — steal the storage, brute force offline.
* Desktop vault passphrase floor is only 8 chars with no strength meter or Argon2 parameters visible in this repo (delegated to `zkas_walletd::verify_wallet_secret`).

**Recommendation:** Memory-hard KDF (Argon2id) for the app-lock record; enforce minimum PIN length ≥ 6 with optional lockout/delay; display KDF params in backup docs for future upgrades.

---

#### H-5. Hosted-default architecture funnels metadata (and sometimes keys) through one operator

**Files:** `src/api.ts:14–30` (defaultBase), `src/api.ts:666–673` (chainBase), `src/pages/SelfHost.tsx`, `src/lib/relay.ts`

* Mobile/native defaults hardcode `https://wallet.zkas.info/daemon` and `.../chain`. Every status poll (1 Hz, `App.tsx:917`), every confirmation lookup, every history read tells the operator which IP has which wallet activity. Shielded notes protect amounts, but timing/correlation privacy is fully delegated.
* First-run gate (`FirstRunConnect.tsx`) mitigates for fresh installs, but returning users and mobile users get no equivalent friction, and the onion option requires external Orbot.

**Recommendation:** Ship Tor-aware transport in-app (or at least make Dandelion++ style relay delays), randomize poll jitter, document the metadata leak prominently in-app.

---

#### H-6. Arbitrary-path `read_backup_file` / `restore_backup` / `list_backups` / `reveal_path` reachable from the webview

**Files:** `src-tauri/src/lib.rs:1186–1199 (reveal_path), 1222–1235 (read_backup_document), 1325–1327, 1333–1347, 1401–1420`

* `reveal_path(path)` spawns `open`/`explorer`/`xdg-open` on any string the webview supplies. No check that the path is inside the backup folder. A compromised renderer can pop Finder/Explorer at arbitrary directories (annoyance/info-disclosure primitive; on some Linux DEs, `.desktop` handling quirks have historically been exploitable).
* `read_backup_document` restricts to `.json` + magic + ≤1 MB, which caps it to probing for backup files by name — but `list_backups` hands the renderer the full list of real backup file paths, confirming where key-bearing files live.
* All commands are registered globally (no Tauri ACL scoping visible in this repo's config), so any future injected content gets them for free.

**Recommendation:** Constrain `reveal_path` to `backup_dir()` descendants after canonicalization; move file picking to the OS dialog plugin instead of typed paths; add Tauri capability files restricting these commands to specific windows.

---

### MEDIUM

---

#### M-1. CORS allow-list on the embedded desktop daemon includes `https://wallet.zkas.info`

**File:** `src-tauri/src/lib.rs:609–621`

A remote HTTPS origin is allowed to read responses from the user's localhost daemon. Exploitability requires knowing the per-install `X-Wallet-Token`, but `/health` is unauthenticated and any future endpoint added without token checks immediately becomes readable/driveable from that origin (drive-by localhost access from a compromised/hostile page on the hosted domain). Loopback-only origins belong in this list; drop the production hostname or gate it behind an opt-in.

#### M-2. `min_share_diff` / stratum exposure

**Files:** `lib.rs:2244–2253 (check_stratum_port binds 0.0.0.0), 333–342 (bridge yaml)`

Stratum intentionally listens on all interfaces with no authentication; payout address is the only credential. An internet-exposed instance (user forwards the port as instructed in `Mining.tsx:386`) lets anyone mine into the operator's payout (harmless) but also hammer vardiff/DoS the bridge, and `POOL_FALLBACK_ADDRESS` env (`lib.rs:2457`) redirects fallback rewards — fine — yet the health/dashboard ports are hardcoded loopback (good). Rate-limit Stratum handshakes and consider optional PSRF/worker-password.

#### M-3. Unauthenticated node gRPC on LAN when `node_lan_rpc` enabled

**File:** `lib.rs:92, 743–757` (`LOCAL_ZKAS_RPC_LAN = "0.0.0.0:16810"`)

Any LAN device gains full node RPC control (submit blocks, poison mempool view feeding walletd scans). Document says "trusted LAN" but there is zero enforcement (no mTLS, no token, no IP pinning). Walletd consuming this RPC trusts its view of chain state — a malicious LAN peer could feed a stale/forked view affecting balance display (funds not directly stealable due to proofs, but denial/panic risk).

#### M-4. Token comparisons and storage hygiene

**Files:** `api.ts:257–273`, `wallets.ts:77–91`, `lib.rs:447–484`

Wallet tokens/access tokens are generated with `rand::thread_rng()` (CSPRNG-backed in rand 0.8 — acceptable) and JS `crypto.getRandomValues` (fine). However tokens are stored in localStorage alongside everything else and compared with non-constant-time string equality server-side (daemon-side concern, out of repo). Low practical risk given entropy; noted for completeness.

#### M-5. Logs may capture sensitive operational data

**Files:** `services.rs:185–197` (logs launch args incl. `--appdir` paths, RPC addrs), `lib.rs:663–666` (`log_crash!` prints engine binding + node), `crash.log`, `services.log` written world-readable-by-umask into app data dir.

No addresses/seeds observed being logged (good), but node endpoints, ports, and PIDs aid local attackers mapping the install; log files lack restrictive permissions on Unix (only token files get 0o600 via `write_private`). Apply 0o600 to all log files.

#### M-6. Status cache & contacts persist balances/addresses in plaintext regardless of App Lock

**Files:** `api.ts:334–385`, `contacts.ts`, `localtx.ts`, `txlabels.ts`

`status_cache_<t>`, `contacts_<t>`, `local_txs_<t>`, `last_known_<t>` survive lock sealing — App Lock seals only seeds (`applock.ts:69–79` sweeps `device_seed_` only). A locked device still leaks who you pay, how much, when, to anyone reading storage. Seal these records too, or accept and document the privacy-at-rest gap.

#### M-7. Payment-link / deep-link ingestion lacks strict validation

**Files:** `main.tsx:251–270`, `paymentlinks.ts`, `App.tsx:124–139`

`openLink` accepts arbitrary `zkas://` URLs from the OS; `internalRouteFromLink` maps to hash routes and `queuePaymentLink` prefills Send forms including **amount** and **memo** from query params. A crafted link (`?payment=zkas:<addr>?amount=…&label=…`) pre-fills a transfer the user must notice and correct. Amount prefill from untrusted links is a classic payment-redirection social-engineering vector; require explicit amount confirmation styling or ignore `amount` from links entirely.

#### M-8. `findReachableDaemon` probes user-supplied hosts — SSRF-ish behavior from installed shells

**File:** `api.ts:118–229`

Installed apps happily attempt `http://` against any entered host/port including cloud metadata ranges (169.254.169.254 etc.). Native shell fetches aren't CORS-bound. Minor, but block-link-local/metadata IPs in `daemonEndpointCandidates`.

#### M-9. Race window: `start_node_preset` sleeps 300 ms then checks liveness

**File:** `lib.rs:2092–2127`

`std::thread::sleep(300ms)` then `running()` — a slow-starting-but-doomed node passes the check, gets marked `node_auto_start=true` + persisted, then dies into the supervisor restart loop. Not security-critical, but persistence of intent flags on failed starts is a state-integrity bug worth fixing with the existing `wait_for_node_listener` helper.

---

### LOW / HARDENING

---

#### L-1. `bridge_config_yaml` injection defenses are validation-dependent

`lib.rs:308–342`. Interpolations are guarded upstream (`validate_endpoint` rejects `"`,`\n`,`\r`; payout parsed by `kaspa_addresses`), but the YAML builder itself performs no escaping. Defense-in-depth: serialize via `serde_yaml` instead of `format!`.

#### L-2. `valid_wallet_token` used as filename guard — OK, but `forget_wallet` builds paths by string

`lib.rs:1349–1396`: `format!("{dir}/{token}.json")`. Validation (32 alnum) precedes use — safe today; prefer `PathBuf::join` to make safety structural.

#### L-3. `parseAmount` float boundary

`noncustodial.ts:157`: single `Math.round(amountFc * 1e8)` conversion — correctly documented as the only float→int hop; values > 2^53/1e8 ≈ 90M coins would lose precision. Add an upper-bound assert.

#### L-4. `sameStatus`/snapshot logic writes balances to localStorage every meaningful change

Unencrypted balance history on disk; ties into M-6.

#### L-5. `installAutoLock` is a deliberate no-op

`applock.ts:216–221`: automatic background re-lock disabled "to avoid surprise relocks". For a wallet this weakens the physical-access story considerably; make idle-relock opt-out rather than absent.

#### L-6. Biometric flag vs keystore lifetime mismatch

`biometric.ts`: `biometric_unlock_enabled` lives in localStorage; the OS-keystore secret survives app-data clears on some platforms, leaving orphaned credentials that re-arm if the flag ever returns (e.g., restored backup of storage). Call `deleteCredentials` opportunistically when lock is disabled.

#### L-7. `check-signer` genesis pin is env-overridable

`package.json:24`: `${ZKAS_GENESIS:-…}` — build-time override of the expected genesis weakens the WASM signer integrity check in CI contexts; pin hard in release pipelines.

#### L-8. Dependency versions

React 19 / Vite 5 / Tauri 2 lines are current-ish; no lockfile audit run in this pass (recommend enabling `npm audit --production` + `cargo deny` in CI — the repo's `.github` workflows were not found to include either).

---

## 3. Things Done Right (worth stating in a submission)

* **On-device verification before signing** (`signer/index.ts:113–135`, `noncustodial.ts:226`): bundle reconstruction, recipient/amount equality, fee read from bundle not response, sighash recomputation — this is the correct design against a lying prover.
* **Fee ceiling scaled to transaction size** (`fees.ts`, `noncustodial.ts:94–100`) after the flat-ceiling bug — good fail-visible remediation culture.
* **SHA-256-pinned binary downloads** with `.part` + atomic replace (`services.rs:1015–1088`).
* **Exact-match API path allowlist** for the desktop bridge (`lib.rs:997–1017`).
* **Orphan-process matching by binary + unique args**, never by port (`services.rs:336–403`) — avoids killing foreign processes.
* **Transactional node-source switching** with rollback (`lib.rs:1526–1556`).
* **Backup docs**: magic + version gate, GCM auth failure mapped to "wrong passphrase", size caps both directions.
* Honest, unusually thorough inline documentation of past incidents (history-loss, gRPC session leak, socat leak) — strong maintainability signal.

---

## 4. Severity Summary Table

| ID | Severity | Component | Title |
|----|----------|-----------|-------|
| C-1 | Critical | deviceseed/applock | Cleartext seed in localStorage; silent plaintext fallback |
| C-2 | Critical | deviceseed/api | Seed retrieved over HTTP via `/reveal`; custodial leakage path |
| H-1 | High | tauri.conf.json | CSP `connect-src http: https:` — no exfiltration containment |
| H-2 | High | Mining.tsx | Iframe sandbox defeated (`allow-scripts allow-same-origin`) |
| H-3 | High | lib.rs | WAN/LAN wallet API on 0.0.0.0, always plaintext HTTP |
| H-4 | High | applock/LockScreen | No lockout; low-entropy PINs brute-forceable offline |
| H-5 | High | api.ts/defaults | Single-operator metadata funnel by default |
| H-6 | High | lib.rs | Unscoped `reveal_path`/file commands from webview |
| M-1..M-9 | Medium | various | See details above |
| L-1..L-8 | Low | various | Hardening items |

---

## 5. Recommended Remediation Priority

1. **Immediately:** kill the plaintext seed fallback (`deviceseed.ts:25–28`); stop calling `/reveal` outside explicit custodial mode.
2. **Next patch:** tighten Tauri CSP; fix iframe sandbox; scope file-system commands with capability restrictions.
3. **Near term:** Argon2id for app-lock; idle re-lock default-on; seal status/contacts caches; WAN TLS enforcement.
4. **Ongoing:** CI dependency auditing, serde-based config serialization, Tor-native transport evaluation.

---

## 6. Methodology & Limitations

Static manual review, file-by-file, of all TypeScript/React sources under `src/`, all Rust sources under `src-tauri/src/`, and build/packaging configuration. Dynamic testing (running daemons, fuzzing the bridge, network interception) was **not** performed. The core daemon `zkas-walletd` and signer WASM internals live in separate repositories and were treated as trusted black boxes except where this repo defines their contracts — several findings (H-3 auth model, M-4 token comparison, vault KDF parameters) ultimately depend on that out-of-tree code and should be re-verified against it.

*Report generated 2026-08-22.*
