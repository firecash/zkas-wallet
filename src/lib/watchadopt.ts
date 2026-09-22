import { api } from "../api";
import { addWallet, ensureRegistered } from "../wallets";
import { birthdayFromUrl, isViewKey, setWatchKey, viewKeyFromUrl } from "./watchonly";
import { rememberBirthday } from "./deviceseed";
import i18n from "../i18n";

/// Turn this browser into a viewer of someone's wallet, from a link.
///
/// Registers the viewing key with the wallet service so it scans for that
/// wallet's notes, and records it locally. No seed is stored, so this device
/// cannot spend — see `isWatchOnly`.
export async function adoptViewKey(key: string, birthday = 0): Promise<string> {
  if (!isViewKey(key)) throw new Error(i18n.t("watchonly.invalidViewKey"));
  // A fresh token, always. Adopting into the ACTIVE wallet would point this
  // device's existing wallet at someone else's key, and on a device that already
  // has a spending wallet that would quietly replace what the user can spend
  // with something they only watch.
  const token = addWallet();
  // The daemon records history from the first scan: a full viewing key recovers this
  // wallet's own sends — recipient, amount, memo — through its outgoing viewing key,
  // so a viewer sees destinations without any further step.
  const { address } = await api.watch(key.trim().toLowerCase(), birthday);
  setWatchKey(key);
  // Keep the birthday the link carried: a later history recovery scans from here
  // instead of replaying the chain from genesis for a wallet born last week.
  rememberBirthday(birthday, address);
  ensureRegistered(token, address);
  return address;
}

/// Adopt a viewing key carried by the URL, then scrub it from the address bar.
///
/// Returns true when one was adopted. The scrub matters: the fragment is never
/// sent to a server, but leaving it in the address bar invites it into a
/// screenshot, a shared link or a synced tab.
export async function adoptViewKeyFromUrl(): Promise<boolean> {
  const key = viewKeyFromUrl();
  if (!key) return false;
  try {
    await adoptViewKey(key, birthdayFromUrl());
    return true;
  } finally {
    history.replaceState(null, "", `${location.pathname}${location.search}#/`);
  }
}
