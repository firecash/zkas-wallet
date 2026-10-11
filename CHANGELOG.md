# Changelog

Entries describe what changed for the person using the wallet. Where a fix was
caused by an earlier change in this same list, it says so — the sequence is
more useful than the tidy version.

## 1.0.47

Two things people reported on Android: the app crashing when opened while a wallet
was still syncing, and a sync that appears to start over every time you leave the
app. Same area, different bugs.

### Highlights

- **The app no longer crashes while a wallet is syncing.** The service that keeps
  the engine alive during a sync asked Android for foreground status without
  handling a refusal — and Android refuses when the request lands while the app is
  in the background, or when the daily budget for this kind of background work is
  spent. A refusal arriving with nothing to catch it closes the app. Reported as a
  crash on the first open of the day, once per wallet, with the sync completing
  normally on the second attempt — and that crash also skipped the orderly save, so
  scan progress since the last checkpoint went with it.
- **Leaving the app no longer throws away sync progress.** Android sends a signal
  when the app's screen is no longer visible, and the wallet was treating it as a
  low-memory emergency: it handed back the engine's decoded-leaf cache every single
  time you switched apps. The block scan itself kept its place, but the expensive
  part — building the spend witnesses, which is what the percentage near the end of
  a sync is showing — had to start again. Check your phone a few times during a long
  sync and it could never finish. Real memory pressure still releases that cache, and
  being about to be killed still does; being tabbed out does not.
- **A sync that outlives the app being killed resumes properly.** The app asked to
  hold the engine open once per sync and then assumed it had it, so when Android
  stopped that service — its own decision, or the background budget running out —
  nothing ever asked again, and the engine was frozen at the next switch away. It is
  re-asserted once a minute while syncing now, and not at all once synced.

### Also

- Asking to hold the engine open is idempotent, so a sync costs one request a minute
  instead of one per status poll.
- The memory-level decision is now a plain function with tests. The bug it replaces
  compiled, linted and ran correctly while doing the opposite of what it said, because
  Android's memory levels are not ordered by severity — "your UI is hidden" sorts
  above "memory is critical".

## 1.0.46

**The security fork. Upgrade before 14 October 2026, about 13:40 UTC.**

The ZKas network forks at mainnet DAA score 6,983,500 (about 15 October 2026,
15:00 UTC). From that point a shielded spend must name the post-fork anchor
block it was built against, and a node judges it by that block's anchor-log
entry. Every build before this one signs unnamed spends, which post-fork nodes
refuse — so an older wallet cannot pay after the fork. It is refused cleanly
rather than sent wrong, but it cannot pay.

This release rebuilds the parts that sign: the on-device engine in the Android
app, the WebAssembly signer the web and desktop wallets use, and the desktop
binaries. All three now come from the fork code (zkas-rusty 01ac1865).

### Highlights

- **Spends name their anchor block**, so they are accepted after the fork.
  Nothing changes in how you send; a wallet that is not upgraded simply stops
  being able to pay once the fork activates.
- **Sends pause around the fork.** The daemon holds them from about 600 DAA
  before activation to about 1,260 DAA after — roughly 32 minutes — because a
  spend built against a pre-fork anchor cannot be judged by the post-fork
  rules. Balances, receiving and history are unaffected.
- **Desktop builds are pinned to the fork commit.** Desktop CI used to build
  against whatever the node repo's default branch happened to be, so the 1.0.45
  desktop binaries carry a superseded activation score and must be replaced.
  Which consensus rules a desktop build carries is now recorded in this repo.
- **"Add account" no longer leaves you waiting, or renumbered.** It used to
  make the new wallet active and then register it, with up to three minutes
  allowed for the registration — so the wallet bar showed a new name and
  account number while the address and balance still came from the previous
  wallet, and a registration that hung or timed out left you on a wallet that
  did not exist. A new account is now built in the background and switched to
  only once it exists, with a 45-second limit and a plain message if the
  service does not answer. Reported as "Wallet 5 / Account 8", stuck loading,
  and as a new account showing the previous one's address.
