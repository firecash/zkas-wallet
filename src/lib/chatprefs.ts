// Chat preferences: the consent flag and the local state around it.
//
// Split out from `chatclient.ts` deliberately. The wallet's main screen needs to
// know whether chat is on, to label the button and show an unread count — and if
// that lived in the client module, the whole transport would be pulled into the
// main bundle for everyone, including people who never turn chat on. This file
// is a handful of localStorage reads; the client and the engine stay lazy.

import { CHAT_RELAYS } from "../chat-relays";
import { LANGUAGES } from "../i18n";

const CONSENT_KEY = "zkas_chat_consent_v1";
const NICK_KEY = "zkas_chat_nickname_v1";
const RELAY_KEY = "zkas_chat_relay_v1";
const SEEN_KEY = "zkas_chat_lastseen_v1";
const MUTE_KEY = "zkas_chat_muted_v1";
const ADDR_KEY = "zkas_chat_zkasaddr_v1";
const BIO_KEY = "zkas_chat_bio_v1";
const ROOM_KEY = "zkas_chat_room_v1";
const PUBKEY_KEY = "zkas_chat_pubkey_v1";
const RECENT_KEY = "zkas_chat_recent_v1";
const DM_SEEN_KEY = "zkas_chat_dmseen_v1";

/** The room everyone lands in. A room is a hashtag, so this is also a public
 *  Nostr feed — other clients can see it without us doing anything. */
export const GLOBAL_ROOM = "zkas-global";

/** Rooms: one global room, plus one per language the app ships.
 *
 *  One global room in twenty-five languages is noise, not a community, so every
 *  language gets its own. Derived from `LANGUAGES` rather than a second
 *  hand-written list, so native names and flags stay in sync with the language
 *  picker and a language added there appears here for free.
 *
 *  There are deliberately no topic rooms. Splitting a community that does not
 *  exist yet across #mining / #trading / #dev produces several empty rooms
 *  instead of one with people in it; topics can come back when the traffic
 *  justifies them.
 *
 *  The app knows the user's locale, so it can join the right one without asking.
 */
export interface Room {
  id: string;
  /** Shown as the room's label. For a language room this is its native name. */
  label: string;
  flag?: string;
  group: "main" | "lang";
}

export const LANGUAGE_ROOMS: Room[] = LANGUAGES.map((l) => ({
  id: `zkas-${l.code.toLowerCase()}`,
  label: l.name,
  flag: l.flag,
  group: "lang" as const,
}));

export const ROOMS: Room[] = [{ id: GLOBAL_ROOM, label: "Global", flag: "🌍", group: "main" }, ...LANGUAGE_ROOMS];

/** The rooms this user follows: the global room, their language's room and the
 *  last few they opened. One definition, used by the chat's room strip AND by
 *  the wallet screen's unread badge — the badge used to count the CURRENT room
 *  only, so a message in your own language's room never showed up at all. */
export function followedRooms(locale: string): string[] {
  return [...new Set([GLOBAL_ROOM, roomForLocale(locale), ...recentRooms()].filter((r): r is string => !!r))].slice(0, 6);
}

/** The language room matching the active locale, if the app has one. */
export function roomForLocale(code: string): string | undefined {
  const want = `zkas-${code.toLowerCase()}`;
  if (LANGUAGE_ROOMS.some((r) => r.id === want)) return want;
  const base = code.split("-")[0].toLowerCase();
  return LANGUAGE_ROOMS.find((r) => r.id === `zkas-${base}` || r.id.startsWith(`zkas-${base}-`))?.id;
}

function read(k: string): string {
  try {
    return localStorage.getItem(k) ?? "";
  } catch {
    return "";
  }
}

function write(k: string, v: string): void {
  try {
    if (v) localStorage.setItem(k, v);
    else localStorage.removeItem(k);
  } catch {
    /* private mode / quota: the setting simply does not persist */
  }
}

export function chatEnabled(): boolean {
  return read(CONSENT_KEY) === "1";
}

/** Recording consent and enabling are the same act — nothing connects without it. */
export function setChatEnabled(on: boolean): void {
  write(CONSENT_KEY, on ? "1" : "");
}

export function nickname(): string {
  return read(NICK_KEY);
}

export function setNickname(name: string): void {
  write(NICK_KEY, name.trim().slice(0, 32));
}

export function relayUrl(): string {
  return read(RELAY_KEY) || CHAT_RELAYS[0];
}

export function setRelayUrl(url: string): void {
  write(RELAY_KEY, url.trim());
}

export function currentRoom(): string {
  return read(ROOM_KEY) || GLOBAL_ROOM;
}

export function setCurrentRoom(room: string): void {
  write(ROOM_KEY, room === GLOBAL_ROOM ? "" : room);
}

/** Per-room read cursor, so switching rooms does not mark everything read. */
export function lastSeen(room: string): number {
  return Number(read(`${SEEN_KEY}_${room}`) || 0);
}

