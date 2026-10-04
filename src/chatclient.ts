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

/** Nostr kinds. Standard ones throughout, so other clients render our users and
 *  we render theirs — the interop is the point, not a side effect. */
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
}

export interface ChatMessage extends ChatEvent {
  person: Person;
  replyTo?: string;
  mine: boolean;
  /** Local-only delivery state for our own messages. */
  pending?: boolean;
  failed?: boolean;
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
type StateHandler = (s: ConnectionState) => void;
export type ConnectionState = "offline" | "connecting" | "live" | "error";

/**
 * One relay connection speaking the Nostr client protocol.
 *
 * Connecting to ONE relay is enough to see the whole network, because relays
 * gossip with each other — so this deliberately does not fan out to many relays
 * the way a typical Nostr client has to.
 */
export class ChatClient {
  private ws: WebSocket | null = null;
  private onEvent: Handler;
  private onState: StateHandler;
  private room: string;
  private closed = false;
  private retry = 0;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private asked = new Set<string>();

  constructor(room: string, onEvent: Handler, onState: StateHandler) {
    this.room = room;
    this.onEvent = onEvent;
    this.onState = onState;
  }

  get live(): boolean {
    return this.ws?.readyState === WebSocket.OPEN;
  }

  setRoom(room: string): void {
    if (room === this.room) return;
    this.room = room;
    this.asked.clear();
    if (this.live) this.subscribeRoom();
  }

  connect(): void {
    if (this.closed) return;
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
    };
    ws.onerror = () => this.onState("error");
    ws.onclose = () => {
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

  /** Fetch display names and published addresses for authors we have seen. */
  requestProfiles(pubkeys: string[]): void {
    const want = pubkeys.filter((p) => !this.asked.has(p));
    if (!want.length || !this.live) return;
    want.forEach((p) => this.asked.add(p));
    this.send(["REQ", `profiles:${want[0].slice(0, 8)}`, { kinds: [KIND_PROFILE], authors: want.slice(0, 200) }]);
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

  publish(signedJson: string): void {
    if (!this.live) throw new Error("offline");
    this.ws!.send(`["EVENT",${signedJson}]`);
  }

  close(): void {
    this.closed = true;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.ws?.close();
    this.ws = null;
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

/** Profile, including the optional address that makes tipping possible. */
export function profileContent(name: string, zkas?: string): string {
  const body: Record<string, string> = {};
  if (name) body.name = name;
  // Publishing an address is opt-in and reversible. It links this chat identity
  // to a payment destination, which is exactly what a tip needs and exactly what
  // someone wanting to stay unlinkable must not do.
  if (zkas) body.zkas = zkas;
  return JSON.stringify(body);
}

/** Parse a kind-0 profile defensively — it is a stranger's JSON. */
export function parseProfile(content: string): { name?: string; zkas?: string } {
  try {
    const d = JSON.parse(content) as Record<string, unknown>;
    const name = typeof d.name === "string" ? d.name.trim().slice(0, 32) : undefined;
    const zkas = typeof d.zkas === "string" && d.zkas.startsWith("zkas:") ? d.zkas.trim() : undefined;
    return { name: name || undefined, zkas };
  } catch {
    return {};
  }
}

/** Count what has arrived in the room since `since`, then disconnect.
 *
 *  Used for the unread badge on the wallet screen. A persistent background
 *  socket would be the obvious implementation and the wrong one: it would hold
 *  the radio open and tell the relay when the wallet is running, for a number. */
export function countSince(room: string, since: number, mine: string): Promise<number> {
  return new Promise((resolve) => {
    let ws: WebSocket;
    try {
      ws = new WebSocket(relayUrl());
    } catch {
      resolve(0);
      return;
    }
    const muted = new Set(mutedKeys());
    let n = 0;
    const done = (v: number) => {
      try {
        ws.close();
      } catch {
        /* already closing */
      }
      resolve(v);
    };
    const timer = setTimeout(() => done(n), 6000);
    ws.onopen = () =>
      ws.send(JSON.stringify(["REQ", "unread", { kinds: [KIND_NOTE], "#t": [room], since, limit: 100 }]));
    ws.onmessage = (msg) => {
      try {
        const f = JSON.parse(String(msg.data));
        if (f[0] === "EVENT" && f[2]) {
          const ev = f[2] as ChatEvent;
          // Our own messages and muted authors are not unread.
          if (ev.pubkey !== mine && !muted.has(ev.pubkey) && ev.created_at > since) n += 1;
        } else if (f[0] === "EOSE") {
          clearTimeout(timer);
          done(n);
        }
      } catch {
        /* ignore malformed frames */
      }
    };
    ws.onerror = () => {
      clearTimeout(timer);
      done(0);
    };
  });
}
