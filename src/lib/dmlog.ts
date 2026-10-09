/// Private messages YOU sent, kept on this device.
///
/// NIP-17 sends two gift wraps: one to the peer, one to yourself so your other
/// devices can see your own half of the conversation. The second one cannot be
/// filed correctly here: `dm_unwrap` returns `{sender, content, created_at,
/// reply_to, id}` and no recipient, and the wrap's only `p` tag is your own
/// pubkey — so a self-copy resolves its "peer" to YOU. Every message you sent
/// was therefore filed under your own key: a phantom conversation with
/// yourself, while the real thread lost your half of it the moment the sent
/// rows (React state, keyed `local-<timestamp>`) were dropped on a reload.
///
/// So the sent side is recorded here instead, against the peer it actually went
/// to, and survives a reload. Scoped per wallet token: two wallets on one device
/// have different chat identities and must not see each other's messages.
const KEY = "chat_sent_dms_v1";
const MAX_PER_PEER = 500;

export type SentDm = { id: string; peer: string; content: string; created_at: number };

type Store = Record<string, Record<string, SentDm[]>>; // token -> peer -> rows

function read(): Store {
  try {
    const raw = localStorage.getItem(KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : {};
    return parsed && typeof parsed === "object" ? (parsed as Store) : {};
  } catch {
    return {};
  }
}

function write(s: Store): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(s));
  } catch {
    /* quota: a lost local echo must never break sending */
  }
}

/** Everything this wallet has sent, by peer. */
export function loadSentDms(token: string): Record<string, SentDm[]> {
  return read()[token] ?? {};
}

export function recordSentDm(token: string, row: SentDm): void {
  const store = read();
  const forToken = store[token] ?? (store[token] = {});
  const thread = forToken[row.peer] ?? (forToken[row.peer] = []);
  if (thread.some((m) => m.id === row.id)) return;
  thread.push(row);
  // Oldest first, and bounded: a long conversation must not grow localStorage
  // without limit.
  thread.sort((a, b) => a.created_at - b.created_at);
  if (thread.length > MAX_PER_PEER) forToken[row.peer] = thread.slice(-MAX_PER_PEER);
  write(store);
}

/** Dropped with the wallet, like every other per-wallet secret-adjacent record. */
export function forgetSentDms(token: string): void {
  const store = read();
  if (!(token in store)) return;
  delete store[token];
  write(store);
}