export function markSeen(room: string, at: number): void {
  if (at > lastSeen(room)) write(`${SEEN_KEY}_${room}`, String(at));
}

/** Private messages already accounted for, by gift-wrap id.
 *
 *  By ID, not by timestamp. A NIP-17 wrap carries a randomised `created_at` up
 *  to two days in the PAST (that is the point — a shared timestamp would re-link
 *  the conversation the wrap exists to hide), so "newer than my cursor" cannot
 *  decide whether a wrap has been seen. Only the real timestamp inside is
 *  usable, and reading that needs the key and the 500 KB engine — far too much
 *  for a badge on the wallet screen. An id is visible without opening anything.
 *
 *  Bounded: the newest DM_SEEN_MAX ids are kept. Trimming can only make an old
 *  conversation look unread once, never hide a new one. */
const DM_SEEN_MAX = 400;

export function seenDmWraps(): string[] {
  const raw = read(DM_SEEN_KEY);
  if (!raw) return [];
  try {
    const v = JSON.parse(raw);
    return Array.isArray(v) ? v.filter((x) => typeof x === "string") : [];
  } catch {
    return [];
  }
}

/** Record wrap ids as seen. Newest-last, so the trim drops the oldest. */
export function markDmWrapsSeen(ids: string[]): void {
  if (!ids.length) return;
  const have = seenDmWraps();
  const set = new Set(have);
  const next = [...have, ...ids.filter((i) => !set.has(i))];
  write(DM_SEEN_KEY, JSON.stringify(next.slice(-DM_SEEN_MAX)));
}

/** Muted pubkeys. Mirrored to a NIP-51 list so a block set on one device
 *  applies on every device holding the same seed. */
export function mutedKeys(): string[] {
  const raw = read(MUTE_KEY);
  if (!raw) return [];
  try {
    const v = JSON.parse(raw);
    return Array.isArray(v) ? v.filter((x) => typeof x === "string") : [];
  } catch {
    return [];
  }
}

export function setMutedKeys(keys: string[]): void {
  write(MUTE_KEY, JSON.stringify([...new Set(keys)]));
}

/** The address this user has chosen to publish so others can tip them.
 *  Opt-in: publishing links a chat identity to a payment destination. */
export function myZkasAddress(): string {
  return read(ADDR_KEY);
}

export function setMyZkasAddress(addr: string): void {
  write(ADDR_KEY, addr.trim());
}

/** This user's own bio, kept locally so the editor can be reopened with what
 *  they last wrote. Published as the standard Nostr `about` field. */
export function myBio(): string {
  return read(BIO_KEY);
}

export function setMyBio(text: string): void {
  write(BIO_KEY, text.trim());
}

/** The rooms shown in the switcher strip, most recently opened first.
 *
 *  Persisted so the strip is the same on every open. It deliberately does NOT
 *  track "rooms with something new in them": a set that changed as messages
 *  arrived would re-order the strip under the user's thumb, and when the set
 *  drove the relay subscription it also fed back into itself — every arriving
 *  message changed the set, which resubscribed, which replayed the backlog,
 *  which counted it again. */
const RECENT_MAX = 4;

export function recentRooms(): string[] {
  const raw = read(RECENT_KEY);
  if (!raw) return [];
  try {
    const v = JSON.parse(raw);
    return Array.isArray(v) ? v.filter((x) => typeof x === "string" && x !== GLOBAL_ROOM).slice(0, RECENT_MAX) : [];
  } catch {
    return [];
  }
}

/** Note that a room was opened. The global room is always shown, so it is not
 *  stored and never costs one of the remembered slots. */
export function rememberRoom(id: string): void {
  if (id === GLOBAL_ROOM) return;
  const next = [id, ...recentRooms().filter((r) => r !== id)].slice(0, RECENT_MAX);
  write(RECENT_KEY, JSON.stringify(next));
}

/** Our own chat pubkey, cached after the engine first derives it.
 *
 *  Cached purely so the wallet screen can count unread messages without loading
 *  the 503 KB engine on every launch just to learn one public value. */
export function myChatPubkey(): string {
  return read(PUBKEY_KEY);
}

export function setMyChatPubkey(k: string): void {
  write(PUBKEY_KEY, k);
}

/** Turning chat off removes the identity-adjacent state too. Leaving a nickname,
 *  a mute list and read cursors behind after someone opts out is not "off". */
export function forgetChat(): void {
  try {
    [CONSENT_KEY, NICK_KEY, MUTE_KEY, ADDR_KEY, ROOM_KEY, PUBKEY_KEY, RECENT_KEY, DM_SEEN_KEY, BIO_KEY].forEach((k) =>
      localStorage.removeItem(k),
    );
    Object.keys(localStorage)
      .filter((k) => k.startsWith(SEEN_KEY))
      .forEach((k) => localStorage.removeItem(k));
  } catch {
    /* ignore */
  }
}