- **An account number is no longer consumed by an attempt that failed.** It was
  spent the moment the number was handed out, so a creation that never finished
  burned it for good — which is why the numbering ran ahead of the wallets ("4
  Wallet 4 / Account 7"). A number that has belonged to a real wallet is still
  never reissued.
- **Cleaning up after a failed account no longer signs you out.** The first
  version of that rollback cleared the active-wallet key for any wallet it tidied
  up, so a failed "Add account" ejected you into a brand-new empty wallet.

### If you run a node, pool or miner

The wallet is only one side of this. Both of these must be upgraded on the same
deadline:

- **Node `zkas-v1.0.11`** — mandatory. At the fork the 5% dev fee ends and
  miners keep the whole subsidy, merge mining moves to the bound `ZKM1` form
  (the legacy `ZKMM` form is refused), and miner rewards accrue in one carried
  slot. A node that has not upgraded splits from the network.
- **Stratum bridge `solo-dual-mode v1.0.12`** — required for the `ZKM1` merge
  mining form.

Do not run node builds of `23767efa` or `1e684932`: they carry other activation
scores and will split.

## 1.0.45

Everything here came from deliberately breaking the wallet: a daemon made to
return 500s, empty bodies, malformed rows and nonsense figures; the network cut
mid-send; two tabs fighting over one wallet; a browser with site data blocked.

### Highlights

- **A wallet switch in another tab could re-target a payment already on the
  Confirm screen.** The sheet kept showing the first wallet's amount and
  recipient while the payment was prepared, signed and broadcast from the
  second. A payment now refuses to proceed if the wallet changed under it.
- **A wallet creation that failed at the last step kept your recovery phrase
  and never showed it** — then became the device master, so the next "Add
  account" built a real, fundable wallet from a phrase you had never seen and
  would never be reminded to write down. A failure now rolls the whole thing
  back.
- **A daemon wrong about being synced could show "0 ZKAS · Ready"** for a funded
  wallet, and that zero was saved as the last confirmed balance, outliving the
  daemon and surviving a reload.
- **A single malformed history row, or an empty response, took down the whole
  wallet** — balance, Send and Receive — not just the History tab.
- **A browser with site data blocked showed an unrecoverable error screen.** The
  wallet now runs with ephemeral storage instead, behaving like a fresh device.
- Removing a wallet left its private messages on the device.

Full detail in
[CHANGELOG.md](https://github.com/firecash/zkas-wallet/blob/main/CHANGELOG.md).

### Everything else

- History responses are sanitised at the API boundary: a row that cannot be
  understood is dropped rather than repaired, because inventing an amount puts
  a wrong number in a list of payments.
- Release notes lead with highlights and link the full changelog.
- The release script recognises any CI placeholder body, not one literal
  string — v1.0.44 first published with "macOS (Intel) desktop wallet." as its
  entire release page.

## 1.0.44

### Highlights

- **Typing a decimal comma sent ten times the amount.** `1,5` became `15`, in
  both Send and payment requests.
- **A partial send left the full amount in the form**, so one more tap could pay
  160 against a 100 invoice.
- **A wallet switch in another tab could re-target a payment already on the
  Confirm screen**, spending from an account you never chose.
- **A wallet creation that failed at the last step kept your recovery phrase and
  never showed it**, then built real accounts from it.
- **The backup card showed a derived key instead of your recovery phrase** and
  skipped the write-it-down step.
- **Background sync stopped the moment the screen went off** on Android.
- **Chat history is kept on the device** instead of re-downloading a week of it
  on every open, and private messages you sent survive a reload.
- **Your chat blocklist was being published to the relay** while the screen said
  it was private.
- Every new account showed the first account's address; two wallets could end up
  sharing a name.
- A malformed history row, an empty response, or a browser with site data
  blocked could take the whole wallet down.
- After a network change the wallet froze for about a minute before recovering.
- The release script had been deleting the on-device engine before every build.

Full detail below, and in
[CHANGELOG.md](https://github.com/firecash/zkas-wallet/blob/main/CHANGELOG.md).

### Everything else

The release that came out of a line-by-line audit of the whole app: the money
path, keys and backups, chat, the Android background worker, 24 locales, the
desktop shell, and the screens themselves. Several entries below are fixes to
bugs introduced earlier in this same release cycle; they are kept visible
because they are the ones most worth knowing about.

### Money

- **A decimal comma sent ten times the amount.** Typing `1,5` produced `15` in
  both the Send field and a payment request. The fix had been written earlier
  but lived in a file the app did not import, so it never shipped; the running
  code had its own copy. Separator handling is now correct across eleven
  conventions, including European grouping (`1.234.567`) and Arabic-Indic
  digits.
- **A partial send left the full amount in the form.** After a 100 ZKAS payment
  broadcast 60 and then failed, the field still read 100 and the error named no
  figure — one more tap paid 160 against a 100 invoice. The field now holds the
  remainder and the message states both numbers.
- **Receiving money while a send was pending showed a balance that was too
  low** and refused to spend the difference, for up to two hours. A mining
  wallet could never clear it.
- **A custom fee below the node's floor was shown as the exact total**, and the
  fee field quoted a range 5.5× under the truth.
- Scanning a plain address QR after a request QR kept the previous amount *and*
  memo — a stranger received the earlier invoice number in their note.
- Receive could build a payment QR before the wallet had an address: a request
  that paid nobody, with Copy reporting success having copied nothing.
- "Prove payment" and "Verify a payment" were dead on desktop, showing a raw
  backend string. Three endpoints the app calls were missing from the desktop
  proxy's allowlist.

### Keys, backups and accounts

- **A recovery phrase was stored before anything validated it.** One mistyped
  word left a secret on the device for a wallet that was never created, made
  "Create new wallet" permanently unreachable, and left the phrase in storage
  in the clear.
- **The post-creation backup card showed the derived account key, not the
  recovery phrase** — and the hex shape made it skip the write-it-down quiz
  entirely. People were copying down a key that restores one wallet and no
  other account.
- The backup *file* chose its secret without checking the phrase owns the
  wallet, so it could be encrypted with a phrase that cannot restore the wallet
  it is labelled for.
- The reveal screen could print "Your recovery phrase" above 64 hex characters,
  and its copy button claimed success for a phrase that never reached the
  clipboard.
- **A restore invented accounts and duplicated existing ones.** A device holding
  accounts 0 and 5 restored as 0–5, registering four that never existed.
  Backups now record the real account list.
- **Every new account showed the first account's address** in "Your wallets".
- **Two wallets could end up sharing a name permanently** after a removal.
- A failed "Add account" burned an index silently, so numbering ran ahead of
  reality ("Wallet 4" labelled "Account 6"), and the button itself reported
  nothing when it failed.
- Removing a wallet left its shelved spending key sealed on the device, and
  "Stop watching" did not stop watching — the wallet returned on the next poll,
  now offering Send for a key the device does not hold.
- The app lock could read "On" while protecting nothing on a watch-only device,
  with wallets created afterwards written in the clear.

### Privacy

- **The viewing key could leave over clearnet while the app said Tor was on.**
- **Your chat blocklist was published to the relay**, in cleartext and signed,
  while the screen said "Muting is yours alone". Mutes are local now, and a
  relay can no longer mute people on your device.
- One privacy gate now covers every outbound request, including the embedded
  explorer, which previously loaded from the real IP with Tor enabled.
- Hidden balances stay hidden on the two screens that ignored the setting.
- An irreversible privacy choice was reported backwards in Settings.

### Chat

- **History is kept on the device.** Opening a room used to re-download a week
  of it, and every connect re-decrypted up to 500 gift wraps — the slowest part
  of starting chat was work already done. Rooms and conversations now live in
  IndexedDB and the relay is asked only for what is new. Scrolling back pages
  from the device first.
- Messages you sent in a private conversation were lost on reload; they were
  filed under your own key as a conversation with yourself.
- A message the relay refused showed the delivered tick; the relay's verdict was
  never read. A dropped socket could also mark a delivered message "Not sent",
  and retrying posted it twice.
- **Unread counts.** A message stayed unread after being read; then the fix for
  that let one badly-dated message mark ten minutes of real ones read; and
  leaving a room marked its whole backlog read even if nothing was read.
- Reading history drifted under your eyes as messages arrived, and at one point
  jumped back into older history and disabled paging entirely.
- Tapping an avatar or a name now opens that person's profile.
- A reply could not be cancelled — the jump-to-latest button sat on top of the
  X. With a long draft the same button landed inside the composer.
- A reply and a draft survived a room switch, so a message could be posted to
  the wrong room tagged with another room's message.
- Offline said "Connecting…" for ever, with no retry and a composer inviting a
  message that could not be sent.

### Android

- **Background sync died the moment the screen went off.** The engine runs
  inside the app process, which Android freezes without a foreground component
  — and the service written for exactly that was only ever started while the
  app was open. Leaving the app also now spends one expedited slot to catch up,
  rather than waiting on a periodic job that Doze defers.
- A failed "Route through Tor" start left the wallet unusable and unrecoverable
  from inside the app: every call refused, with no way back.
- A node or Tor change was silently discarded after any reload while reporting
  success.
- Settings claimed auto-consolidation was on in phone mode, where it never ran.
- "Erase this device" left the fingerprint binding behind, so unlock prompts
  succeeded and the app stayed locked.
- The default node is now `seed.zkas.info`, so an address can change without an
  app release. Existing installs on the old hardcoded address migrate; a node
  you chose yourself is left alone.

### Reliability

- **After a network change the wallet froze for about a minute**, then waited to
  recover. Those sockets hang rather than fail, so nothing noticed. Now ~25
  seconds to notice and instant recovery, verified not to cry wolf on 2G.
- A node at its connection limit said "hit a problem while reading the chain",
  which explains nothing. It now says the node is busy and what to do.
- The explorer blanked its whole dashboard on a first visit if one endpoint was
  down, and blamed the server when Tor was the reason.
- Node and mining screens presented a dead supervisor's last readings as live.
- A desktop lock screen that could not reach the daemon sat on "Starting…" for
  ever with no error and no retry.

### Interface

- Escape closed nothing, anywhere — fifteen overlays on web and desktop.
- The Receive QR is drawn rather than rasterised, and a stray bracket that was
  parked in the sheet header (a two-letter CSS class colliding with the boot
  screen) sits on the frame.
- "WALLET SERVICE" was clipped in plain English on every screen; German and
  Russian clipped settings rows mid-word; 320px screens overlapped.
- Tap targets below 44px across the app, including a link present on every
  screen that was 15px tall.
- The motion-reduction setting stopped 4 of 14 animations; it now stops all the
  decorative ones and deliberately leaves spinners running.
- Transaction history showed no year, so payments twelve months apart read
  identically.
- "Copied ✓" appeared when the clipboard had not been touched.
- A transaction the chain had never seen was reported as confirmed.
- Adding a contact for an address already saved silently destroyed its name.

### Translations

- **The audit that gates releases never opened the locale files.** English moved
  on and all 24 translations fell behind with CI green — including a partial-send
  warning that lost both of its amounts in every language but English. The gate
  now fails on a missing key, a dead key, or a placeholder that does not match
  English.

### Build and release

- **The release script deleted the on-device engine before every build** and
  then shipped the result: the Android build treats a missing engine as
  "best-effort" and warns, so a hosted-only app went out looking normal. The
  engine is preserved and the script refuses to publish an APK without it.
- CI runs the tests before building a desktop release.

## 1.0.43

- Five bugs found by audit: false "payment received" notices, a Max amount the
  daemon would reject, lost private messages, leaked keys, and a frozen badge.
- The misplaced balance eye, an unreadable "Copied", and a stretched desktop
  layout.

## 1.0.42

- 46% off the main bundle, and two ungated outbound requests closed.

## 1.0.41

- Your own chat profile moved to where people look for it.

## 1.0.40

- **Chat arrives**: a community room and private messages, inside the wallet,
  translated into all 24 languages and working right-to-left.
- One privacy gate for every outbound request, closing cleartext and seed
  leaks.
- The wallet asks before a link makes the device watch someone else's wallet.
- Gestures that muted people by accident, the unread count, and the message
  menu on tap.
- Send ZKAS directly from a person in chat.
- The chat engine is guarded against the wasm drift that broke 1.0.25.

## 1.0.39

See the release notes for v1.0.39 and its release candidates.
