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

const PENDING_KEY = "zkas_pending_view_key";

export interface PendingWatch {
  key: string;
  birthday: number;
}

/// Take a viewing key carried by the URL and HOLD it for confirmation, scrubbing
/// it from the address bar.
///
/// It used to be adopted here, on boot, with no question asked: opening a link
/// someone sent registered THEIR viewing key with the wallet service, created a
/// wallet for it on this device and started scanning — all from a URL, which is
/// the one thing a user can be talked into clicking. No seed is involved so
/// nothing can be spent, but a wallet appearing that the user did not add, and
/// their service scanning a stranger's key, are not things to do unasked. A key
/// that is only watched also looks exactly like one that is owned, which is how
/// a victim is persuaded a payment arrived.
///
/// Held in sessionStorage, deliberately: an unanswered question must not survive
/// the browser being closed and reappear days later with no link to explain it.
///
/// The scrub matters either way: the fragment is never sent to a server, but
/// leaving it in the address bar invites it into a screenshot, a shared link or
/// a synced tab.
export function takePendingViewKey(): PendingWatch | null {
  const key = viewKeyFromUrl();
  if (!key) return readPendingViewKey();
  const pending: PendingWatch = { key, birthday: birthdayFromUrl() };
  try {
    sessionStorage.setItem(PENDING_KEY, JSON.stringify(pending));
  } catch {
    /* storage blocked: the key is still returned, it just will not survive a reload */
  }
  history.replaceState(null, "", `${location.pathname}${location.search}#/`);
  return pending;
}

export function readPendingViewKey(): PendingWatch | null {
  try {
    const raw = sessionStorage.getItem(PENDING_KEY);
    if (!raw) return null;
    const v = JSON.parse(raw) as PendingWatch;
    return isViewKey(v?.key) ? { key: v.key, birthday: Number(v.birthday) || 0 } : null;
  } catch {
    return null;
  }
}

export function clearPendingViewKey(): void {
  try {
    sessionStorage.removeItem(PENDING_KEY);
  } catch {
    /* nothing to clear */
  }
}
