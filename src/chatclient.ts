// ZKas chat — transport and composition.
//
// Chat is OFF until the user turns it on, and that is not a style choice. The
// rest of the app talks to one daemon the user chose, optionally over Tor. Chat
// opens a socket to a relay operated by someone else, which learns the user's IP
// and the hours they are awake. That is a material change to the threat model,
// so it is opt-in with the cost stated in plain words — see `ChatConsent`.
//
// The engine (key derivation, signing, proof of work) is a SEPARATE wasm module
// from the payment signer and is imported dynamically. A wallet whose owner
// never enables chat never downloads it, and chat code can never be reached from
// the spend path.

export {
  GLOBAL_ROOM,
  ROOMS,
  chatEnabled,
  setChatEnabled,
  nickname,
  setNickname,
  relayUrl,
  setRelayUrl,
  lastSeen,
  markSeen,
  forgetChat,
  mutedKeys,
  setMutedKeys,
  myZkasAddress,
  setMyZkasAddress,
} from "./lib/chatprefs";
import { GLOBAL_ROOM, relayUrl, mutedKeys } from "./lib/chatprefs";
import { socketAllowed } from "./lib/privacy";

/** Nostr kinds. Standard ones throughout, so nothing here is a private dialect:
 *  a general Nostr client pointed at our relay would render these events, and
 *  this client would render that relay's. That is interop being POSSIBLE, which
 *  is not the same as interop happening — see `ChatClient` on what is actually
 *  deployed. The standard kinds are kept because they cost nothing and are what
 *  a future federation would need, not because anything federates today. */
export const KIND_PROFILE = 0;
export const KIND_NOTE = 1;
export const KIND_REACTION = 7; // NIP-25
export const KIND_MUTE_LIST = 10000; // NIP-51
export const KIND_REPORT = 1984; // NIP-56
export const KIND_GIFT_WRAP = 1059; // NIP-59, carrying a NIP-17 private message

export interface ChatEvent {
  id: string;
  pubkey: string;
  created_at: number;
  kind: number;
  tags: string[][];
  content: string;
  sig: string;
}

/** Everything the UI knows about one person, resolved in one place so the row,
 *  the profile sheet and the mention renderer cannot disagree. */
export interface Person {
  pubkey: string;
  /** Display name, or undefined when they have never published one. */
  name?: string;
  /** Short key fingerprint. Shown ALWAYS beside the name: a nickname is not an
   *  identity and nothing stops two people choosing the same one. */
  fingerprint: string;
  hue: number;
  muted: boolean;
  /** Published `zkas:` address, if any. Tipping is only possible when the author
   *  has published one — a chat key is secp256k1 and an address is Orchard, so
   *  one cannot be derived from the other. */
  zkas?: string;
  /** The first name we ever saw them use. A later change is surfaced rather than
   *  silently accepted, which is what defeats rename impersonation. */
  firstName?: string;
  /** Free text the person wrote about themselves. */
  about?: string;
}

export interface ChatMessage extends ChatEvent {
  person: Person;
  replyTo?: string;
  mine: boolean;
  /** Local-only delivery state for our own messages. */
  pending?: boolean;
  failed?: boolean;
  /** Published, but the relay has not said OK yet. One tick, not two. */
  sending?: boolean;
}

// ------------------------------------------------------------------- engine

type ChatEngine = typeof import("./chat-engine/index.js");

let enginePromise: Promise<ChatEngine> | null = null;

/** Load the chat engine on first use. If it cannot load, say so rather than
 *  degrading silently — a chat that cannot sign is not a chat. */
export function ensureChatEngine(): Promise<ChatEngine> {
  if (!enginePromise) {
    enginePromise = import("./chat-engine/index.js").catch((e) => {
      enginePromise = null;
      throw new Error(`chat-engine-missing: ${e}`);
    });
  }
  return enginePromise;
}

export function fingerprintOf(pubkeyHex: string): string {
  return pubkeyHex.slice(0, 4);
}

export function hueOf(pubkey: string): number {
  let h = 0;
  for (let i = 0; i < Math.min(pubkey.length, 8); i++) h = (h * 31 + pubkey.charCodeAt(i)) % 360;
  return h;
}

// ------------------------------------------------------------------ transport

