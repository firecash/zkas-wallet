import { StrictMode, useState } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import { LockScreen } from "./LockScreen";
import { initDesktop, isDesktop, vaultStatus } from "./desktop";
import "./styles.css";

// On desktop the wallet is gated behind a passphrase: the embedded daemon does
// not run (and the seed cannot be decrypted) until the user unlocks. So the boot
// order is — ask the shell whether this device is locked, show the lock screen if
// it is, and only mount the wallet once the daemon is up. In the browser there is
// no vault and this resolves straight to the app.
function Root({ locked }: { locked: boolean }) {
  const [unlocked, setUnlocked] = useState(!locked);
  if (!unlocked) return <LockScreen onUnlocked={() => setUnlocked(true)} />;
  return <App />;
}

async function boot() {
  let locked = false;
  if (isDesktop()) {
    try {
      const v = await vaultStatus();
      // A legacy cleartext wallet is already running and usable; the app nags to
      // encrypt it from Settings rather than locking the user out of their money.
      locked = !v.unlocked && v.state !== "plaintext";
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

  createRoot(document.getElementById("root")!).render(
    <StrictMode>
      <Root locked={locked} />
    </StrictMode>,
  );
}

boot();
