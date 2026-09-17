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
  // History ON from the first scan. A full viewing key can recover this wallet's own
  // sends — recipient, amount, memo — through its outgoing viewing key, but the daemon
  // only records those rows while history is enabled, and it used to start every watch
  // OFF. A viewer then saw no sent transactions and no destinations at all until they
  // found "Recover full history" (reported: "if I import an FVK I can't see tx
  // destinations"). The key already discloses everything to the daemon, so this adds
  // no exposure; the viewer imported it precisely to see.
  const { address } = await api.watch(key.trim().toLowerCase(), birthday, { recoverableHistory: true });
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