type Handler = (ev: ChatEvent) => void;
/** How long to wait for a relay's OK before calling a publish failed. */
const ACK_TIMEOUT_MS = 10_000;

type StateHandler = (s: ConnectionState) => void;
/** The relay's verdict on a published event: NIP-01's `["OK", id, ok, reason]`. */
export type AckHandler = (id: string, accepted: boolean, reason: string) => void;
export type ConnectionState =
  | "offline"
  | "connecting"
  | "live"
  | "error"
  /** Tor is on and the relay is not an onion, so connecting would hand it the
   *  user's real IP. Not an error and not retried — the user has to change
   *  something (the relay, or Tor) before it can mean anything else. */
  | "blocked";

/** May we open a socket to the configured relay right now?
 *
 *  The consent screen says the relay learns your IP, and that is a cost the user
 *  accepted. It is NOT a cost they accepted while also having Tor switched on: a
 *  WebView WebSocket cannot traverse the engine's SOCKS proxy, so the socket
 *  would go out in the clear from the real address while the wallet claimed to
 *  be on Tor. Refuse, and say so in the UI. */
export function relayReachable(): boolean {
  return socketAllowed(relayUrl());
}

/**
 * One relay connection speaking the Nostr client protocol.
 *
 * ONE relay is all there is, and it is worth being exact about that because the
 * opposite is easy to assume:
 *
 *   · `chat-relays.ts` ships a single URL, `wss://zkas.info/chat-relay`, and it
 *     is the only relay any ZKas wallet talks to unless its owner sets another
 *     one by hand in Settings.
 *   · Nostr has no relay-to-relay propagation. A note published here does not
 *     reach other relays, and notes published elsewhere do not arrive here.
 *     Our own relay binary has an optional `--peer` mesh — a local extension,
 *     with tests — but the deployed relay runs with no peers configured, and a
 *     third-party relay would not speak it anyway.
 *   · So ZKas chat is a single-relay island today: if that relay is down, the
 *     room is down, and whoever runs it sees every connection.
 *
 * Not fanning out is the RIGHT implementation of that deployment — there is
 * nowhere else to fan out to, and opening sockets to unrelated public relays
 * would hand the user's IP to more operators for nothing. What makes it
 * acceptable is the exit: the relay URL is user-settable, the event format is
 * standard Nostr, and the intended bootstrap is an on-chain registry rather
 * than a list baked into the app. None of that is live yet.
 */
export class ChatClient {
  private ws: WebSocket | null = null;
  private onEvent: Handler;
  private onState: StateHandler;
  private onAck: AckHandler;
  /** Events published and not yet answered, so a silent relay can time out. */
  private awaitingAck = new Map<string, ReturnType<typeof setTimeout>>();
  private room: string;
  private closed = false;
  private retry = 0;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private asked = new Set<string>();

  constructor(room: string, onEvent: Handler, onState: StateHandler, onAck: AckHandler = () => {}) {
    this.room = room;
    this.onEvent = onEvent;
    this.onState = onState;
    this.onAck = onAck;
  }

  get live(): boolean {
    return this.ws?.readyState === WebSocket.OPEN;
  }

  /** Switch rooms on the SAME socket. The two room subscriptions are re-sent
   *  under their existing ids, which replaces them; no reconnect, so a switch
   *  costs one frame instead of a WebSocket handshake.
   *
   *  `asked` is deliberately NOT cleared: who we have already fetched a profile
   *  for does not change with the room, and clearing it re-requested every
   *  author from scratch. */
  setRoom(room: string): void {
    if (room === this.room) return;
    this.room = room;
    if (this.live) this.subscribeRoom();
  }

  get currentRoom(): string {
    return this.room;
  }

  /** One subscription covering the rooms shown in the switcher, so each chip can
   *  carry an unread count without a socket — or a REQ — per room. */
  subscribePeek(rooms: string[], since: number): void {
    if (!this.live || !rooms.length) return;
    this.send(["REQ", "peek", { kinds: [KIND_NOTE], "#t": rooms, since, limit: 200 }]);
  }

