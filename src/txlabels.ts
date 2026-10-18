import i18n from "./i18n";
import { readLocal } from "./lib/safestore";

/// Per WALLET, like every other store that holds something about a wallet's payments.
///
/// This was one global key, which left transaction labels out of wallet removal entirely:
/// `walletstate.ts` erases contacts, the local send list, receipts and the view key on
/// "Remove wallet", and its whole premise is that every one of them has to go together —
/// but it never knew about this one, because a global key cannot be swept by a per-wallet
/// prefix. So a user's own notes about what each payment WAS survived the deletion of the
/// wallet they belonged to, indefinitely.
///
/// That is the same metadata contacts calls "the ONLY place a payment can acquire a human
/// name", and on a shielded chain a label is often more revealing than the amount: the
/// chain says nothing, so "rent, March" is the entire disclosure.
const STORAGE_KEY = "zkas_tx_labels_v1";

function key(): string {
  // readLocal for the token: it is a safestore-managed key everywhere else, so reading it
  // any other way would miss what a blocked store refused. The label blob itself stays on
  // the raw accessor — see the deliberate throw in setTxLabel.
  return `${STORAGE_KEY}_${readLocal("wallet_token") || "default"}`;
}

type Labels = Record<string, string>;

/// Adopt labels written before this was keyed per wallet.
///
/// Attributed to whichever wallet reads first, which is the only guess available — nothing
/// recorded who wrote them. The worst case is that one wallet's labels are erased along with
/// another, which errs toward forgetting rather than toward keeping payment notes around
/// after the user asked for them to be gone. Runs once: the legacy key is removed.
function adoptLegacy(): Labels | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const value = JSON.parse(raw);
    localStorage.removeItem(STORAGE_KEY);
    if (!value || typeof value !== "object" || Array.isArray(value)) return null;
    localStorage.setItem(key(), JSON.stringify(value));
    return value as Labels;
  } catch {
    return null;
  }
}

function read(): Labels {
  try {
    const raw = localStorage.getItem(key());
    if (raw === null) {
      const adopted = adoptLegacy();
      if (adopted) return adopted;
    }
    const value = JSON.parse(raw || "{}");
    return value && typeof value === "object" && !Array.isArray(value) ? value as Labels : {};
  } catch {
    return {};
  }
}

export function getTxLabel(txid: string): string {
  const value = read()[txid.toLowerCase()];
  return typeof value === "string" ? value : "";
}

export function setTxLabel(txid: string, label: string): void {
  const labels = read();
  // txKey, not `key`: that name is now the storage key for this wallet's labels, and a
  // local const shadowing it made the write go to a function reference instead.
  const txKey = txid.toLowerCase();
  const clean = label.trim().slice(0, 160);
  if (clean) labels[txKey] = clean;
  else delete labels[txKey];
  try {
    localStorage.setItem(key(), JSON.stringify(labels));
  } catch {
    throw new Error(i18n.t("txlabels.saveFailed"));
  }
}
