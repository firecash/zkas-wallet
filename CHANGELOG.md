# Changelog

Entries describe what changed for the person using the wallet. Where a fix was
caused by an earlier change in this same list, it says so — the sequence is
more useful than the tidy version.

## 1.0.51

Fixes the light wallet calling a working daemon unreachable — reported as the
newest build showing "Can't reach the wallet service" against the public daemon
where older builds worked.

### Highlights

- **"Can't reach the wallet service" no longer appears on a daemon that is
  answering.** The wallet gave its own status check a 4-second deadline while
  every other request gets 10. That was chosen for a local engine, which holds
  its one wallet in memory and replies instantly — but the public daemon serves
  thousands of wallets, keeps a few in memory, and reads one from disk before it
  can answer, which routinely takes longer than four seconds. Five checks in a
  row missing the deadline raises that screen, so the short deadline made it
  appear roughly four times as often: about a 30% chance of being told the
  service was unreachable while it was working normally, against about 7% before.
  The deadline now matches what it is talking to.
- **A slow answer is no longer treated as no answer.** A check that times out
  means something accepted the connection and is still working on the reply; a
  refused connection means nothing is there. The wallet now waits considerably
  longer before giving up on the first, and still gives up quickly on the second.
- **A momentary hiccup between the daemon and the chain no longer blanks the
  wallet.** One status reply arriving while that link was reconnecting replaced
  everything with "Can't reach the network", even though the balance, the address
  and receiving were all unaffected — the only thing genuinely unavailable in
  that state is sending a new payment. It now has to persist for six seconds
  before it is shown, the same hold already used for the sync indicator.

## 1.0.50

A staging build for the fork window. The app itself is unchanged from 1.0.49 —
same engine, same signer, same fixes; only how release pages are written changed.

### Highlights

- **The upgrade deadline no longer falls off the download page.** Each release
  page carries the previous two versions' notes, which is right for ordinary
  changes and wrong for a deadline: the security fork was announced in 1.0.46, so
  by 1.0.49 — published on the morning of the cutover, with activation a day
  away — the warning had aged off the one page someone upgrading actually opens.
  A dated notice now stays on the latest release for as long as that date is
  still ahead, and sits above everything else.

## 1.0.49

The Android crash at the end of a sync, found from a screen recording: the
progress climbs 99.3, 99.5, then the app dies at 99.8 — every time, and the sync
finishes on the next open.

### Highlights

- **The wallet no longer dies at the end of a long sync.** The last step of a
  sync is the heaviest one in the whole app, and it was asking for about twice
  the memory it needed. Until a wallet has caught up it keeps every record since
  the day the wallet was created, and the moment it catches up it saves all of
  that to disk — building the whole thing in memory twice over to do it. On a
  phone, which is allowed only a few hundred MB no matter how much the device
  has free, the system killed the app right there. It now builds it once. The
  saved file is byte-for-byte what it was, so nothing needs re-syncing.
- **A sync that is interrupted keeps what it had.** The saved file is now
  committed to storage before it replaces the previous one. It was being swapped
  in while the system still had the contents in a write buffer, so a crash or a
  flat battery at that moment could leave a file that looked valid and contained
  nothing — and the next open would start the whole scan again.
- **The app can now say why it closed.** Nothing was recording it, so three
  releases were spent reasoning about which part of the app the crash came from.
  Android has kept that answer since version 11, and the engine log you can send
  from Settings now starts with it: out of memory, a crash inside the wallet
  engine, a freeze, or simply "you swiped the app away". Those have nothing in
  common to fix, and the log also now carries a line for any internal fault
  inside the engine, which previously left no trace at all.
- **Memory is budgeted against what this app is allowed, not what the phone
  has.** The engine kept several wallets fully loaded based on the device's free
  memory, which is not the limit that gets an app killed — the per-app limit is,
  and it is far smaller. It now asks Android for the real figure, and keeps
  fewer wallets loaded on a phone. Switching between wallets may take a moment
  longer; it was buying that speed with the headroom the sync needed.
- **One internal fault no longer disables the engine permanently.** A fault
  while the engine was starting or stopping left a lock that every later call
  tripped over, including the once-a-second check the app makes — so a single
  problem became a wallet that could never run again until the app was
  reinstalled.

## 1.0.48

A reported failure that was never the wallet's fault, and a correction to one of
1.0.47's own fixes.

### Highlights

- **A payment that fails because of the node you are using now says so.** A user
  could not send coins about three months old while running the wallet on their
  own computer, and the same payment went through after switching the chain
  source to a public node. A node that does not keep the full shielded history
  cannot show a spend the notes that were created before its retention point, so
  the wallet reported a shortfall against a balance the user could see — and
  nothing on screen connected that to the node. The error now names the node's
  history limit and the two ways out: switch the chain source to a public node,
  or run your own node with `--archival`. Nothing is lost either way; through a
  node with the full history those coins spend normally.
- **Leaving the app mid-sync is less likely to get the app killed.** 1.0.47
  stopped the wallet from throwing away sync progress whenever you switched
  away, but it held on to that memory too stubbornly: it also ignored the
  system's later, more serious warnings while a sync was running. Those are the
  ones that come just before Android kills the app, and being killed costs more
  than the work it was protecting. It now yields at that point and keeps the
  memory only through the routine "you are in the background" signal.

### If you are running your own node

A node without the full shielded history can only show your wallet the coins
created after its retention point. Spending older coins through it is not
possible — not a wallet limitation, and nothing is at risk — so either point the
wallet at a public node for those payments, or run yours with `--archival`.

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

**The security fork. Any build older than 1.0.46 stops being able to pay at
mainnet DAA 6,983,500 — about 15 October 2026, 15:00 UTC.**

The trigger is the DAA score, not the clock: the dates here are estimates from
the block rate and the chain can reach a score earlier than the estimate says.
The separate cutover at DAA 6,897,100, after which a ZKas coinbase may carry no
merge-mining tag, was reached on 14 October — ahead of its own estimate.

From activation a shielded spend must name the post-fork anchor block it was
built against, and a node judges it by that block's anchor-log entry. Builds
before 1.0.46 sign unnamed spends, which post-fork nodes refuse — so an older
wallet cannot pay after the fork. It is refused cleanly rather than sent wrong,
but it cannot pay.

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