  connect(): void {
    if (this.closed) return;
    if (!relayReachable()) {
      // Deliberately no retry: nothing about waiting changes the answer, and a
      // backoff loop here would be a timer that never fires usefully.
      this.onState("blocked");
      return;
    }
    this.onState("connecting");
    let ws: WebSocket;
    try {
      ws = new WebSocket(relayUrl());
    } catch {
      this.onState("error");
      this.scheduleRetry();
      return;
    }
    this.ws = ws;

    ws.onopen = () => {
      this.retry = 0;
      this.onState("live");
      this.subscribeRoom();
    };
    ws.onmessage = (msg) => {
      let frame: unknown;
      try {
        frame = JSON.parse(String(msg.data));
      } catch {
        return;
      }
      if (!Array.isArray(frame)) return;
      if (frame[0] === "EVENT" && frame[2]) this.onEvent(frame[2] as ChatEvent);
      // NIP-01's verdict on something we published. Nothing read this, so a
      // message the relay REFUSED — rate limit, proof-of-work requirement, a
      // blocked room — was painted with the delivered tick and left there. The
      // sender believed it had gone; nobody else ever saw it.
      if (frame[0] === "OK" && typeof frame[1] === "string") {
        const id = frame[1];
        const timer = this.awaitingAck.get(id);
        if (timer) {
          clearTimeout(timer);
          this.awaitingAck.delete(id);
        }
        this.onAck(id, frame[2] === true, typeof frame[3] === "string" ? frame[3] : "");
      }
    };
    ws.onerror = () => this.onState("error");
    ws.onclose = () => {
      // Same reasoning as `close()`: a dropped socket says nothing about
      // whether the relay took the message.
      this.clearAcks();
      this.ws = null;
      if (!this.closed) {
        this.onState("offline");
        this.scheduleRetry();
      }
    };
  }

  private subscribeRoom(): void {
    // A week of history is plenty to open on; a phone should not pull a year of
    // a global room to show the last screenful.
    const since = Math.floor(Date.now() / 1000) - 7 * 24 * 3600;
    this.send(["REQ", "room", { kinds: [KIND_NOTE], "#t": [this.room], since, limit: 200 }]);
    this.send(["REQ", "reactions", { kinds: [KIND_REACTION], "#t": [this.room], since, limit: 500 }]);
  }

  /** Fetch display names and published addresses for authors we have seen.
   *
   *  ONE subscription id, reused. It used to mint `profiles:<prefix>` per batch,
   *  and a relay keeps at most MAX_SUBSCRIPTIONS (20) per connection — so after
   *  roughly sixteen batches, which a busy global room reaches in minutes, the
   *  connection was at its cap and every later REQ was dropped. Including the
   *  one that changes room: switching silently stopped working on a long-lived
   *  session. Reusing the id REPLACES the subscription instead of adding one,
   *  which is what NIP-01 says it does.
   *
   *  Asking for the union of everyone seen so far (not just the new batch) keeps
   *  that single replacement from losing the authors of earlier batches. */
  requestProfiles(pubkeys: string[]): void {
    const want = pubkeys.filter((p) => !this.asked.has(p));
    if (!want.length || !this.live) return;
    want.forEach((p) => this.asked.add(p));
    // Newest-first so the cap trims the oldest authors, whose profiles have
    // already arrived, rather than the ones just seen.
    const authors = [...this.asked].reverse().slice(0, 500);
    this.send(["REQ", "profiles", { kinds: [KIND_PROFILE], authors }]);
  }

  /** Private messages addressed to us.
   *
   *  Every wrap is signed by a one-time key, so this filter reveals only that
   *  *someone* is addressing us — which is the point of the wrap. */
  subscribeDms(pubkey: string): void {
    if (!this.live) return;
    this.send(["REQ", "dms", { kinds: [KIND_GIFT_WRAP], "#p": [pubkey], limit: 500 }]);
  }

  /** Our own mute list, so a block set on another device applies here. */
  requestMuteList(pubkey: string): void {
    if (!this.live) return;
    this.send(["REQ", "mutes", { kinds: [KIND_MUTE_LIST], authors: [pubkey], limit: 1 }]);
  }

