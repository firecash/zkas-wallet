// ZKas chat — the opt-in sheet and the room.
//
// Two screens and one rule: nothing connects to a relay until the user has read
// what it costs them and said yes.
//
// Everything the chat can do is reached by tapping the thing it applies to — a
// message, a person, the room name — so the message row itself stays free of
// controls. See ChatSheets.tsx.

import { useCallback, useEffect, useMemo, useRef, useState, type MouseEvent as ReactMouseEvent, type PointerEvent as ReactPointerEvent } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import { getDeviceSeed } from "./lib/deviceseed";
import { useBackClose } from "./lib/backclose";
import { useToast } from "./toast";
import { MessageSheet, MutedSheet, ProfileSheet, RoomsSheet } from "./ChatSheets";
import {
  ChatClient,
  type ChatEvent,
  type ChatMessage,
  type ConnectionState,
  type Person,
  KIND_MUTE_LIST,
  KIND_PROFILE,
  KIND_REACTION,
  KIND_REPORT,
  KIND_NOTE,
  KIND_GIFT_WRAP,
  ensureChatEngine,
  fingerprintOf,
  hueOf,
  muteTags,
  noteTags,
  parseProfile,
  profileContent,
  reactionTags,
  reportTags,
  signAs,
} from "./chatclient";
import {
  currentRoom,
  lastSeen,
  markSeen,
  markDmWrapsSeen,
  seenDmWraps,
  mutedKeys,
  myZkasAddress,
  nickname,
  setChatEnabled,
  setCurrentRoom,
  setMutedKeys,
  setMyChatPubkey,
  setNickname,
  GLOBAL_ROOM,
  ROOMS,
  roomForLocale,
  recentRooms,
  rememberRoom,
} from "./lib/chatprefs";

const FIRSTNAME_KEY = "zkas_chat_firstnames_v1";
/** Consecutive messages from one author inside this window share a header. */
const GROUP_WINDOW_SECS = 5 * 60;

/** Connection state → its catalogue key. Written out rather than built with
 *  `"chat.state." + state`, so the i18n audit can see that each key is used and
 *  that none is missing — a concatenated key made it report one phantom missing
 *  key and four phantom unused ones, on every run. */
const STATE_LABEL: Record<ConnectionState, string> = {
  offline: "chat.state.offline",
  connecting: "chat.state.connecting",
  live: "chat.state.live",
  error: "chat.state.error",
  blocked: "chat.state.blocked",
};

function loadFirstNames(): Record<string, string> {
  try {
    return JSON.parse(localStorage.getItem(FIRSTNAME_KEY) || "{}");
  } catch {
    return {};
  }
}

function Avatar({ person, big }: { person: Person; big?: boolean }) {
  // Generated, never fetched. A remote avatar URL would make every viewer's
  // client call a stranger's server on render — an IP leak and a free tracker.
  return (
    <span
      className={big ? "chat-avatar big" : "chat-avatar"}
      aria-hidden="true"
      style={{ background: `hsl(${person.hue} 58% 42%)` }}
    >
      {person.pubkey.slice(0, 2)}
    </span>
  );
}

/** Render text with links visible but inert.
 *
 *  Links are shown and copyable; they are NOT auto-opened and NOT previewed.
 *  Fetching a preview would make every reader's device call a host the author
 *  chose, leaking the reader's IP and handing a stranger a tracker. */
function Body({ text }: { text: string }) {
  const parts = text.split(/(https?:\/\/[^\s]+)/g);
  return (
    <p className="chat-text">
      {parts.map((p, i) =>
        /^https?:\/\//.test(p) ? (
          <a key={i} href={p} target="_blank" rel="noopener noreferrer nofollow ugc" className="chat-link">
            {p}
          </a>
        ) : (
          <span key={i}>{p}</span>
        ),
      )}
    </p>
  );
}

/**
 * The consent sheet. Short on purpose: three facts decide whether someone wants
 * this, and burying them in policy text is the same as not showing them.
 */
export function ChatConsent({ onEnable, onClose }: { onEnable: () => void; onClose: () => void }) {
  const { t } = useTranslation();
  useBackClose(true, onClose);
  return createPortal(
    <div className="modalwrap" onClick={onClose}>
      <div className="card modalcard chat-consent" onClick={(e) => e.stopPropagation()}>
        <h2 style={{ marginTop: 0 }}>{t("chat.consentTitle")}</h2>
        <ul className="chat-consent-list">
          <li>{t("chat.consentPublic")}</li>
          <li>{t("chat.consentIp")}</li>
          <li>{t("chat.consentSeparate")}</li>
        </ul>
        <button
          className="btn"
          onClick={() => {
            setChatEnabled(true);
            onEnable();
          }}
        >
          {t("chat.consentEnable")}
        </button>
        <button className="btn ghost" style={{ marginTop: 8 }} onClick={onClose}>
          {t("chat.consentLater")}
        </button>
        <p className="muted small" style={{ marginBottom: 0 }}>{t("chat.consentOff")}</p>
      </div>
    </div>,
    document.body,
  );
}

