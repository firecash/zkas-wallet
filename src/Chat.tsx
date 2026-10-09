// ZKas chat — the opt-in sheet and the room.
//
// Two screens and one rule: nothing connects to a relay until the user has read
// what it costs them and said yes.
//
// The room reads the way a messenger reads: bubbles, grouped turns, the time
// inside the bubble, reactions attached under it, and one anchored menu that
// opens on the message you touched. See ChatSheets.tsx for the menu, and
// styles.chat.css for the layout.

import {
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import i18n from "./i18n";
import { getDeviceSeed } from "./lib/deviceseed";
import { useBackClose } from "./lib/backclose";
import { useToast } from "./toast";
import { MessageMenu, MutedSheet, ProfileSheet, RoomsSheet, QUICK_REACTION, type Anchor } from "./ChatSheets";
import "./styles.chat.css";
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
  ABOUT_MAX,
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
  myBio,
  myZkasAddress,
  nickname,
  setMyBio,
  setMyZkasAddress,
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
/** Consecutive messages from one author inside this window share a turn. */
const GROUP_WINDOW_SECS = 5 * 60;
/** How many messages are rendered at once, and how many more each time the list
 *  is pulled to the top. A relay replays up to 200 notes per room and a phone
 *  does not need 200 bubbles in the document to show the last screenful — the
 *  full backfill put 4,100 nodes in the list and scrolling it dropped to 18fps.
 *  Telegram pages its history in exactly this way. */
const PAGE = 40;
/** Pixels from the top of the list at which the next page is pulled in. */
const EARLIER_AT = 260;
/** Movement past this is a scroll or a swipe, not a tap. */
const SLOP_PX = 12;
/** A press held this long is the menu gesture, before the finger comes up. */
const HOLD_MS = 420;
/** How far the bubble must travel to count as swipe-to-reply. */
const SWIPE_PX = 52;

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

/** A message that is nothing but emoji is rendered big, as every messenger does
 *  — a lone 👍 set in body text reads as a typo rather than a reply. */
const PICTO = /\p{Extended_Pictographic}/u;
const PICTO_ONLY = /^(?:\p{Extended_Pictographic}|[\u{1F3FB}-\u{1F3FF}\u{FE0F}\u{200D}\u{20E3}\s])+$/u;
function jumbo(text: string): boolean {
  const s = text.trim();
  if (!s || s.length > 12) return false;
  return PICTO.test(s) && PICTO_ONLY.test(s);
}

/** The label on a date separator. The grouping KEY stays `toDateString()`; this
 *  is only what the capsule says — and it has to be localised, because
 *  `toDateString()` is English whatever the app's language is. */
function dayLabel(unix: number, today: string, yesterday: string): string {
  const d = new Date(unix * 1000);
  const now = new Date();
  if (d.toDateString() === now.toDateString()) return today;
  const y = new Date(now);
  y.setDate(y.getDate() - 1);
  if (d.toDateString() === y.toDateString()) return yesterday;
  return d.toLocaleDateString(
    undefined,
    d.getFullYear() === now.getFullYear() ? { day: "numeric", month: "long" } : { day: "numeric", month: "long", year: "numeric" },
  );
}

/** Which way a message reads.
 *
 *  Decided in JS and written onto the bubble, not left to `dir="auto"` on the
 *  text alone. The time sits in the bubble's trailing bottom corner and the
 *  space for it is reserved at the END of the text — with the bubble LTR and the
 *  text RTL those are opposite corners, and an Arabic message ran its last line
 *  straight through the clock. One direction for the whole bubble keeps every
 *  logical edge inside it on the same side. */
const RTL_RANGE = /[\u0590-\u05FF\u0600-\u06FF\u0700-\u074F\u0750-\u077F\u0780-\u07BF\u08A0-\u08FF\uFB1D-\uFDFF\uFE70-\uFEFF]/;
const LTR_RANGE = /[A-Za-z\u00C0-\u02FF\u0370-\u058F\u0900-\u1FFF\u2C00-\u2DFF\u2E80-\uA4CF\uAC00-\uD7AF]/;
function dirOf(text: string): "rtl" | "ltr" {
  for (const ch of text) {
    if (RTL_RANGE.test(ch)) return "rtl";
    if (LTR_RANGE.test(ch)) return "ltr";
  }
  return "ltr";
}

function hhmm(unix: number): string {
  return new Date(unix * 1000).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

/** A per-author name colour, the way group chats everywhere tint names. The hue
 *  is already derived from the key for the avatar, so the two always agree. */
function nameColor(hue: number): string {
  return `hsl(${hue} 70% 70%)`;
}

function Avatar({ person, big }: { person: Person; big?: boolean }) {
  // Generated, never fetched. A remote avatar URL would make every viewer's
  // client call a stranger's server on render — an IP leak and a free tracker.
  //
  // Tapping it opens that person's profile, which is what every messenger does
  // and what this one did not: the profile sheet already existed, reachable
  // ONLY by long-pressing a message and picking it out of a menu. Your own
  // avatar in the header opened yours; a sender's avatar was inert and marked
  // aria-hidden, so a screen reader could not reach it either.
  //
  // `data-profile` rather than an onClick: MessageRow is memoized and takes no
  // callbacks, and the message list already delegates clicks by data attribute.
  return (
    <span
      className={big ? "chat-avatar big" : "chat-avatar"}
      data-profile={person.pubkey}
      role="button"
      tabIndex={0}
      aria-label={i18n.t("chat.profileOf", { name: person.name })}
      title={person.name}
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
    <>
      {parts.map((p, i) =>
        /^https?:\/\//.test(p) ? (
          <a key={i} href={p} target="_blank" rel="noopener noreferrer nofollow ugc" className="chat-link">
            {p}
          </a>
        ) : (
          <span key={i}>{p}</span>
        ),
      )}
    </>
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

/** One turn in the list: the parts that live inside the bubble.
 *
 *  Factored out because the message menu lifts the message out of the list and
 *  must show exactly what was touched — the same markup, not a quotation of it.
 *
 *  It carries NO handlers. Every gesture on a message — tap, hold, swipe,
 *  right-click, a tap on a reaction pill or on a reply quote — is handled once,
 *  on the list, and resolved back to a message through `data-mid`. Four hundred
 *  rows used to be four hundred freshly allocated handler objects on every
 *  render, and the allocation alone made every row a guaranteed re-render. */
function Bubble({
  m,
  firstOfTurn,
  parentName,
  parentText,
  reacts,
  mine,
  me,
  anon,
  failedLabel,
}: {
  m: ChatMessage;
  firstOfTurn: boolean;
  parentName?: string;
  parentText?: string;
  /** emoji → who reacted with it. Replaced wholesale when it changes, so its
   *  identity is a usable "did this message's reactions move?" test. */
  reacts?: Map<string, Set<string>>;
  mine: boolean;
  me: string;
  anon: string;
  failedLabel: string;
}) {
  const pills = reacts && reacts.size ? [...reacts.entries()] : null;
  return (
    <div className={"chat-bubble" + (jumbo(m.content) ? " jumbo" : "") + (pills ? " has-reacts" : "")} dir={dirOf(m.content)}>
      {firstOfTurn && !mine && (
        <div className="chat-author" style={{ color: nameColor(m.person.hue) }}>
          <span
            className="chat-author-name"
            data-profile={m.person.pubkey}
            role="button"
            tabIndex={0}
            dir={dirOf(m.person.name || anon)}
          >{m.person.name || anon}</span>
          {/* Always visible, never styled away: a nickname is not an identity. */}
          <span className="chat-fp" dir="ltr">·{m.person.fingerprint}</span>
        </div>
      )}
      {parentText !== undefined && (
        <button className="chat-quote" type="button" data-quote={m.replyTo} dir={dirOf(parentText)}>
          <span className="chat-quote-name" dir={dirOf(parentName || "")}>{parentName}</span>
          <span className="chat-quote-text">{parentText}</span>
        </button>
      )}
      <p className="chat-text">
        <Body text={m.content} />
        {/* Reserves the corner the time sits in, so a last line can never run
            underneath it. The time itself is positioned, not in the flow. */}
        <span className={mine ? "chat-time-gap mine" : "chat-time-gap"} aria-hidden="true" />
      </p>
      <span className="chat-time">
        <span dir="ltr">{hhmm(m.created_at)}</span>
        {mine && !m.failed && (
          <svg className="chat-tick" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
            <path d="M3 13l4 4L14 7M12 16l2 2 7-11" />
          </svg>
        )}
      </span>
      {m.failed && <span className="chat-failed">{failedLabel}</span>}
      {pills && (
        <div className="chat-reacts">
          {pills.map(([emoji, who]) => (
            <button
              key={emoji}
              type="button"
              data-react={emoji}
              className={me && who.has(me) ? "chat-react mine" : "chat-react"}
            >
              <span className="chat-react-e">{emoji === "+" ? "👍" : emoji}</span>
              <span className="chat-react-n">{who.size}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

/** One row of the room: its day rule, its unread rule, and the message.
 *
 *  Memoised on purpose. Paging in older history, or a reaction arriving, used to
 *  re-render every message on screen; now only the rows whose own props moved do
 *  any work. That is only sound because `messages` reuses message objects whose
 *  inputs have not changed and the reaction maps are replaced rather than
 *  mutated — see `messages` and `ingest`. */
const MessageRow = memo(function MessageRow({
  m,
  day,
  firstOfTurn,
  lastOfTurn,
  firstUnread,
  parentName,
  parentText,
  reacts,
  me,
  anon,
  failedLabel,
  newLabel,
  reactLabel,
}: {
  m: ChatMessage;
  day?: string;
  firstOfTurn: boolean;
  lastOfTurn: boolean;
  firstUnread: boolean;
  parentName?: string;
  parentText?: string;
  reacts?: Map<string, Set<string>>;
  me: string;
  anon: string;
  failedLabel: string;
  newLabel: string;
  reactLabel: string;
}) {
  return (
    <div className={day ? "chat-slot has-day" : "chat-slot"}>
      {day && <div className="chat-day"><span>{day}</span></div>}
      {firstUnread && <div className="chat-unread-rule"><span>{newLabel}</span></div>}
      <div
        data-mid={m.id}
        className={
          "chat-msg" +
          (m.mine ? " mine" : "") +
          (firstOfTurn ? " first" : "") +
          (lastOfTurn ? " last" : "") +
          (m.failed ? " failed" : "")
        }
      >
        {!m.mine && (lastOfTurn ? <Avatar person={m.person} /> : <span className="chat-avatar spacer" aria-hidden="true" />)}
        <Bubble
          m={m}
          mine={m.mine}
          me={me}
          firstOfTurn={firstOfTurn}
          parentName={parentName}
          parentText={parentText}
          reacts={reacts}
          anon={anon}
          failedLabel={failedLabel}
        />
        {/* Desktop's quick reaction: Telegram puts it at the edge of the bubble
            on hover, so the commonest action never opens a menu. */}
        <button className="chat-quick" data-quick="1" aria-label={reactLabel} title={reactLabel}>
          👍
        </button>
      </div>
    </div>
  );
});

export function ChatScreen({
  onClose,
  onTip,
  myAddress,
}: {
  onClose: () => void;
  onTip?: (addr: string) => void;
  /** This wallet's own receiving address, for one-tap publishing. */
  myAddress?: string;
}) {
  const { t, i18n } = useTranslation();
  const toast = useToast();
  const [room, setRoom] = useState(currentRoom());
  const [state, setState] = useState<ConnectionState>("offline");

  /** Everything the relay has delivered, held in a ref and revised by a counter.
   *
   *  This used to be three `useState` Maps, each CLONED on every arriving event.
   *  A 400-note backfill therefore built 400 Maps and ran 400 renders of the
   *  whole list — quadratic, and the single biggest cause of the screen feeling
   *  slow. Events now mutate the store and schedule ONE render per frame. */
  const store = useRef({
    notes: new Map<string, ChatEvent>(),
    profiles: new Map<string, { name?: string; zkas?: string; about?: string }>(),
    reactions: new Map<string, Map<string, Set<string>>>(),
  });
  const [rev, setRev] = useState(0);
  const frame = useRef<number | null>(null);
  const bump = useCallback(() => {
    if (frame.current !== null) return;
    frame.current = requestAnimationFrame(() => {
      frame.current = null;
      setRev((n) => n + 1);
    });
  }, []);
  useEffect(() => () => { if (frame.current !== null) cancelAnimationFrame(frame.current); }, []);

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
  const [aboutDraft, setAboutDraft] = useState(myBio());
  const [me, setMe] = useState("");
  const [sheet, setSheet] = useState<null | { kind: "profile" | "rooms" | "muted"; pubkey?: string }>(null);
  /** The anchored message menu: which message, and where it was on screen. */
  const [menu, setMenu] = useState<null | { id: string; anchor: Anchor }>(null);
  const [atBottom, setAtBottom] = useState(true);
  /** How much history is in the document. Grows as the list is pulled upward. */
  const [limit, setLimit] = useState(PAGE);
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
  /** What this session has actually READ, as opposed to where the "New messages"
   *  rule is drawn.
   *
   *  These were one value, and that is why the badge kept counting messages that
   *  were already on screen: `sinceOpen` is frozen when the room opens so the rule
   *  stays put while you read — correct for the rule, wrong for the count, which
   *  has to fall to zero as you read. Reported as "it said 27 unread while I was
   *  already at the bottom". `markSeen` was advancing the STORED cursor the whole
   *  time; nothing advanced the one the badge was computed from. */
  const [seenUpTo, setSeenUpTo] = useState(() => lastSeen(currentRoom()));
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
  const swipe = useRef<{ id: string; x: number; y: number; el: HTMLElement; handled: boolean; hold: number } | null>(null);

  const client = useRef<ChatClient | null>(null);
  const bottom = useRef<HTMLDivElement | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);
  const composer = useRef<HTMLTextAreaElement | null>(null);
  const composeBox = useRef<HTMLDivElement | null>(null);

  /** Put the newest message against the bottom of the list.
   *
   *  One function, called from everywhere that can change the usable height —
   *  new messages, the composer growing a line, the on-screen keyboard opening.
   *  Before this, only new messages re-pinned, so typing a three-line message
   *  pushed the message you were replying to underneath the composer. */
  const pin = useCallback(() => {
    const el = listRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, []);
  /** Whether this room has already been positioned since it was opened.
   *
   *  Opening a room jumped straight to the newest message, so a room with unread
   *  messages threw you past all of them and you had to scroll back up hunting for
   *  the last one you had actually read. Telegram puts you AT the unread rule and
   *  lets you read downwards, which is the whole reason the rule exists. */
  const landedOnUnread = useRef(false);
  const atBottomRef = useRef(true);
  atBottomRef.current = atBottom;

  // The on-screen keyboard does not shrink the layout viewport, so a fixed
  // full-height panel keeps its composer underneath it. visualViewport reports
  // what is actually visible; dvh stays as the fallback.
  useEffect(() => {
    const vv = window.visualViewport;
    if (!vv) return;
    const apply = () => {
      document.documentElement.style.setProperty("--chat-vh", `${vv.height}px`);
      // The viewport just changed height under a fixed panel: whatever was at
      // the bottom is now behind the keyboard unless we follow it down.
      if (atBottomRef.current) requestAnimationFrame(pin);
    };
    apply();
    vv.addEventListener("resize", apply);
    vv.addEventListener("scroll", apply);
    return () => {
      vv.removeEventListener("resize", apply);
      vv.removeEventListener("scroll", apply);
      document.documentElement.style.removeProperty("--chat-vh");
    };
  }, [pin]);

  // The composer grows with the message. Every pixel it gains is a pixel the
  // list loses, so the list has to follow.
  useEffect(() => {
    const el = composeBox.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(() => {
      if (atBottomRef.current) pin();
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [pin, view.k, state, canPost]);

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
  // drifting apart. Nothing here clones a collection — see `store`.
  const ingest = useCallback((ev: ChatEvent) => {
    const s = store.current;
    if (ev.kind === KIND_PROFILE) {
      const p = parseProfile(ev.content);
      s.profiles.set(ev.pubkey, p);
      bump();
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
      const forTarget = s.reactions.get(target);
      if (forTarget?.get(ev.content)?.has(ev.pubkey)) return;
      // Copy on write, but only for the ONE message reacted to. The map handed
      // to a row is then stable for as long as that row's reactions are, which
      // is what lets the row skip re-rendering (see `MessageRow`) — a store that
      // mutated in place would have been invisible to it.
      const next = new Map(forTarget ?? []);
      next.set(ev.content, new Set([...(forTarget?.get(ev.content) ?? []), ev.pubkey]));
      s.reactions.set(target, next);
      bump();
      return;
    }
    if (ev.kind === KIND_MUTE_LIST) {
      // Our own list from another device merges by UNION: dropping a local mute
      // because an older list arrived would un-block someone silently.
      const remote = ev.tags.filter((tg) => tg[0] === "p").map((tg) => tg[1]);
      setMuted((prev) => {
        const merged = [...new Set([...prev, ...remote])];
        if (merged.length === prev.length) return prev;
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
      if (!s.notes.has(ev.id)) {
        s.notes.set(ev.id, ev);
        bump();
      }
    }
  }, [bump]);

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
    setSeenUpTo(lastSeen(room));
    landedOnUnread.current = false;
    setLimit(PAGE);
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
    setMenu(null);
    if (r === roomRef.current) return;
    store.current.notes = new Map();
    bump();
    setRoom(r);
    setCurrentRoom(r);
    rememberRoom(r);
    setVisited((n) => n + 1);
  }, [bump]);

  /** Open your own profile for editing, loaded with what was last saved rather
   *  than a stale draft from earlier in this session. */
  const openMyProfile = useCallback(() => {
    setNameDraft(nickname());
    setAddrDraft(myZkasAddress());
    setAboutDraft(myBio());
    setSheet(null);
    setMenu(null);
    setAskName(true);
  }, []);

  /** Open a private conversation. Used by the message menu, the profile sheet
   *  and the conversation list, so all three land in the same state — the list
   *  reset `atBottom`, the profile did not, and a thread opened from a profile
   *  could therefore open scrolled away from its newest message. */
  const openDm = useCallback((peer: string) => {
    setAtBottom(true);
    setSheet(null);
    setMenu(null);
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
    // Theirs first: it is the copy that matters. If the socket drops between the
    // two, the caller still hears about it rather than the failure being
    // swallowed by the optional-chain and the message looking sent.
    if (!client.current?.live) throw new Error("offline");
    client.current.publish(theirs);
    client.current.publish(mine);
    setDms((prev) => {
      const next = new Map(prev);
      const thread = [...(next.get(peer) ?? [])];
      thread.push({ id: `local-${Date.now()}`, sender: id.pubkey_hex, content: body, created_at: Math.floor(Date.now() / 1000) });
      next.set(peer, thread);
      return next;
    });
  }

  /** The handful of strings a row needs, resolved once. Passing `t` itself into
   *  four hundred memoised rows defeats the memo the moment react-i18next hands
   *  back a new function. */
  const anon = t("chat.anon");
  const failedLabel = t("chat.failedTap");
  const newLabel = t("chat.newMessages");
  const reactLabel = t("chat.actions.react");
  const todayLabel = t("chat.today");
  const yesterdayLabel = t("chat.yesterday");
  /** The app's own string may still carry a leading arrow (the label used to BE
   *  "← Wallet"); the header draws a chevron now, so one is stripped whatever
   *  the locale wrote. */
  const backLabel = t("chat.back").replace(/^[\s←⟵<‹«]+/, "");

  /** A Set, not an array scan. `muted.includes()` ran once per message on every
   *  render, which on a full backfill is a few hundred linear scans a frame. */
  const mutedSet = useMemo(() => new Set(muted), [muted]);

  const person = useCallback(
    (pubkey: string): Person => {
      const p = store.current.profiles.get(pubkey);
      return {
        pubkey,
        name: p?.name,
        zkas: p?.zkas,
        about: p?.about,
        firstName: firstNames[pubkey],
        fingerprint: fingerprintOf(pubkey),
        hue: hueOf(pubkey),
        muted: mutedSet.has(pubkey),
      };
      // `rev` is a dependency because profiles live in the store, not in state.
    },
    [firstNames, mutedSet, rev],
  );

  /** Decorated messages, REUSED when nothing about them has changed.
   *
   *  Every arriving event revises `rev`, and this ran again on each one — fine,
   *  except that it rebuilt a new object for all four hundred messages every
   *  time, which made each of them a new prop and so a guaranteed re-render of
   *  the whole list. A message whose author, text, delivery state and mute
   *  status are unchanged now comes back as the SAME object, which is what lets
   *  `MessageRow` skip it. */
  const decorated = useRef(new Map<string, ChatMessage>());
  const messages: ChatMessage[] = useMemo(() => {
    const cache = decorated.current;
    const out: ChatMessage[] = [];
    const live = new Set<string>();
    for (const ev of store.current.notes.values()) {
      if (mutedSet.has(ev.pubkey)) continue;
      live.add(ev.id);
      const who = person(ev.pubkey);
      const mine = !!me && ev.pubkey === me;
      const bad = failed.has(ev.id);
      const had = cache.get(ev.id);
      if (
        had &&
        had.mine === mine &&
        had.failed === bad &&
        had.person.name === who.name &&
        had.person.zkas === who.zkas &&
        had.person.about === who.about &&
        had.person.firstName === who.firstName
      ) {
        out.push(had);
        continue;
      }
      const next: ChatMessage = {
        ...ev,
        person: who,
        replyTo: ev.tags.find((tg) => tg[0] === "e")?.[1],
        mine,
        failed: bad,
      };
      cache.set(ev.id, next);
      out.push(next);
    }
    // Switching rooms empties the note store; the cache must not outlive it.
    if (cache.size > live.size * 2 + 64) for (const k of cache.keys()) if (!live.has(k)) cache.delete(k);
    // `created_at` is author-supplied, so ties break on id to keep the order
    // stable rather than jittering between renders.
    return out.sort((a, b) => a.created_at - b.created_at || a.id.localeCompare(b.id));
  }, [mutedSet, me, person, failed, rev]);

  useEffect(() => {
    // Muted authors are filtered out of `messages`, so asking only about those
    // left meant a muted person's name was never fetched — and the muted list
    // could then only ever show "anon".
    const want = [...new Set([...messages.map((m) => m.pubkey), ...muted])];
    const unknown = want.filter((p) => !store.current.profiles.has(p));
    if (unknown.length) client.current?.requestProfiles(unknown);
  }, [messages, muted, rev]);

  /** The window of history that is actually in the document. */
  const hasEarlier = messages.length > limit;
  const visible = useMemo(() => (hasEarlier ? messages.slice(-limit) : messages), [messages, limit, hasEarlier]);

  /** Rows, with the turn structure resolved once instead of inside the map.
   *
   *  A turn needs to know where it ENDS as well as where it starts — the avatar
   *  belongs to the last bubble of a run and the corner is only rounded there —
   *  and that cannot be decided from a `prev` variable carried down the list. */
  const rows = useMemo(() => {
    let lastDay = "";
    return visible.map((m, i) => {
      const day = new Date(m.created_at * 1000).toDateString();
      const newDay = day !== lastDay;
      if (newDay) lastDay = day;
      const before = i > 0 ? visible[i - 1] : undefined;
      const after = i + 1 < visible.length ? visible[i + 1] : undefined;
      const sameTurn = (a: ChatMessage | undefined, b: ChatMessage) =>
        !!a && a.pubkey === b.pubkey && Math.abs(b.created_at - a.created_at) < GROUP_WINDOW_SECS;
      const parent = m.replyTo ? store.current.notes.get(m.replyTo) : undefined;
      return {
        m,
        day: newDay ? dayLabel(m.created_at, todayLabel, yesterdayLabel) : undefined,
        firstOfTurn: newDay || !sameTurn(before, m),
        lastOfTurn: !after || !sameTurn(m, after) || new Date(after.created_at * 1000).toDateString() !== day,
        firstUnread: !m.mine && m.created_at > sinceOpen && (!before || before.created_at <= sinceOpen),
        parentName: parent ? person(parent.pubkey).name || anon : undefined,
        parentText: parent ? parent.content : undefined,
        reacts: store.current.reactions.get(m.id),
      };
    });
  }, [visible, sinceOpen, person, anon, todayLabel, yesterdayLabel, rev]);

  /** Pull in the previous page, keeping the reading position still. */
  const growFrom = useRef<number | null>(null);
  const loadEarlier = useCallback(() => {
    const el = listRef.current;
    growFrom.current = el ? el.scrollHeight - el.scrollTop : null;
    setLimit((n) => n + PAGE);
  }, []);
  useLayoutEffect(() => {
    const el = listRef.current;
    if (!el || growFrom.current === null) return;
    el.scrollTop = el.scrollHeight - growFrom.current;
    growFrom.current = null;
  }, [limit]);

  useLayoutEffect(() => {
    // First paint of a freshly opened room: land on the unread rule if there is
    // one, so the first thing on screen is the last message you had read and
    // everything new is below it. Only once per room — after that the normal
    // bottom-pinning applies, or you could never scroll away.
    if (!landedOnUnread.current && rows.length) {
      const el = listRef.current;
      const rule = el?.querySelector<HTMLElement>(".chat-unread-rule");
      // Only spend the one-shot once the question is actually answerable. The
      // first paint can have rows while the unread rule is still a render away,
      // and consuming it there left the room pinned to the bottom with the rule
      // thousands of pixels above the viewport — measured at -3721px.
      if (rule || !hasUnreadRow) landedOnUnread.current = true;
      if (el && rule) {
        // Measured against the list, not the page: offsetTop depends on which
        // ancestor happens to be positioned, and this must not move the page.
        // Re-anchor over the next few frames. Landing once is not enough: rows
        // ABOVE the rule settle after first paint (fonts, avatars, a reply quote
        // wrapping to two lines), and because they are above the viewport their
        // height change slides the rule out of it — measured drifting 426px up
        // from a single-shot landing.
        const place = () => {
          const r = el.querySelector<HTMLElement>(".chat-unread-rule");
          if (!r) return;
          const top = r.getBoundingClientRect().top - el.getBoundingClientRect().top + el.scrollTop;
          el.scrollTop = Math.max(0, top - 12);
        };
        place();
        requestAnimationFrame(() => { place(); requestAnimationFrame(place); });
        // The ref too, not just the state: the composer ResizeObserver and the
        // visualViewport handler both re-pin through `atBottomRef`, and on mount
        // they fire before a state update has propagated — which scrolled the room
        // straight back to the newest message after it had correctly landed.
        atBottomRef.current = false;
        setAtBottom(false);
        return;
      }
    }
    // Set scrollTop so the movement stays INSIDE the list. `scrollIntoView`
    // walks up every scrollable ancestor, which on a phone drags the page and
    // fights the keyboard.
    if (atBottom && growFrom.current === null) pin();
  }, [rows, atBottom, room, view, dms, replyTo, pin]);

  useEffect(() => {
    const newest = messages[messages.length - 1];
    // Not before the room has been positioned. `atBottom` starts true, so this
    // fired on mount and marked the whole backlog read — the unread rule was
    // placed correctly and then instantly made meaningless.
    // `atBottomRef`, not the state: the landing above runs in a LAYOUT effect and
    // sets both, but this passive effect runs in the same commit and still sees the
    // old `atBottom === true` — which marked the whole backlog read the instant a
    // room opened, one frame after the unread rule had been placed correctly.
    if (newest && atBottomRef.current && landedOnUnread.current) {
      markSeen(room, newest.created_at);
      // Sitting at the bottom IS reading it. Without this the badge only ever
      // cleared by leaving and re-entering the room.
      setSeenUpTo((prev) => (newest.created_at > prev ? newest.created_at : prev));
    }
    if (newest) newestInRoom.current = Math.max(newestInRoom.current, newest.created_at);
  }, [messages, atBottom, room]);

  /** Does the rendered window contain the unread rule? Drives the one-shot above:
   *  without it we cannot tell "no unread messages" from "the rule has not been
   *  rendered yet", and the two need opposite behaviour. */
  const hasUnreadRow = useMemo(() => rows.some((r) => r.firstUnread), [rows]);

  const unreadCount = useMemo(
    () => messages.reduce((n, m) => (m.created_at > seenUpTo && !m.mine ? n + 1 : n), 0),
    [messages, seenUpTo],
  );

  async function publishSigned(kind: number, tags: string[][], content: string): Promise<void> {
    const signed = await signAs(getDeviceSeed(), 0, kind, tags, content);
    client.current?.publish(signed);
  }

  /** React, and show it at once.
   *
   *  The reaction used to appear only when the relay echoed it back, so the one
   *  thing the owner asked to be immediate was the one thing that waited on a
   *  round trip. It is ingested locally first; the echo dedupes by pubkey. */
  const react = useCallback(
    async (m: ChatMessage, emoji: string) => {
      try {
        const signed = await signAs(getDeviceSeed(), 0, KIND_REACTION, reactionTags(m, roomRef.current), emoji);
        ingest(JSON.parse(signed) as ChatEvent);
        client.current?.publish(signed);
      } catch {
        /* a reaction that cannot be signed is not worth an error banner */
      }
    },
    [ingest],
  );

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
      setAtBottom(true);
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
      // The draft is cleared only once the message is actually out.
      //
      // It used to be wiped first. `publish()` throws when the socket is down,
      // so a DM typed while the relay was away vanished completely: not on
      // screen, not queued, not retryable, and the typed text gone with it. The
      // public-room path has always done this correctly — it clears after a
      // successful publish and leaves a failed row the user can tap to retry.
      setSending(true);
      try {
        await sendDm(view.peer, body);
        setDraft("");
        if (composer.current) composer.current.style.height = "auto";
      } catch {
        setError("send");
      } finally {
        setSending(false);
      }
    } else {
      await send();
      if (composer.current) composer.current.style.height = "auto";
    }
    composer.current?.focus();
    pin();
  }

  async function saveName() {
    // Is this the first-run "pick a name before you can send" prompt, or someone
    // editing their profile? The two share this function, and it ended with an
    // unconditional `if (draft.trim()) void send(draft)` — so changing your bio
    // with anything sitting in the composer PUBLISHED it to the room. The button
    // label already knew the difference: "Save and send" on first run, "Save" when
    // editing. Sending the draft is only ever right on the first.
    const firstRun = !nickname();
    const name = nameDraft.trim().slice(0, 32);
    const addr = addrDraft.trim();
    const about = aboutDraft.trim().slice(0, ABOUT_MAX);
    setNickname(name);
    setMyZkasAddress(addr);
    setMyBio(about);
    setAskName(false);
    try {
      await publishSigned(KIND_PROFILE, [], profileContent(name, addr || undefined, about || undefined));
    } catch {
      /* stored locally either way; it publishes with the next send */
    }
    if (firstRun && draft.trim()) void send(draft);
  }

  async function toggleMute(pubkey: string) {
    const wasMuted = mutedSet.has(pubkey);
    const next = wasMuted ? muted.filter((k) => k !== pubkey) : [...muted, pubkey];
    setMuted(next);
    setMutedKeys(next);
    setSheet(null);
    setMenu(null);
    toast.show("good", wasMuted ? t("chat.toast.unmuted") : t("chat.toast.muted"));
    try {
      await publishSigned(KIND_MUTE_LIST, muteTags(next), "");
    } catch {
      /* the local mute already applies; the list syncs on the next connection */
    }
  }

  /** Open the anchored menu on the bubble that was touched. */
  const openMenu = useCallback((m: ChatMessage, el: HTMLElement) => {
    const r = el.getBoundingClientRect();
    setMenu({ id: m.id, anchor: { top: r.top, bottom: r.bottom, left: r.left, right: r.right, mine: m.mine } });
  }, []);

  /** Jump to the message a reply quotes, and flash it.
   *
   *  A quote that cannot be followed is decoration. If the parent is older than
   *  the window currently in the document, the window grows until it is in. */
  const goToMessage = useCallback(
    (id: string) => {
      const show = () => {
        const el = listRef.current?.querySelector(`[data-mid="${CSS.escape(id)}"]`) as HTMLElement | null;
        if (!el) return false;
        const list = listRef.current!;
        list.scrollTop = el.offsetTop - list.clientHeight / 2 + el.clientHeight / 2;
        setAtBottom(false);
        el.classList.remove("flash");
        // Reflow, so re-flashing the same row restarts the animation.
        void el.offsetWidth;
        el.classList.add("flash");
        return true;
      };
      if (show()) return;
      const idx = messages.findIndex((m) => m.id === id);
      if (idx < 0) return;
      growFrom.current = null;
      setLimit(Math.max(limit, messages.length - idx + PAGE));
      requestAnimationFrame(() => requestAnimationFrame(show));
    },
    [messages, limit],
  );

  /** How a message is operated — Telegram's grammar, as closely as the web
   *  allows:
   *
   *    tap / click   → the anchored menu (reactions above, commands below)
   *    press & hold  → the same menu, on the hold rather than the release
   *    right-click   → the same menu, so a desktop context menu does not sit on
   *                    top of the app's own
   *    swipe right   → reply, with the bubble following the finger
   *    tap a pill    → add your reaction to one already there, opening nothing
   *
   *  What a tap must NOT do is run something. The menu opens under the finger,
   *  so a second tap used to land on a row, and "Mute this person" is one of
   *  them. That is fixed where it belongs — the menu ignores taps for its first
   *  350ms, and mute and report take two deliberate taps with the second one
   *  spelled out — not by making every reader hold their thumb down.
   *
   *  ONE set of handlers, on the list, not one per row. The gesture is resolved
   *  back to a message through the `data-mid` on the row, which is also what the
   *  reply-quote jump looks a message up by. */
  const byId = useMemo(() => new Map(visible.map((m) => [m.id, m])), [visible]);
  const hit = useCallback(
    (e: { target: EventTarget | null }) => {
      const el = (e.target as HTMLElement | null)?.closest?.("[data-mid]") as HTMLElement | null;
      const id = el?.getAttribute("data-mid");
      const m = id ? byId.get(id) : undefined;
      return m ? { m, el: el!.querySelector(".chat-bubble") as HTMLElement | null } : null;
    },
    [byId],
  );

  const release = useCallback(() => {
    const st = swipe.current;
    if (!st) return;
    clearTimeout(st.hold);
    st.el.style.transition = "";
    st.el.style.transform = "";
    st.el.closest(".chat-msg")?.classList.remove("swiping");
  }, []);

  const listGestures = {
    onPointerDown: (e: ReactPointerEvent) => {
      const h = hit(e);
      if (!h?.el) return;
      const el = h.el;
      const m = h.m;
      const hold = window.setTimeout(() => {
        if (swipe.current?.id === m.id) {
          swipe.current.handled = true;
          el.style.transform = "";
          openMenu(m, el);
        }
      }, HOLD_MS);
      swipe.current = { id: m.id, x: e.clientX, y: e.clientY, el, handled: false, hold };
    },
    onPointerMove: (e: ReactPointerEvent) => {
      const st = swipe.current;
      if (!st || st.handled) return;
      const dx = e.clientX - st.x;
      const dy = e.clientY - st.y;
      if (Math.abs(dx) > SLOP_PX || Math.abs(dy) > SLOP_PX) clearTimeout(st.hold);
      // Touch only. With a mouse, dragging across a message is how a person
      // SELECTS its text to copy, and hijacking that to drag the bubble made
      // desktop selection impossible. Desktop replies from the menu.
      if (e.pointerType === "mouse") return;
      // Rightward and roughly level: track the finger, with resistance.
      if (dx > SLOP_PX && Math.abs(dy) < 44) {
        st.el.style.transition = "none";
        st.el.style.transform = `translateX(${Math.min(dx * 0.55, 64)}px)`;
        st.el.closest(".chat-msg")?.classList.toggle("swiping", dx > SWIPE_PX);
      }
    },
    onPointerCancel: () => {
      release();
      swipe.current = null;
    },
    onPointerUp: (e: ReactPointerEvent) => {
      const st = swipe.current;
      if (!st) return;
      release();
      if (st.handled) return;
      const dx = e.clientX - st.x;
      const dy = e.clientY - st.y;
      if (e.pointerType !== "mouse" && dx > SWIPE_PX && Math.abs(dy) < 60) {
        st.handled = true; // "this gesture was handled, swallow the click"
        const m = byId.get(st.id);
        if (m) setReplyTo(m);
        composer.current?.focus();
        return;
      }
      // A scroll that began on this message is not a tap on it either.
      if (Math.abs(dx) > SLOP_PX || Math.abs(dy) > SLOP_PX) st.handled = true;
    },
    onClick: (e: ReactMouseEvent) => {
      const handled = swipe.current?.handled;
      swipe.current = null;
      if (handled) return;
      const target = e.target as HTMLElement;
      const h = hit(e);
      if (!h) return;
      // A reaction pill, the quick-react button and the reply quote are their
      // own controls, not a tap on the message.
      const pill = target.closest("[data-react]");
      if (pill) {
        const emoji = pill.getAttribute("data-react");
        const already = pill.classList.contains("mine");
        if (emoji && !already) void react(h.m, emoji);
        return;
      }
      if (target.closest("[data-quick]")) {
        void react(h.m, QUICK_REACTION);
        return;
      }
      const quote = target.closest("[data-quote]");
      if (quote) {
        const to = quote.getAttribute("data-quote");
        if (to) goToMessage(to);
        return;
      }
      // The sender's avatar or name opens their profile, as in Telegram, rather
      // than falling through to the message menu.
      const who = target.closest("[data-profile]");
      if (who) {
        const pubkey = who.getAttribute("data-profile");
        if (pubkey) { setMenu(null); setSheet({ kind: "profile", pubkey }); }
        return;
      }
      if (target.closest(".chat-link")) return;
      if (h.el) openMenu(h.m, h.el);
    },
    onContextMenu: (e: ReactMouseEvent) => {
      const h = hit(e);
      if (!h?.el) return;
      e.preventDefault();
      if (swipe.current) clearTimeout(swipe.current.hold);
      swipe.current = null;
      openMenu(h.m, h.el);
    },
  };

  const openMessage = menu ? messages.find((m) => m.id === menu.id) : undefined;
  const openPerson = sheet?.kind === "profile" && sheet.pubkey ? person(sheet.pubkey) : undefined;

  const dot = state === "live" ? "chat-dot live" : state === "connecting" ? "chat-dot warm" : "chat-dot off";

  /** The rendered conversation, built only when the conversation changes.
   *
   *  Scrolling re-renders this screen (the at-bottom flag lives here), and that
   *  used to mean re-creating one element per message — four hundred of them,
   *  every frame, which was most of the cost of a scroll. Handing React the same
   *  element objects lets it skip the whole subtree. */
  const listBody = useMemo(
    () => rows.map((r) => <MessageRow key={r.m.id} {...r} me={me} anon={anon} failedLabel={failedLabel} newLabel={newLabel} reactLabel={reactLabel} />),
    [rows, me, anon, failedLabel, newLabel, reactLabel],
  );

  /** The copy of a message the menu lifts out of the list. Same component the
   *  list uses, so what you act on is what you touched. */
  const liftedBubble = (m: ChatMessage): ReactNode => {
    const parent = m.replyTo ? store.current.notes.get(m.replyTo) : undefined;
    return (
      <Bubble
        m={m}
        mine={m.mine}
        me={me}
        firstOfTurn
        parentName={parent ? person(parent.pubkey).name || anon : undefined}
        parentText={parent ? parent.content : undefined}
        reacts={store.current.reactions.get(m.id)}
        anon={anon}
        failedLabel={failedLabel}
      />
    );
  };

  return createPortal(
    <div className="chat-screen" role="dialog" aria-modal="true" aria-label={t("chat.roomAria")}>
      <header className="chat-head">
        {/* Back steps WITHIN chat first — thread → list → room → wallet — so a
            private conversation is not one tap from vanishing. */}
        <button
          className="chat-back"
          aria-label={backLabel}
          onClick={() => {
            if (view.k === "dm") setView({ k: "dms" });
            else if (view.k === "dms") setView({ k: "room" });
            else onClose();
          }}
        >
          <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M15 5l-7 7 7 7" /></svg>
          <span className="chat-back-label">{backLabel}</span>
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
            strip, where it sat past the right edge and had to be scrolled to. */}
        <button className="chat-icon-btn" onClick={() => setSheet({ kind: "rooms" })} aria-label={t("chat.rooms.all")} title={t("chat.rooms.all")}>
          <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M4 7h16M4 12h16M4 17h16" /></svg>
        </button>
        {/* Your own profile, where every messenger puts it: your avatar, in the
            header. It was only reachable through a row inside the "All rooms"
            sheet — a sheet about ROOMS — so nobody found it. */}
        <button className="chat-me" onClick={openMyProfile} aria-label={t("chat.profileTitle")} title={t("chat.profileTitle")}>
          <span className="chat-avatar" style={{ background: me ? `hsl(${hueOf(me)} 58% 42%)` : "var(--line)" }}>
            {me ? me.slice(0, 2) : "·"}
          </span>
        </button>
      </header>

      {/* The switcher, always on screen. Rooms AND the open conversation at once,
          so moving between them is one tap on something already visible rather
          than a tap to open a sheet and a tap to pick a row — and so a newcomer
          can see that more than one room exists at all. */}
      <nav className="chat-rooms" aria-label={t("chat.rooms.title")}>
        <button
          className={view.k === "room" ? "chat-chip" : "chat-chip on"}
          aria-current={view.k !== "room"}
          onClick={() => { setAtBottom(true); setView({ k: "dms" }); }}
        >
          <span className="chat-chip-label">{t("chat.dm.title")}</span>
          {dmUnread > 0 && <span className="chat-chip-n">{dmUnread}</span>}
        </button>
        {chipRooms.map((r) => (
          <button
            key={r}
            className={view.k === "room" && r === room ? "chat-chip on" : "chat-chip"}
            aria-current={view.k === "room" && r === room}
            onClick={() => pickRoom(r)}
          >
            <span className="chat-chip-label">{roomLabel(r)}</span>
            {r !== room && peek[r] > 0 && <span className="chat-chip-n">{peek[r]}</span>}
          </button>
        ))}
      </nav>

      {error === "engine" && <div className="msg warn small chat-banner">{t("chat.errEngine")}</div>}

      {view.k === "dms" && (
        <div className="chat-list chat-dmlist" ref={listRef}>
          {dms.size === 0 && (
            <div className="chat-blank">
              <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M4 6h16v11H9l-5 4Z" /></svg>
              <b>{t("chat.dm.none")}</b>
              <span>{t("chat.dm.note")}</span>
            </div>
          )}
          {[...dms.entries()]
            .sort((a, b) => (b[1][b[1].length - 1]?.created_at ?? 0) - (a[1][a[1].length - 1]?.created_at ?? 0))
            .map(([peer, thread]) => {
              const who = person(peer);
              const last = thread[thread.length - 1];
              return (
                <button key={peer} className="chat-dm-row" onClick={() => openDm(peer)}>
                  <Avatar person={who} />
                  <span className="chat-dm-body">
                    <span className="chat-dm-top">
                      <b dir="auto">{who.name || t("chat.anon")}</b>
                      <span className="chat-fp">·{who.fingerprint}</span>
                      {last && <time>{new Date(last.created_at * 1000).toLocaleDateString()}</time>}
                    </span>
                    <span className="chat-dm-last" dir="auto">{last?.content ?? ""}</span>
                  </span>
                </button>
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
            const low = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
            if (low !== atBottomRef.current) setAtBottom(low);
          }}
        >
          <p className="chat-service">{t("chat.dm.note")}</p>
          {(dms.get(view.peer) ?? []).map((dm) => {
            const who = person(dm.sender);
            const isMine = dm.sender === me;
            return (
              <div key={dm.id} className={"chat-msg last first" + (isMine ? " mine" : "")}>
                {!isMine && <Avatar person={who} />}
                <div className={"chat-bubble" + (jumbo(dm.content) ? " jumbo" : "")} dir={dirOf(dm.content)}>
                  <p className="chat-text">
                    <Body text={dm.content} />
                    <span className={isMine ? "chat-time-gap mine" : "chat-time-gap"} aria-hidden="true" />
                  </p>
                  <span className="chat-time"><span dir="ltr">{hhmm(dm.created_at)}</span></span>
                </div>
              </div>
            );
          })}
          <div ref={bottom} />
        </div>
      )}

      {view.k === "room" && <div
        className="chat-list"
        ref={listRef}
        {...listGestures}
        onScroll={() => {
          const el = listRef.current;
          if (!el) return;
          // Only when it actually changes: setting the same value still woke
          // React up once per scroll event, which is sixty renders a second.
          const low = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
          if (low !== atBottomRef.current) setAtBottom(low);
          if (el.scrollTop < EARLIER_AT && hasEarlier && growFrom.current === null) loadEarlier();
        }}
      >
        {/* Said once, at the top of the room: what this place is. A service
            line, the way a messenger states a fact about a chat — not a boxed
            paragraph of instructions for a UI that now explains itself. */}
        {!hasEarlier && <p className="chat-service">{t("chat.intro")}</p>}
        {hasEarlier && (
          <button className="chat-earlier" onClick={loadEarlier}>{t("chat.earlier")}</button>
        )}
        {messages.length === 0 && (
          <div className="chat-blank">
            <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M4 6h16v11H9l-5 4Z" /></svg>
            <b>{state === "live" ? t("chat.empty") : state === "blocked" ? t("chat.torBlocked") : t("chat.connecting")}</b>
          </div>
        )}
        {listBody}
        <div ref={bottom} />
      </div>}

      {view.k === "room" && !atBottom && (
        <button
          className="chat-jump"
          aria-label={t("chat.jumpLatest")}
          title={t("chat.jumpLatest")}
          onClick={() => { setAtBottom(true); pin(); }}
        >
          <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M6 10l6 6 6-6" /></svg>
          {unreadCount > 0 && <span className="chat-chip-n">{unreadCount}</span>}
        </button>
      )}

      {replyTo && view.k === "room" && (
        <div className="chat-replying">
          <svg className="chat-ico" viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M9 7 4 12l5 5M4 12h8a6 6 0 0 1 6 6v1" /></svg>
          <span className="chat-replying-body">
            <span className="chat-replying-name">{t("chat.replyingTo", { name: replyTo.person.name || t("chat.anon") })}</span>
            <span className="chat-replying-text" dir="auto">{replyTo.content}</span>
          </span>
          <button className="chat-icon-btn" onClick={() => setReplyTo(null)} aria-label={t("chat.cancel")} title={t("chat.cancel")}>
            <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M6 6l12 12M18 6 6 18" /></svg>
          </button>
        </div>
      )}

      {error === "send" && <div className="msg warn small chat-banner">{t("chat.errSend")}</div>}

      {/* Tor is on and the relay is not an onion. A WebView socket cannot use
          the engine's SOCKS proxy, so connecting would publish the real IP of
          someone who switched Tor on — the one thing the consent screen frames
          as a deliberate choice. Say what happened and what would fix it. */}
      {state === "blocked" && <div className="msg warn small chat-banner">{t("chat.torBlocked")}</div>}

      {view.k === "dms" ? null : state === "blocked" ? (
        <div className="chat-compose readonly" ref={composeBox}>
          <span className="muted small">{t("chat.torBlockedShort")}</span>
        </div>
      ) : canPost ? (
        <div className="chat-compose" ref={composeBox}>
          <textarea
            ref={composer}
            value={draft}
            rows={1}
            onFocus={() => { if (atBottomRef.current) requestAnimationFrame(pin); }}
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
          <button
            className="chat-send"
            onClick={() => void submit()}
            disabled={sending || !draft.trim()}
            aria-label={sending ? t("chat.sending") : t("chat.send")}
            title={sending ? t("chat.sending") : t("chat.send")}
          >
            <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M4 12h14M11 5l7 7-7 7" /></svg>
          </button>
        </div>
      ) : (
        <div className="chat-compose readonly" ref={composeBox}>
          <span className="muted small">{t("chat.readOnly")}</span>
        </div>
      )}

      {openMessage && menu && (
        <MessageMenu
          message={openMessage}
          anchor={menu.anchor}
          preview={liftedBubble(openMessage)}
          onClose={() => setMenu(null)}
          onReply={() => { setReplyTo(openMessage); setMenu(null); composer.current?.focus(); }}
          onReact={(emoji) => {
            setMenu(null);
            void react(openMessage, emoji);
          }}
          onDm={() => openDm(openMessage.pubkey)}
          onTip={() => { setMenu(null); onClose(); if (openMessage.person.zkas) onTip?.(openMessage.person.zkas); }}
          onProfile={() => { setMenu(null); setSheet({ kind: "profile", pubkey: openMessage.pubkey }); }}
          onMute={() => void toggleMute(openMessage.pubkey)}
          onCopy={() => { void navigator.clipboard?.writeText(openMessage.content); setMenu(null); toast.show("good", t("chat.toast.copied")); }}
          onRetry={() => { setMenu(null); void send(openMessage.content); }}
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
          onProfile={openMyProfile}
          onPick={pickRoom}
        />
      )}

      {askName && (
        <div className="modalwrap" onClick={() => setAskName(false)}>
          <div className="card modalcard" onClick={(e) => e.stopPropagation()}>
            <h2 style={{ marginTop: 0 }}>{nickname() ? t("chat.profileTitle") : t("chat.nameTitle")}</h2>
            {/* First run is being ASKED for a name before a first message; every
                later visit is editing. The same sentence cannot do both — it was
                telling people who already had a profile that they could "skip it
                and post as anon". */}
            <p className="muted small" style={{ marginTop: 0 }}>{nickname() ? t("chat.profileWhy") : t("chat.nameWhy")}</p>
            <label>{t("chat.nameLabel")}</label>
            <input value={nameDraft} onChange={(e) => setNameDraft(e.target.value)} placeholder={t("chat.namePlaceholder")} maxLength={32} aria-label={t("chat.nameTitle")} />
            <label style={{ marginTop: 10 }}>{t("chat.bioLabel")}</label>
            <textarea
              className="chat-bio-input"
              value={aboutDraft}
              onChange={(e) => setAboutDraft(e.target.value)}
              placeholder={t("chat.bioPlaceholder")}
              maxLength={ABOUT_MAX}
              rows={2}
              aria-label={t("chat.bioLabel")}
            />
            <p className="muted small">{t("chat.bioWhy", { n: ABOUT_MAX - aboutDraft.trim().length })}</p>
            <label style={{ marginTop: 10 }}>{t("chat.tipAddrLabel")}</label>
            <input value={addrDraft} onChange={(e) => setAddrDraft(e.target.value)} placeholder="zkas:…" aria-label={t("chat.tipAddrLabel")} />{/* i18n-ignore: `zkas:` is the address prefix itself, not prose */}
            {/* Publishing your address meant going to Receive, copying it, and
                coming back. The wallet already knows it. */}
            {myAddress && addrDraft.trim() !== myAddress && (
              <button className="btn ghost small" style={{ marginTop: 8, width: "auto" }} onClick={() => setAddrDraft(myAddress)}>
                {t("chat.useMyAddress")}
              </button>
            )}
            {addrDraft.trim() && (
              <button className="btn ghost small" style={{ marginTop: 8, width: "auto" }} onClick={() => setAddrDraft("")}>
                {t("chat.clearAddress")}
              </button>
            )}
            <p className="muted small">{t("chat.tipAddrWhy")}</p>
            <div className="msg warn small">{t("chat.namePermanent")}</div>
            <button className="btn" onClick={() => void saveName()}>
              {nickname() ? t("chat.profileSave") : t("chat.nameSave")}
            </button>
            <button
              className="btn ghost"
              style={{ marginTop: 8 }}
              onClick={() => {
                if (nickname()) { setAskName(false); return; }
                setNickname("");
                setAskName(false);
                void send(draft);
              }}
            >
              {nickname() ? t("chat.cancel") : t("chat.nameSkip")}
            </button>
          </div>
        </div>
      )}
    </div>,
    document.body,
  );
}