  /** Publish, and expect a verdict. `id` lets the caller match the `OK` frame. */
  publish(signedJson: string, id?: string): void {
    if (!this.live) throw new Error("offline");
    this.ws!.send(`["EVENT",${signedJson}]`);
    if (!id) return;
    // A relay that simply never answers is as much a failure as one that
    // refuses. Without this the message would sit on "sending" for ever.
    const timer = setTimeout(() => {
      this.awaitingAck.delete(id);
      this.onAck(id, false, "timeout");
    }, ACK_TIMEOUT_MS);
    this.awaitingAck.set(id, timer);
  }

  close(): void {
    this.closed = true;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.clearAcks();
    this.ws?.close();
    this.ws = null;
  }

  /**
   * Drop the pending ack timers without declaring anything failed.
   *
   * A socket that closes is not evidence the relay refused anything. The timers
   * used to survive it and fire ten seconds later, marking a message the relay
   * had ACCEPTED and fanned out as "Not sent" — and the retry that offers
   * re-signs with a fresh timestamp, so it publishes a SECOND copy: the sender
   * sees one message, the room sees two. A phone changing networks or a Tor
   * circuit rotating is enough to trigger it.
   */
  private clearAcks(): void {
    for (const timer of this.awaitingAck.values()) clearTimeout(timer);
    this.awaitingAck.clear();
  }

  private send(frame: unknown): void {
    if (this.live) this.ws!.send(JSON.stringify(frame));
  }

  /** Back off with a ceiling: a phone in a tunnel must not spin the radio. */
  private scheduleRetry(): void {
    if (this.closed) return;
    const delay = Math.min(30_000, 1000 * 2 ** Math.min(this.retry, 5));
    this.retry += 1;
    this.retryTimer = setTimeout(() => this.connect(), delay);
  }
}

// -------------------------------------------------------------------- compose

/** Sign any event with the chat identity derived from the wallet's own secret.
 *
 *  One path for every kind, so retry, failure handling and proof of work behave
 *  identically whether the user is posting, reacting, muting or reporting. */
export async function signAs(
  secret: string,
  account: number,
  kind: number,
  tags: string[][],
  content: string,
  difficulty = 0,
): Promise<string> {
  const engine = await ensureChatEngine();
  const id = await engine.chatIdentity(secret, account);
  return engine.signEvent(
    id.privkey_hex,
    kind,
    JSON.stringify(tags),
    content,
    Math.floor(Date.now() / 1000),
    difficulty,
    20_000,
  );
}

export function noteTags(room: string, replyTo?: { id: string; pubkey: string }): string[][] {
  const tags: string[][] = [["t", room]];
  if (replyTo) {
    // NIP-10, so the thread renders in other Nostr clients too.
    tags.push(["e", replyTo.id, "", "reply"]);
    tags.push(["p", replyTo.pubkey]);
  }
  return tags;
}

/** NIP-25 reaction. `+` is the conventional "like". */
export function reactionTags(target: ChatEvent, room: string): string[][] {
  return [
    ["e", target.id],
    ["p", target.pubkey],
    ["t", room],
  ];
}

/** NIP-56 report. */
export function reportTags(target: ChatEvent, reason: string): string[][] {
  return [
    ["e", target.id, reason],
    ["p", target.pubkey],
  ];
}

/** NIP-51 mute list: every muted key as a `p` tag, replacing the previous list. */
export function muteTags(keys: string[]): string[][] {
  return keys.map((k) => ["p", k]);
}

/** Maximum bio length. Long enough for a sentence or two, short enough that a
 *  profile sheet stays a profile sheet and a room of them stays readable. */
export const ABOUT_MAX = 160;

/** Profile, including the optional address that makes tipping possible. */
export function profileContent(name: string, zkas?: string, about?: string): string {
  const body: Record<string, string> = {};
  if (name) body.name = name;
  // `about` is the standard Nostr field for this, so a bio written here shows up
  // in every other client, and theirs shows up here.
  if (about) body.about = about.slice(0, ABOUT_MAX);
  // Publishing an address is opt-in and reversible. It links this chat identity
  // to a payment destination, which is exactly what a tip needs and exactly what
  // someone wanting to stay unlinkable must not do.
  if (zkas) body.zkas = zkas;
  return JSON.stringify(body);
}

