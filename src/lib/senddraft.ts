/// What the user had typed into Send, kept across a reload.
///
/// A phone reclaims a backgrounded tab freely, and the moment it is most likely
/// to do so is exactly the moment it hurts: the user has switched to another app
/// to copy a recipient address. Coming back used to show an empty form on the
/// wallet home screen — the pasted address, the amount and the memo all gone,
/// with nothing to recover them from.
///
/// Scoped per wallet token, so switching wallets cannot put one wallet's draft
/// into another's form, and given a short life so an address does not sit in
/// storage indefinitely after the user has moved on.
const KEY = "send_draft_v1";
const MAX_AGE_MS = 24 * 60 * 60 * 1000;

export type SendDraft = { to: string; amount: string; memo: string };

type Stored = SendDraft & { token: string; at: number };

function parse(raw: string | null): Stored | null {
  if (!raw) return null;
  try {
    const d = JSON.parse(raw) as Partial<Stored>;
    if (typeof d?.token !== "string" || typeof d?.at !== "number") return null;
    return {
      token: d.token,
      at: d.at,
      to: typeof d.to === "string" ? d.to : "",
      amount: typeof d.amount === "string" ? d.amount : "",
      memo: typeof d.memo === "string" ? d.memo : "",
    };
  } catch {
    return null;
  }
}

/** The draft for this wallet, if there is a recent one worth restoring. */
export function loadSendDraft(token: string): SendDraft | null {
  if (!token) return null;
  let stored: Stored | null = null;
  try {
    stored = parse(localStorage.getItem(KEY));
  } catch {
    return null; // storage unavailable (private mode, blocked): just start empty
  }
  if (!stored || stored.token !== token) return null;
  if (!(Date.now() - stored.at < MAX_AGE_MS)) {
    clearSendDraft();
    return null;
  }
  // An empty draft is not worth restoring, and keeping it would mean rewriting
  // the key on every keystroke that clears the form.
  if (!stored.to && !stored.amount && !stored.memo) return null;
  return { to: stored.to, amount: stored.amount, memo: stored.memo };
}

export function saveSendDraft(token: string, draft: SendDraft): void {
  if (!token) return;
  try {
    if (!draft.to && !draft.amount && !draft.memo) {
      clearSendDraft();
      return;
    }
    localStorage.setItem(KEY, JSON.stringify({ ...draft, token, at: Date.now() } satisfies Stored));
  } catch {
    /* quota or blocked storage: a lost draft must never break sending */
  }
}

/** Called once the payment is away, and when the user clears the form. */
export function clearSendDraft(): void {
  try {
    localStorage.removeItem(KEY);
  } catch {
    /* ignore */
  }
}
