// ZKas chat — the opt-in sheet and the room.
//
// Two screens and one rule: nothing connects to a relay until the user has read
// what it costs them and said yes.
//
// Everything the chat can do is reached by tapping the thing it applies to — a
// message, a person, the room name — so the message row itself stays free of
// controls. See ChatSheets.tsx.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import { getDeviceSeed } from "./lib/deviceseed";
import { useBackClose } from "./lib/backclose";
import { useToast } from "./toast";
import { MessageSheet, ProfileSheet, ReactionSheet, RoomsSheet } from "./ChatSheets";
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
  mutedKeys,
  myZkasAddress,
  nickname,
  setChatEnabled,
  setCurrentRoom,
  setMutedKeys,
  setMyChatPubkey,
  setNickname,
} from "./lib/chatprefs";

const FIRSTNAME_KEY = "zkas_chat_firstnames_v1";
/** Consecutive messages from one author inside this window share a header. */
const GROUP_WINDOW_SECS = 5 * 60;

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
  const { t } = useTranslation();
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
  const [sheet, setSheet] = useState<null | { kind: "msg" | "profile" | "rooms" | "react"; id?: string; pubkey?: string }>(null);
  const [atBottom, setAtBottom] = useState(true);
  // One screen, three views: the room, the list of private conversations, and
  // one conversation. Keeping them here means one socket and one layout.
  const [view, setView] = useState<{ k: "room" } | { k: "dms" } | { k: "dm"; peer: string }>({ k: "room" });
  const [dms, setDms] = useState<Map<string, Array<{ id: string; sender: string; content: string; created_at: number }>>>(new Map());
  const [sinceOpen] = useState(() => lastSeen(currentRoom()));

  const canPost = useMemo(() => !!getDeviceSeed(), []);
  // Swipe-right-to-reply. The action sheet holds everything, but replying is the
  // one action common enough that making it cost two taps was a regression from
  // the visible button it replaced — so it also gets a gesture.
  const swipe = useRef<{ id: string; x: number } | null>(null);
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
      setNotes((prev) => (prev.has(ev.id) ? prev : new Map(prev).set(ev.id, ev)));
    }
  }, []);

  useEffect(() => {
    const c = new ChatClient(room, ingest, setState);
    client.current = c;
    c.connect();
    return () => c.close();
  }, [ingest, room]);

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
    const unknown = [...new Set(messages.map((m) => m.pubkey))].filter((p) => !profiles.has(p));
    if (unknown.length) client.current?.requestProfiles(unknown);
  }, [messages, profiles]);

  useEffect(() => {
    // Set scrollTop so the movement stays INSIDE the list. `scrollIntoView`
    // walks up every scrollable ancestor, which on a phone drags the page and
    // fights the keyboard.
    if (atBottom && listRef.current) listRef.current.scrollTop = listRef.current.scrollHeight;
    const newest = messages[messages.length - 1];
    if (newest && atBottom) markSeen(room, newest.created_at);
  }, [messages, atBottom, room, view, dms]);

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
            {view.k === "room" ? `#${room} ▾` : view.k === "dms" ? t("chat.dm.title") : (person(view.peer).name || t("chat.anon"))}
          </span>
          <span className="chat-state">
            <i className={dot} aria-hidden="true" />
            {view.k === "dm" ? t("chat.dm.headerNote") : t("chat.state." + state)}
          </span>
        </button>
      </header>

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
                <article key={peer} className="chat-msg" onClick={() => { setAtBottom(true); setView({ k: "dm", peer }); }}>
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
          <p className="muted small chat-empty">{state === "live" ? t("chat.empty") : t("chat.connecting")}</p>
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
                onClick={() => setSheet({ kind: "msg", id: m.id, pubkey: m.pubkey })}
                onTouchStart={(e) => { swipe.current = { id: m.id, x: e.touches[0].clientX }; }}
                onTouchEnd={(e) => {
                  const st = swipe.current;
                  swipe.current = null;
                  if (!st || st.id !== m.id) return;
                  // Rightward only, and far enough to be deliberate rather than a
                  // sloppy tap or a horizontal scroll.
                  if (e.changedTouches[0].clientX - st.x > 60) {
                    setReplyTo(m);
                    e.preventDefault();
                  }
                }}
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

      {canPost ? (
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
            placeholder={view.k === "dm" ? t("chat.dm.placeholder") : t("chat.placeholder")}
            maxLength={2000}
            aria-label={view.k === "dm" ? t("chat.dm.placeholder") : t("chat.placeholder")}
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
          onReact={() => setSheet({ kind: "react", id: openMessage.id, pubkey: openMessage.pubkey })}
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
      {sheet?.kind === "react" && sheet.id && (
        <ReactionSheet
          onClose={() => setSheet(null)}
          onPick={(emoji) => {
            const target = notes.get(sheet.id as string);
            setSheet(null);
            if (target) void publishSigned(KIND_REACTION, reactionTags(target, room), emoji).catch(() => undefined);
          }}
        />
      )}
      {openPerson && (
        <ProfileSheet
          person={openPerson}
          onClose={() => setSheet(null)}
          onMute={() => void toggleMute(openPerson.pubkey)}
          onTip={() => { setSheet(null); onClose(); if (openPerson.zkas) onTip?.(openPerson.zkas); }}
          onCopyKey={() => { void navigator.clipboard?.writeText(openPerson.pubkey); setSheet(null); toast.show("good", t("chat.toast.copied")); }}
          onDm={() => { setSheet(null); setView({ k: "dm", peer: openPerson.pubkey }); }}
        />
      )}
      {sheet?.kind === "rooms" && (
        <RoomsSheet
          current={room}
          unread={{}}
          onClose={() => setSheet(null)}
          onDms={() => { setSheet(null); setView({ k: "dms" }); }}
          onPick={(r) => { setRoom(r); setCurrentRoom(r); setNotes(new Map()); setSheet(null); setView({ k: "room" }); }}
        />
      )}

      {askName && (
        <div className="modalwrap" onClick={() => setAskName(false)}>
          <div className="card modalcard" onClick={(e) => e.stopPropagation()}>
            <h2 style={{ marginTop: 0 }}>{t("chat.nameTitle")}</h2>
            <p className="muted small" style={{ marginTop: 0 }}>{t("chat.nameWhy")}</p>
            <input value={nameDraft} onChange={(e) => setNameDraft(e.target.value)} placeholder={t("chat.namePlaceholder")} maxLength={32} aria-label={t("chat.nameTitle")} />
            <label style={{ marginTop: 10 }}>{t("chat.tipAddrLabel")}</label>
            <input value={addrDraft} onChange={(e) => setAddrDraft(e.target.value)} placeholder="zkas:…" aria-label={t("chat.tipAddrLabel")} />
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