/** Parse a kind-0 profile defensively — it is a stranger's JSON. */
export function parseProfile(content: string): { name?: string; zkas?: string; about?: string } {
  try {
    const d = JSON.parse(content) as Record<string, unknown>;
    const name = typeof d.name === "string" ? d.name.trim().slice(0, 32) : undefined;
    const zkas = typeof d.zkas === "string" && d.zkas.startsWith("zkas:") ? d.zkas.trim() : undefined;
    // Truncated AND stripped of line breaks: a stranger controls this string, and
    // a hundred newlines in it would push every other row off the sheet.
    const about =
      typeof d.about === "string" ? d.about.replace(/\s+/g, " ").trim().slice(0, ABOUT_MAX) : undefined;
    return { name: name || undefined, zkas, about: about || undefined };
  } catch {
    return {};
  }
}

/** Unread across every room this user follows, plus private messages.
 *
 *  One short-lived connection, two subscriptions, then disconnect. A persistent
 *  background socket would be the obvious implementation and the wrong one: it
 *  would hold the radio open and tell the relay whenever the wallet is running,
 *  for a number.
 *
 *  It used to take a single room — the one last open — so a message in your own
 *  language's room, or a private message, never reached the badge at all.
 *
 *  Private messages are counted by gift-wrap ID, never by time: a wrap carries a
 *  randomised timestamp up to two days in the past, and the real one is inside,
 *  behind the key and the engine. An id needs neither.
 */
export function countUnread(opts: {
  rooms: string[];
  /** Per-room read cursor. */
  since: (room: string) => number;
  /** Our own chat pubkey; "" when this device has not derived one yet. */
  mine: string;
  /** Gift-wrap ids already accounted for. */
  seenWraps: string[];
  timeoutMs?: number;
}): Promise<{ rooms: number; dms: number }> {
  const { rooms, since, mine, seenWraps, timeoutMs = 6000 } = opts;
  return new Promise((resolve) => {
    const empty = { rooms: 0, dms: 0 };
    // The unread badge is not worth a clearnet socket from a Tor user.
    if (!relayReachable() || !rooms.length) {
      resolve(empty);
      return;
    }
    let ws: WebSocket;
    try {
      ws = new WebSocket(relayUrl());
    } catch {
      resolve(empty);
      return;
    }
    const muted = new Set(mutedKeys());
    const seen = new Set(seenWraps);
    // By event id, because the two subscriptions can both deliver a given event
    // and a relay may replay one; counting frames would double-count.
    const roomHits = new Set<string>();
    const dmHits = new Set<string>();
    let open = mine ? 2 : 1; // no pubkey, no DM subscription to wait for
    const out = () => ({ rooms: roomHits.size, dms: dmHits.size });
    const done = () => {
      try {
        ws.close();
      } catch {
        /* already closing */
      }
      resolve(out());
    };
    const timer = setTimeout(done, timeoutMs);
    ws.onopen = () => {
      // One filter covers every followed room; `since` is the OLDEST cursor and
      // each event is then checked against its own room's cursor below.
      const oldest = Math.min(...rooms.map((r) => since(r)));
      ws.send(JSON.stringify(["REQ", "unread", { kinds: [KIND_NOTE], "#t": rooms, since: oldest, limit: 300 }]));
      if (mine) ws.send(JSON.stringify(["REQ", "unread-dm", { kinds: [KIND_GIFT_WRAP], "#p": [mine], limit: 300 }]));
    };
    ws.onmessage = (msg) => {
      try {
        const f = JSON.parse(String(msg.data));
        if (f[0] === "EVENT" && f[2]) {
          const ev = f[2] as ChatEvent;
          if (ev.kind === KIND_GIFT_WRAP) {
            if (!seen.has(ev.id)) dmHits.add(ev.id);
            return;
          }
          const where = ev.tags.find((tg) => tg[0] === "t")?.[1];
          // Our own messages and muted authors are not unread.
          if (!where || ev.pubkey === mine || muted.has(ev.pubkey)) return;
          if (ev.created_at > since(where)) roomHits.add(ev.id);
        } else if (f[0] === "EOSE" || f[0] === "CLOSED") {
          if (--open > 0) return;
          clearTimeout(timer);
          done();
        }
      } catch {
        /* ignore malformed frames */
      }
    };
    ws.onerror = () => {
      clearTimeout(timer);
      resolve(out());
      try {
        ws.close();
      } catch {
        /* already closing */
      }
    };
  });
}
