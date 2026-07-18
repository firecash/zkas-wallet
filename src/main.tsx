import { StrictMode, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import { LockScreen } from "./LockScreen";
import { AppLockScreen } from "./AppLockScreen";
import { installAutoLock, isLockEnabled, isUnlocked } from "./applock";
import { initDesktop, isDesktop, vaultStatus } from "./desktop";
import { FirstRunNode, needsNodeChoice } from "./FirstRunNode";
import "./styles.css";

// On desktop the wallet is gated behind a passphrase: the embedded daemon does
// not run (and the seed cannot be decrypted) until the user unlocks. So the boot
// order is — ask the shell whether this device is locked, show the lock screen if
// it is, and only mount the wallet once the daemon is up. In the browser there is
// no vault and this resolves straight to the app.
function Root({ locked, askNode }: { locked: boolean; askNode: boolean }) {
  const [unlocked, setUnlocked] = useState(!locked);
  const [nodeChosen, setNodeChosen] = useState(!askNode);
  // The app lock (PIN/passphrase over the on-device seed) is independent of the
  // desktop vault: it guards the key this device holds, on every platform, and
  // is what mobile uses. Re-locks itself after time in the background.
  const [appUnlocked, setAppUnlocked] = useState(!isLockEnabled() || isUnlocked());
  useEffect(() => {
    installAutoLock(() => setAppUnlocked(false));
  }, []);
  if (isLockEnabled() && !appUnlocked) return <AppLockScreen onUnlocked={() => setAppUnlocked(true)} />;
  if (!unlocked) return <LockScreen onUnlocked={() => setUnlocked(true)} />;
  // Asked after unlock: the node choice changes what the daemon connects to,
  // and there is no point configuring a connection for a wallet still locked.
  if (!nodeChosen) return <FirstRunNode onDone={() => setNodeChosen(true)} />;
  return <App />;
}

async function boot() {
  let locked = false;
  if (isDesktop()) {
    try {
      const v = await vaultStatus();
      // Only an ENCRYPTED seed file needs unlocking. A cleartext wallet is
      // already usable (the app nags to encrypt it from Settings rather than
      // locking anyone out of their money), and a watch-only wallet has no seed
      // here at all — demanding a passphrase for it would protect nothing while
      // making the app look broken.
      locked = v.state === "encrypted" && !v.unlocked;
      // Settings → "Set a passphrase" on a cleartext wallet asks for the setup
      // screen even though the wallet is perfectly usable as-is.
      if (sessionStorage.getItem("vault_setup") === "1") {
        sessionStorage.removeItem("vault_setup");
        locked = true;
      }
    } catch {
      locked = false; // never strand the user behind a broken probe
    }
  }
  // The daemon's port/token must be installed BEFORE the app mounts (api.ts reads
  // them at call time). Unlocking installs them too, so this is for the already-
  // unlocked / browser paths.
  if (!locked) await initDesktop().catch(() => null);

  const askNode = isDesktop() && needsNodeChoice();

  createRoot(document.getElementById("root")!).render(
    <StrictMode>
      <Root locked={locked} askNode={askNode} />
    </StrictMode>,
  );
}

boot();