export function ChatScreen({ onClose, onTip }: { onClose: () => void; onTip?: (addr: string) => void }) {
  const { t, i18n } = useTranslation();
  const toast = useToast();
  const [room, setRoom] = useState(currentRoom());
  const [state, setState] = useState<ConnectionState>("offline");
  const [notes, setNotes] = useState<Map<string, ChatEvent>>(new Map());
  const [profiles, setProfiles] = useState<Map<string, { name?: string; zkas?: string }>>(new Map());
  const [reactions, setReactions] = useState<Map<string, Map<string, Set<string>>>>(new Map());
  const [muted, setMuted] = useState<string[]>(() => mutedKeys());
  const [firstNames, setFirstNames] = useState<Record<string, string>>(loadFirstNames);
  const [draft, setDraft] = useState("");
  const [replyTo, setReplyTo] = useState<ChatMessage | null>(null);
  const [sending, setSending] = useState(false);
  const [failed, setFailed] = useState<Set<string>>(new Set());
  const [error, setError] = useState<string | null>(null);
  const [askName, setAskName] = useState(false);
  const [nameDraft, setNameDraft] = useState(nickname());
  const [addrDraft, setAddrDraft] = useState(myZkasAddress());
  const [me, setMe] = useState("");
  const [sheet, setSheet] = useState<null | { kind: "msg" | "profile" | "rooms" | "muted"; id?: string; pubkey?: string }>(null);
  const [atBottom, setAtBottom] = useState(true);
  // One screen, three views: the room, the list of private conversations, and
  // one conversation. Keeping them here means one socket and one layout.
  const [view, setView] = useState<{ k: "room" } | { k: "dms" } | { k: "dm"; peer: string }>({ k: "room" });
  const [dms, setDms] = useState<Map<string, Array<{ id: string; sender: string; content: string; created_at: number }>>>(new Map());
  /** Every gift wrap addressed to us that this session has seen arrive, by id.
   *  Unread is decided on these ids — see `seenDmWraps`, and note that a wrap's
   *  own timestamp is randomised and cannot be compared against a cursor. */
  const [wrapIds, setWrapIds] = useState<string[]>([]);
  const [dmSeen, setDmSeen] = useState<Set<string>>(() => new Set(seenDmWraps()));
  /** The read cursor for the room on screen, used to place the "New messages"
   *  rule. Per ROOM, not per screen: it was captured once when chat opened, so
   *  after switching rooms the rule was drawn from the previous room's cursor
   *  and marked week-old messages as new. */
  const [sinceOpen, setSinceOpen] = useState(() => lastSeen(currentRoom()));
  /** Unread, per room, for the rooms shown in the switcher. Filled by the single
   *  `peek` subscription; the open room is excluded because its own messages are
   *  already on screen. */
  const [peek, setPeek] = useState<Record<string, number>>({});
  /** Bumped when a room is opened, so the chip strip recomputes from the stored
   *  recent list exactly then and at no other time. */
  const [visited, setVisited] = useState(0);
  /** Ids already counted into `peek`. A relay replays matching history on every
   *  REQ, so without this the same message could be counted more than once. */
  const counted = useRef<Set<string>>(new Set());
  // `ingest` is created once, so it cannot close over `room`.
  const roomRef = useRef(room);
  roomRef.current = room;
  const meRef = useRef(me);
  meRef.current = me;

  const canPost = useMemo(() => !!getDeviceSeed(), []);
  // Swipe-right-to-reply. The action sheet holds everything, but replying is the
  // one action common enough that making it cost two taps was a regression from
  // the visible button it replaced — so it also gets a gesture.
  const swipe = useRef<{ id: string; x: number; y: number; at: number; held: boolean } | null>(null);
  const holdTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  /** Last message tapped, and when — for recognising a double tap. */
  const lastTap = useRef<{ id: string; at: number } | null>(null);
  const client = useRef<ChatClient | null>(null);
  const bottom = useRef<HTMLDivElement | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);
  const composer = useRef<HTMLTextAreaElement | null>(null);

  // The on-screen keyboard does not shrink the layout viewport, so a fixed
  // full-height panel keeps its composer underneath it. visualViewport reports
  // what is actually visible; dvh stays as the fallback.
  useEffect(() => {
    const vv = window.visualViewport;
    if (!vv) return;
    const apply = () => document.documentElement.style.setProperty("--chat-vh", `${vv.height}px`);
    apply();
    vv.addEventListener("resize", apply);
    vv.addEventListener("scroll", apply);
    return () => {
      vv.removeEventListener("resize", apply);
      vv.removeEventListener("scroll", apply);
      document.documentElement.style.removeProperty("--chat-vh");
    };
  }, []);

  useEffect(() => {
    if (!canPost) return;
    let alive = true;
    ensureChatEngine()
      .then((engine) => engine.chatIdentity(getDeviceSeed(), 0))
      .then((id) => { if (alive) { setMe(id.pubkey_hex); setMyChatPubkey(id.pubkey_hex); } })
      .catch(() => { if (alive) setError("engine"); });
    return () => {
      alive = false;
    };
  }, [canPost]);

  // One ingest path for every kind. Notes, profiles, reactions and the mute list
  // are all just events; keeping them on one path is what stops the four from
  // drifting apart.
  const ingest = useCallback((ev: ChatEvent) => {
    if (ev.kind === KIND_PROFILE) {
      const p = parseProfile(ev.content);
      setProfiles((prev) => new Map(prev).set(ev.pubkey, p));
      if (p.name) {
        setFirstNames((prev) => {
          if (prev[ev.pubkey]) return prev;
          const next = { ...prev, [ev.pubkey]: p.name as string };
          try {
            localStorage.setItem(FIRSTNAME_KEY, JSON.stringify(next));
          } catch {
            /* ignore */
          }
          return next;
        });
      }
      return;
    }
    if (ev.kind === KIND_REACTION) {
      const target = ev.tags.find((tg) => tg[0] === "e")?.[1];
      if (!target) return;
      setReactions((prev) => {
        const next = new Map(prev);
        const forTarget = new Map(next.get(target) ?? []);
        const who = new Set(forTarget.get(ev.content) ?? []);
        who.add(ev.pubkey);
        forTarget.set(ev.content, who);
        next.set(target, forTarget);
        return next;
      });
      return;
    }
    if (ev.kind === KIND_MUTE_LIST) {
      // Our own list from another device merges by UNION: dropping a local mute
      // because an older list arrived would un-block someone silently.
      const remote = ev.tags.filter((tg) => tg[0] === "p").map((tg) => tg[1]);
      setMuted((prev) => {
        const merged = [...new Set([...prev, ...remote])];
        setMutedKeys(merged);
        return merged;
      });
      return;
    }
    if (ev.kind === KIND_GIFT_WRAP) {
      // Recorded before any attempt to open it: the subscription filters on our
      // pubkey, so every wrap delivered here is addressed to us, and the count
      // must not depend on the engine having loaded.
      setWrapIds((prev) => (prev.includes(ev.id) ? prev : [...prev, ev.id]));
      // Opening it needs our key, so this is async and best-effort: a wrap we
      // cannot open is simply not for us, which is normal and not an error.
      void (async () => {
        try {
          const engine = await ensureChatEngine();
          const id = await engine.chatIdentity(getDeviceSeed(), 0);
          const open = await engine.unwrapDm(id.privkey_hex, JSON.stringify(ev));
          // A wrap we sent carries OUR pubkey as sender; the peer is then the
          // recipient on the rumor. NIP-17 sends one wrap to each side.
          const peer = open.sender === id.pubkey_hex
            ? (ev.tags.find((tg) => tg[0] === "p")?.[1] ?? open.sender)
            : open.sender;
          setDms((prev) => {
            const next = new Map(prev);
            const thread = [...(next.get(peer) ?? [])];
            if (!thread.some((m) => m.id === open.id)) {
              thread.push({ id: open.id, sender: open.sender, content: open.content, created_at: open.created_at });
              thread.sort((a, b) => a.created_at - b.created_at);
            }
            next.set(peer, thread);
            return next;
          });
        } catch {
          /* not addressed to us, or malformed */
        }
      })();
      return;
    }
    if (ev.kind === KIND_NOTE) {
      // A note from another room arrived on the `peek` subscription: it belongs
      // to a chip's counter, not to the open conversation.
      const where = ev.tags.find((tg) => tg[0] === "t")?.[1];
      if (where && where !== roomRef.current) {
        if (ev.pubkey !== meRef.current && ev.created_at > lastSeen(where) && !counted.current.has(ev.id)) {
          counted.current.add(ev.id);
          setPeek((prev) => ({ ...prev, [where]: (prev[where] ?? 0) + 1 }));
        }
        return;
      }
      setNotes((prev) => (prev.has(ev.id) ? prev : new Map(prev).set(ev.id, ev)));
    }
  }, []);

  // ONE socket for as long as the screen is open. This used to depend on `room`,
  // so every switch tore the WebSocket down and opened a new one — a handshake
  // and a fresh backfill before the first message appeared. `setRoom` replaces
  // the two room subscriptions on the live socket instead.
  useEffect(() => {
    const c = new ChatClient(roomRef.current, ingest, setState);
    client.current = c;
    c.connect();
    return () => c.close();
  }, [ingest]);

  /** The newest message seen in the open room, so leaving it can mark it read.
   *  Fed by an effect below, once `messages` exists. */
  const newestInRoom = useRef(0);

  /** Leaving a room — switching away, or closing chat — marks it read.
   *
   *  Marking only happened while scrolled to the bottom, so a room read from
   *  anywhere else kept its unread count and the wallet screen went on showing
   *  "1 new" for a message already read. Closing the room is as clear a
   *  statement that it was read as reaching the bottom of it. */
  useEffect(() => {
    const leaving = room;
    newestInRoom.current = 0;
    return () => {
      if (newestInRoom.current) markSeen(leaving, newestInRoom.current);
    };
  }, [room]);

  useEffect(() => {
    client.current?.setRoom(room);
    setSinceOpen(lastSeen(room));
    // Whatever was counted for the room we just opened is now on screen.
    setPeek((prev) => (prev[room] ? { ...prev, [room]: 0 } : prev));
  }, [room]);

  /** The rooms the switcher shows without being opened.
   *
   *  Switching rooms was a tap on the title to open a sheet, then a tap on a
   *  row — and nothing on screen said there was more than one room at all. This
   *  is the global room, the room for the app's language, whichever room is
   *  open, and any room with something new in it: the handful anyone actually
   *  moves between, visible and one tap away. Everything else is still in the
   *  sheet behind the last chip. */
  const chipRooms = useMemo(() => {
    const ids = [GLOBAL_ROOM, roomForLocale(i18n.language), ...recentRooms(), room];
    return [...new Set(ids.filter((r): r is string => !!r))].slice(0, 6);
    // `visited` changes only when a room is opened, which is what keeps this set
    // stable: see the note on `recentRooms`.
  }, [i18n.language, room, visited]);

  const chipsKey = chipRooms.join(",");

  // One subscription for every chip but the open one (whose messages are already
  // being delivered). Keyed on the room NAMES, not the array identity, so a
  // re-render cannot resubscribe and replay the backlog.
  useEffect(() => {
    if (state !== "live") return;
    const others = chipsKey.split(",").filter((r) => r && r !== room);
    if (!others.length) return;
    const week = Math.floor(Date.now() / 1000) - 7 * 24 * 3600;
    const since = Math.min(...others.map((r) => lastSeen(r) || week));
    client.current?.subscribePeek(others, since);
  }, [chipsKey, room, state]);

  const roomLabel = useCallback(
    (id: string) => {
      const r = ROOMS.find((x) => x.id === id);
      return r ? `${r.flag ? `${r.flag} ` : ""}${r.label}` : `#${id}`;
    },
    [],
  );

  /** Switch rooms. One function for the chips and the sheet, so the two cannot
   *  differ in what they clear. */
  const pickRoom = useCallback((r: string) => {
    setAtBottom(true);
    setView({ k: "room" });
    setSheet(null);
    if (r === roomRef.current) return;
    setNotes(new Map());
    setRoom(r);
    setCurrentRoom(r);
    rememberRoom(r);
    setVisited((n) => n + 1);
  }, []);

  /** How a message is operated.
   *
   *  A single tap used to open the action sheet, and the sheet opened under the
   *  finger — so tapping a message twice landed the second tap on a row, and
   *  "Mute this person" is one of them. People muted strangers without ever
   *  seeing the menu. A single tap now does nothing at all, and the two
   *  gestures every messenger already trains people in do the work:
   *
   *    hold        → the action sheet (right-click on a desktop)
   *    double tap  → 👍, the one reaction common enough to deserve a gesture
   *    swipe right → reply
   *
   *  Hold is cancelled by movement, so scrolling the list never opens anything.
   */
  const HOLD_MS = 450;
  const DOUBLE_TAP_MS = 320;
  /** Movement past this is a scroll or a swipe, not a press. */
  const SLOP_PX = 12;

  const cancelHold = useCallback(() => {
    if (holdTimer.current) clearTimeout(holdTimer.current);
    holdTimer.current = null;
  }, []);

  const gestures = useCallback(
    (m: ChatMessage) => ({
      onPointerDown: (e: ReactPointerEvent) => {
        swipe.current = { id: m.id, x: e.clientX, y: e.clientY, at: Date.now(), held: false };
        cancelHold();
        holdTimer.current = setTimeout(() => {
          const st = swipe.current;
          if (!st || st.id !== m.id) return;
          st.held = true;
          // The press itself is the confirmation that this is deliberate, so a
          // short buzz acknowledges it where the hardware can.
          try { navigator.vibrate?.(12); } catch { /* not available */ }
          setSheet({ kind: "msg", id: m.id, pubkey: m.pubkey });
        }, HOLD_MS);
      },
      onPointerMove: (e: ReactPointerEvent) => {
        const st = swipe.current;
        if (!st) return;
        if (Math.abs(e.clientX - st.x) > SLOP_PX || Math.abs(e.clientY - st.y) > SLOP_PX) cancelHold();
      },
      onPointerCancel: () => {
        cancelHold();
        swipe.current = null;
      },
      onPointerUp: (e: ReactPointerEvent) => {
        cancelHold();
        const st = swipe.current;
        swipe.current = null;
        if (!st || st.id !== m.id || st.held) return;
        const dx = e.clientX - st.x;
        const dy = e.clientY - st.y;
        // Rightward and far enough to be deliberate rather than a sloppy tap.
        if (dx > 60 && Math.abs(dy) < 60) {
          setReplyTo(m);
          return;
        }
        if (Math.abs(dx) > SLOP_PX || Math.abs(dy) > SLOP_PX) return; // a scroll
        const prevTap = lastTap.current;
        const now = Date.now();
        if (prevTap && prevTap.id === m.id && now - prevTap.at < DOUBLE_TAP_MS) {
          lastTap.current = null;
          void publishSigned(KIND_REACTION, reactionTags(m, room), "+").catch(() => undefined);
          try { navigator.vibrate?.(8); } catch { /* not available */ }
          return;
        }
        lastTap.current = { id: m.id, at: now };
      },
      // A desktop has no long press; the menu key and right-click are its equivalent.
      onContextMenu: (e: ReactMouseEvent) => {
        e.preventDefault();
        cancelHold();
        setSheet({ kind: "msg", id: m.id, pubkey: m.pubkey });
      },
    }),
    [cancelHold, room],
  );

  // A pending hold must not fire after the list has gone.
  useEffect(() => cancelHold, [cancelHold]);

  /** Open a private conversation. Used by the message sheet, the profile sheet
   *  and the conversation list, so all three land in the same state — the list
   *  reset `atBottom`, the profile did not, and a thread opened from a profile
   *  could therefore open scrolled away from its newest message. */
  const openDm = useCallback((peer: string) => {
    setAtBottom(true);
    setSheet(null);
    setView({ k: "dm", peer });
  }, []);

  /** Unread private messages, for the DMs chip.
   *
   *  Counted by wrap id against what this device has already seen. It used to
   *  compare each message against `sinceOpen` — the read cursor of the chat
   *  ROOM — so private messages were marked read by looking at a public room,
   *  and vice versa. */
  const dmUnread = useMemo(() => wrapIds.filter((id) => !dmSeen.has(id)).length, [wrapIds, dmSeen]);

  // Opening the conversations, or any one of them, is reading them.
  useEffect(() => {
    if (view.k !== "dms" && view.k !== "dm") return;
    if (!wrapIds.length) return;
    if (wrapIds.every((id) => dmSeen.has(id))) return;
    markDmWrapsSeen(wrapIds);
    // A NEW Set, not a mutation: mutating one in state re-renders nothing, so
    // the chip would have kept its count until the next wrap happened to arrive.
    setDmSeen((prev) => new Set([...prev, ...wrapIds]));
  }, [view, wrapIds, dmSeen]);

  useEffect(() => {
    if (me && client.current?.live) {
      client.current.requestMuteList(me);
      client.current.subscribeDms(me);
    }
  }, [me, state]);

  /** Send a private message: one wrap to them, one to ourselves, because a wrap
   *  is encrypted to a single recipient and we would otherwise be unable to read
   *  our own sent messages. */
  async function sendDm(peer: string, body: string) {
    const engine = await ensureChatEngine();
    const id = await engine.chatIdentity(getDeviceSeed(), 0);
    const theirs = await engine.wrapDm(id.privkey_hex, peer, body);
    const mine = await engine.wrapDm(id.privkey_hex, id.pubkey_hex, body);
    client.current?.publish(theirs);
    client.current?.publish(mine);
    setDms((prev) => {
      const next = new Map(prev);
      const thread = [...(next.get(peer) ?? [])];
      thread.push({ id: `local-${Date.now()}`, sender: id.pubkey_hex, content: body, created_at: Math.floor(Date.now() / 1000) });
      next.set(peer, thread);
      return next;
    });
  }

  const person = useCallback(
    (pubkey: string): Person => {
      const p = profiles.get(pubkey);
      return {
        pubkey,
        name: p?.name,
        zkas: p?.zkas,
        firstName: firstNames[pubkey],
        fingerprint: fingerprintOf(pubkey),
        hue: hueOf(pubkey),
        muted: muted.includes(pubkey),
      };
    },
    [profiles, firstNames, muted],
  );

  const messages: ChatMessage[] = useMemo(() => {
    const mutedSet = new Set(muted);
    return [...notes.values()]
      .filter((ev) => !mutedSet.has(ev.pubkey))
      .map((ev) => ({
        ...ev,
        person: person(ev.pubkey),
        replyTo: ev.tags.find((tg) => tg[0] === "e")?.[1],
        mine: !!me && ev.pubkey === me,
        failed: failed.has(ev.id),
      }))
      // `created_at` is author-supplied, so ties break on id to keep the order
      // stable rather than jittering between renders.
      .sort((a, b) => a.created_at - b.created_at || a.id.localeCompare(b.id));
  }, [notes, muted, me, person, failed]);

  useEffect(() => {
    // Muted authors are filtered out of `messages`, so asking only about those
    // left meant a muted person's name was never fetched — and the muted list
    // could then only ever show "anon".
    const want = [...new Set([...messages.map((m) => m.pubkey), ...muted])];
    const unknown = want.filter((p) => !profiles.has(p));
    if (unknown.length) client.current?.requestProfiles(unknown);
  }, [messages, profiles, muted]);

  useEffect(() => {
    // Set scrollTop so the movement stays INSIDE the list. `scrollIntoView`
    // walks up every scrollable ancestor, which on a phone drags the page and
    // fights the keyboard.
    if (atBottom && listRef.current) listRef.current.scrollTop = listRef.current.scrollHeight;
    const newest = messages[messages.length - 1];
    if (newest && atBottom) markSeen(room, newest.created_at);
  }, [messages, atBottom, room, view, dms]);

  useEffect(() => {
    const last = messages[messages.length - 1];
    if (last) newestInRoom.current = Math.max(newestInRoom.current, last.created_at);
  }, [messages]);

  const unreadCount = messages.filter((m) => m.created_at > sinceOpen && !m.mine).length;

  async function publishSigned(kind: number, tags: string[][], content: string): Promise<void> {
    const signed = await signAs(getDeviceSeed(), 0, kind, tags, content);
    client.current?.publish(signed);
  }

  async function send(retryBody?: string) {
    const body = (retryBody ?? draft).trim();
    if (!body || sending) return;
    // The first message is the natural moment to ask for a name — not a signup
    // screen before anyone has seen the room.
    if (!nickname() && !askName && !retryBody) {
      setAskName(true);
      return;
    }
    setSending(true);
    setError(null);
    let localId = "";
    try {
      const signed = await signAs(
        getDeviceSeed(),
        0,
        KIND_NOTE,
        noteTags(room, replyTo ? { id: replyTo.id, pubkey: replyTo.pubkey } : undefined),
        body,
      );
      const ev = JSON.parse(signed) as ChatEvent;
      localId = ev.id;
      ingest(ev); // optimistic; the relay echo dedupes by id
      client.current?.publish(signed);
      setFailed((prev) => { const n = new Set(prev); n.delete(localId); return n; });
      setDraft("");
      setReplyTo(null);
    } catch (e) {
      if (localId) setFailed((prev) => new Set(prev).add(localId));
      setError(String(e).includes("chat-engine-missing") ? "engine" : "send");
    } finally {
      setSending(false);
    }
  }

  /** Send to whichever view is open, then put the cursor back.
   *
   *  Without restoring focus the keyboard closes after every message, which
   *  turns a conversation into a sequence of taps to reopen it. */
  async function submit() {
    const body = draft.trim();
    if (!body || sending) return;
    if (view.k === "dm") {
      setDraft("");
      if (composer.current) composer.current.style.height = "auto";
      await sendDm(view.peer, body).catch(() => setError("send"));
    } else {
      await send();
      if (composer.current) composer.current.style.height = "auto";
    }
    composer.current?.focus();
  }

  async function saveName() {
    const name = nameDraft.trim().slice(0, 32);
    const addr = addrDraft.trim();
    setNickname(name);
    setAskName(false);
    try {
      await publishSigned(KIND_PROFILE, [], profileContent(name, addr || undefined));
    } catch {
      /* stored locally either way; it publishes with the next send */
    }
    if (draft.trim()) void send(draft);
  }

  async function toggleMute(pubkey: string) {
    const wasMuted = muted.includes(pubkey);
    const next = wasMuted ? muted.filter((k) => k !== pubkey) : [...muted, pubkey];
    setMuted(next);
    setMutedKeys(next);
    setSheet(null);
    toast.show("good", wasMuted ? t("chat.toast.unmuted") : t("chat.toast.muted"));
    try {
      await publishSigned(KIND_MUTE_LIST, muteTags(next), "");
    } catch {
      /* the local mute already applies; the list syncs on the next connection */
    }
  }

  const openMessage = sheet?.kind === "msg" ? messages.find((m) => m.id === sheet.id) : undefined;
  const openPerson = sheet?.kind === "profile" && sheet.pubkey ? person(sheet.pubkey) : undefined;

  const dot = state === "live" ? "chat-dot live" : state === "connecting" ? "chat-dot warm" : "chat-dot off";
  let lastDay = "";
  let prev: ChatMessage | null = null;

  return createPortal(
    <div className="chat-screen" role="dialog" aria-modal="true" aria-label={t("chat.roomAria")}>
      <header className="chat-head">
        {/* Back steps WITHIN chat first — thread → list → room → wallet — so a
            private conversation is not one tap from vanishing. */}
        <button
          className="btn ghost chat-back"
          onClick={() => {
            if (view.k === "dm") setView({ k: "dms" });
            else if (view.k === "dms") setView({ k: "room" });
            else onClose();
          }}
        >
          {t("chat.back")}
        </button>
        <button
          className="chat-title"
          onClick={() => view.k === "room" && setSheet({ kind: "rooms" })}
        >
          <span className="chat-room">
            {/* The room's own name, as the switcher shows it — not the raw tag
                `#zkas-fr`, which is an implementation detail of how rooms are
                addressed on the relay and told a French speaker nothing. */}
            {view.k === "room" ? roomLabel(room) : view.k === "dms" ? t("chat.dm.title") : (person(view.peer).name || t("chat.anon"))}
          </span>
          <span className="chat-state">
            <i className={dot} aria-hidden="true" />
            {view.k === "dm" ? t("chat.dm.headerNote") : t(STATE_LABEL[state])}
          </span>
        </button>
        {/* On the header line, opposite Wallet — not at the end of the room
            strip, where it sat past the right edge and had to be scrolled to.
            The strip is for the rooms you move between; the full list is a
            different kind of thing and belongs with the other navigation. */}
        <button className="chat-chip more" onClick={() => setSheet({ kind: "rooms" })}>
          {t("chat.rooms.all")}
        </button>
      </header>

      {/* The switcher, always on screen. Rooms AND the open conversation at once,
          so moving between them is one tap on something already visible rather
          than a tap to open a sheet and a tap to pick a row — and so a newcomer
          can see that more than one room exists at all. The last chip opens the
          full list; the first is private messages, which belong in the same row
          because they are another place to be, not a different kind of thing. */}
      <nav className="chat-rooms" aria-label={t("chat.rooms.title")}>
        <button
          className={view.k === "room" ? "chat-chip" : "chat-chip on"}
          aria-current={view.k !== "room"}
          onClick={() => { setAtBottom(true); setView({ k: "dms" }); }}
        >
          {t("chat.dm.title")}
          {dmUnread > 0 && <span className="chat-chip-n">{dmUnread}</span>}
        </button>
        {chipRooms.map((r) => (
          <button
            key={r}
            className={view.k === "room" && r === room ? "chat-chip on" : "chat-chip"}
            aria-current={view.k === "room" && r === room}
            onClick={() => pickRoom(r)}
          >
            {roomLabel(r)}
            {r !== room && peek[r] > 0 && <span className="chat-chip-n">{peek[r]}</span>}
          </button>
        ))}
      </nav>

      {error === "engine" && <div className="msg warn small">{t("chat.errEngine")}</div>}

      {view.k === "dms" && (
        <div className="chat-list" ref={listRef}>
          {dms.size === 0 && <p className="muted small chat-empty">{t("chat.dm.none")}</p>}
          {[...dms.entries()]
            .sort((a, b) => (b[1][b[1].length - 1]?.created_at ?? 0) - (a[1][a[1].length - 1]?.created_at ?? 0))
            .map(([peer, thread]) => {
              const who = person(peer);
              const last = thread[thread.length - 1];
              return (
                <article key={peer} className="chat-msg" onClick={() => openDm(peer)}>
                  <Avatar person={who} />
                  <div className="chat-body">
                    <div className="chat-meta">
                      <b>{who.name || t("chat.anon")}</b>
                      <span className="chat-fp">·{who.fingerprint}</span>
                      {last && <time>{new Date(last.created_at * 1000).toLocaleDateString()}</time>}
                    </div>
                    <p className="chat-text">{last?.content.slice(0, 80) ?? ""}</p>
                  </div>
                </article>
              );
            })}
        </div>
      )}

      {view.k === "dm" && (
        <div
          className="chat-list"
          ref={listRef}
          onScroll={() => {
            const el = listRef.current;
            if (!el) return;
            setAtBottom(el.scrollHeight - el.scrollTop - el.clientHeight < 80);
          }}
        >
          <p className="muted small chat-empty" style={{ margin: "0 0 8px" }}>{t("chat.dm.note")}</p>
          {(dms.get(view.peer) ?? []).map((m) => {
            const who = person(m.sender);
            return (
              <article key={m.id} className={m.sender === me ? "chat-msg mine" : "chat-msg"}>
                <Avatar person={who} />
                <div className="chat-body">
                  <div className="chat-meta">
                    <b>{m.sender === me ? t("chat.you") : who.name || t("chat.anon")}</b>
                    <time>{new Date(m.created_at * 1000).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</time>
                  </div>
                  <Body text={m.content} />
                </div>
              </article>
            );
          })}
          <div ref={bottom} />
        </div>
      )}

      {view.k === "room" && <div
        className="chat-list"
        ref={listRef}
        onScroll={() => {
          const el = listRef.current;
          if (!el) return;
          setAtBottom(el.scrollHeight - el.scrollTop - el.clientHeight < 80);
        }}
      >
        {/* Said once, at the top of the room: what this place is, and the two
            things a newcomer needs to know. Not a modal — a modal before the
            first message is one more thing to dismiss. */}
        <p className="muted small chat-intro">{t("chat.intro")}</p>
        {messages.length === 0 && (
          <p className="muted small chat-empty">
            {state === "live" ? t("chat.empty") : state === "blocked" ? t("chat.torBlocked") : t("chat.connecting")}
          </p>
        )}
        {messages.map((m) => {
          const day = new Date(m.created_at * 1000).toDateString();
          const newDay = day !== lastDay;
          if (newDay) lastDay = day;
          // Consecutive messages from one author share a header — the single
          // biggest density win on a phone.
          const grouped = !newDay && prev?.pubkey === m.pubkey && m.created_at - prev.created_at < GROUP_WINDOW_SECS;
          const firstUnread = !m.mine && m.created_at > sinceOpen && (!prev || prev.created_at <= sinceOpen);
          const parent = m.replyTo ? notes.get(m.replyTo) : undefined;
          prev = m;
          const reacts = reactions.get(m.id);
          return (
            <div key={m.id}>
              {newDay && <div className="chat-day"><span>{day}</span></div>}
              {firstUnread && <div className="chat-unread-rule"><span>{t("chat.newMessages")}</span></div>}
              <article
                className={"chat-msg" + (m.mine ? " mine" : "") + (grouped ? " grouped" : "") + (m.failed ? " failed" : "")}
                {...gestures(m)}
              >
                {grouped ? <span className="chat-avatar spacer" aria-hidden="true" /> : <Avatar person={m.person} />}
                <div className="chat-body">
                  {!grouped && (
                    <div className="chat-meta">
                      <b>{m.person.name || t("chat.anon")}</b>
                      <span className="chat-fp">·{m.person.fingerprint}</span>
                      <time>{new Date(m.created_at * 1000).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</time>
                    </div>
                  )}
                  {parent && (
                    <div className="chat-quote">
                      <b>{person(parent.pubkey).name || t("chat.anon")}</b> {parent.content.slice(0, 90)}
                    </div>
                  )}
                  <Body text={m.content} />
                  {m.failed && <span className="chat-failed">{t("chat.failedTap")}</span>}
                  {reacts && reacts.size > 0 && (
                    <div className="chat-reacts">
                      {[...reacts.entries()].map(([emoji, who]) => (
                        <span key={emoji} className="chat-react">
                          {emoji === "+" ? "👍" : emoji} {who.size}
                        </span>
                      ))}
                    </div>
                  )}
                </div>
              </article>
            </div>
          );
        })}
        <div ref={bottom} />
      </div>}

      {view.k === "room" && !atBottom && unreadCount > 0 && (
        <button className="chat-jump" onClick={() => { setAtBottom(true); if (listRef.current) listRef.current.scrollTop = listRef.current.scrollHeight; }}>
          ↓ {unreadCount} {t("chat.new")}
        </button>
      )}

      {replyTo && (
        <div className="chat-replying">
          <span>{t("chat.replyingTo", { name: replyTo.person.name || t("chat.anon") })}</span>
          <button className="btn ghost small" onClick={() => setReplyTo(null)}>{t("chat.cancel")}</button>
        </div>
      )}

      {error === "send" && <div className="msg warn small">{t("chat.errSend")}</div>}

      {/* Tor is on and the relay is not an onion. A WebView socket cannot use
          the engine's SOCKS proxy, so connecting would publish the real IP of
          someone who switched Tor on — the one thing the consent screen frames
          as a deliberate choice. Say what happened and what would fix it. */}
      {state === "blocked" && <div className="msg warn small">{t("chat.torBlocked")}</div>}

      {state === "blocked" ? (
        <div className="chat-compose readonly">
          <span className="muted small">{t("chat.torBlockedShort")}</span>
        </div>
      ) : canPost ? (
        <div className="chat-compose">
          <textarea
            ref={composer}
            value={draft}
            rows={1}
            onChange={(e) => {
              setDraft(e.target.value);
              // Grow to fit, up to the CSS max-height.
              e.target.style.height = "auto";
              e.target.style.height = `${Math.min(e.target.scrollHeight, 120)}px`;
            }}
            onKeyDown={(e) => {
              // Enter sends, Shift+Enter is a newline — the convention everywhere.
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                void submit();
              }
            }}
            /* Names the room actually open. It was pinned to "the global room",
               so every language room invited you to post to a different one. */
            placeholder={view.k === "dm" ? t("chat.dm.placeholder") : t("chat.placeholder", { room: roomLabel(room) })}
            maxLength={2000}
            aria-label={view.k === "dm" ? t("chat.dm.placeholder") : t("chat.placeholder", { room: roomLabel(room) })}
          />
          <button className="btn" onClick={() => void submit()} disabled={sending || !draft.trim()}>
            {sending ? t("chat.sending") : t("chat.send")}
          </button>
        </div>
      ) : (
        <div className="chat-compose readonly">
          <span className="muted small">{t("chat.readOnly")}</span>
        </div>
      )}

      {openMessage && (
        <MessageSheet
          message={openMessage}
          onClose={() => setSheet(null)}
          onReply={() => { setReplyTo(openMessage); setSheet(null); }}
          onReact={(emoji) => {
            setSheet(null);
            void publishSigned(KIND_REACTION, reactionTags(openMessage, room), emoji).catch(() => undefined);
          }}
          onDm={() => openDm(openMessage.pubkey)}
          onTip={() => { setSheet(null); onClose(); if (openMessage.person.zkas) onTip?.(openMessage.person.zkas); }}
          onProfile={() => setSheet({ kind: "profile", pubkey: openMessage.pubkey })}
          onMute={() => void toggleMute(openMessage.pubkey)}
          onCopy={() => { void navigator.clipboard?.writeText(openMessage.content); setSheet(null); toast.show("good", t("chat.toast.copied")); }}
          onRetry={() => { setSheet(null); void send(openMessage.content); }}
          onReport={() => {
            void publishSigned(KIND_REPORT, reportTags(openMessage, "spam"), "").catch(() => undefined);
            void toggleMute(openMessage.pubkey);
            toast.show("good", t("chat.toast.reported"));
          }}
        />
      )}
      {sheet?.kind === "muted" && (
        <MutedSheet
          people={muted.map(person)}
          onClose={() => setSheet(null)}
          onUnmute={(pubkey) => void toggleMute(pubkey)}
        />
      )}
      {openPerson && (
        <ProfileSheet
          person={openPerson}
          onClose={() => setSheet(null)}
          onMute={() => void toggleMute(openPerson.pubkey)}
          onTip={() => { setSheet(null); onClose(); if (openPerson.zkas) onTip?.(openPerson.zkas); }}
          onCopyKey={() => { void navigator.clipboard?.writeText(openPerson.pubkey); setSheet(null); toast.show("good", t("chat.toast.copied")); }}
          onDm={() => openDm(openPerson.pubkey)}
        />
      )}
      {sheet?.kind === "rooms" && (
        <RoomsSheet
          current={room}
          unread={peek}
          onClose={() => setSheet(null)}
          onDms={() => { setSheet(null); setView({ k: "dms" }); }}
          mutedCount={muted.length}
          onMuted={() => setSheet({ kind: "muted" })}
          onPick={pickRoom}
        />
      )}

      {askName && (
        <div className="modalwrap" onClick={() => setAskName(false)}>
          <div className="card modalcard" onClick={(e) => e.stopPropagation()}>
            <h2 style={{ marginTop: 0 }}>{t("chat.nameTitle")}</h2>
            <p className="muted small" style={{ marginTop: 0 }}>{t("chat.nameWhy")}</p>
            <input value={nameDraft} onChange={(e) => setNameDraft(e.target.value)} placeholder={t("chat.namePlaceholder")} maxLength={32} aria-label={t("chat.nameTitle")} />
            <label style={{ marginTop: 10 }}>{t("chat.tipAddrLabel")}</label>
            <input value={addrDraft} onChange={(e) => setAddrDraft(e.target.value)} placeholder="zkas:…" aria-label={t("chat.tipAddrLabel")} />{/* i18n-ignore: `zkas:` is the address prefix itself, not prose */}
            <p className="muted small">{t("chat.tipAddrWhy")}</p>
            <div className="msg warn small">{t("chat.namePermanent")}</div>
            <button className="btn" onClick={() => void saveName()}>{t("chat.nameSave")}</button>
            <button className="btn ghost" style={{ marginTop: 8 }} onClick={() => { setNickname(""); setAskName(false); void send(draft); }}>
              {t("chat.nameSkip")}
            </button>
          </div>
        </div>
      )}
    </div>,
    document.body,
  );
}
