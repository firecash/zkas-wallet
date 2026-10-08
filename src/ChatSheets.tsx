// The chat's menus and sheets.
//
// Two primitives now, not one:
//
//   `Sheet`       — a bottom sheet (rooms, muted people, a profile). Things that
//                   are about the whole screen, not about one line in it.
//   `MessageMenu` — Telegram's message menu: the message lifts out of the list,
//                   a reaction bar floats ABOVE it and a compact command card
//                   sits BELOW it, both anchored to where the message actually
//                   is. A full-width sheet for one line of text was the thing
//                   that made this screen feel unlike every messenger people
//                   already use.
//
// Everything the chat can do is still reached by touching the thing it applies
// to — a message, a person, the room name — so the message row itself stays
// free of controls.

import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import { useBackClose } from "./lib/backclose";
import { ROOMS } from "./lib/chatprefs";
import type { ChatMessage, Person } from "./chatclient";

/** A tiny fixed set, because an emoji keyboard is a worse experience than six
 *  good choices. NIP-25 allows any content; these are the common ones. */
export const REACTIONS = ["+", "🔥", "😂", "👀", "🙏", "💜"] as const;

/** The reaction a double tap sends, the way Telegram's quick reaction works. */
export const QUICK_REACTION = "+";

/** How long a freshly opened sheet or menu ignores taps.
 *
 *  It opens under the finger that opened it. Without this, a second tap — or the
 *  release of a long press — landed on whatever row happened to be beneath it,
 *  and the rows include "Mute this person": people muted someone by tapping a
 *  message twice and never saw the menu that did it. */
const ARM_MS = 350;

function useArmed(): boolean {
  const [armed, setArmed] = useState(false);
  useEffect(() => {
    const id = setTimeout(() => setArmed(true), ARM_MS);
    return () => clearTimeout(id);
  }, []);
  return armed;
}

/* ------------------------------------------------------------------ icons
   Drawn inline. A menu row with only a word in it reads as a list; Telegram's
   reads as a menu because every command carries its own mark. No icon package
   is added for nine glyphs. */
const PATHS: Record<string, string> = {
  reply: "M9 7 4 12l5 5M4 12h8a6 6 0 0 1 6 6v1",
  copy: "M9 9h9v11H9zM6 15H4V4h11v2",
  profile: "M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8ZM4 21a8 8 0 0 1 16 0",
  send: "M4 12h13M12 5l7 7-7 7",
  dm: "M4 6h16v11H9l-5 4Z",
  mute: "M6 9a6 6 0 0 1 9-5M18 10v3l2 4H9M4 3l17 18",
  unmute: "M7 17V10a5 5 0 0 1 10 0v7M4 17h16M10 20h4",
  report: "M5 21V4h13l-3 4 3 4H5",
  retry: "M20 12a8 8 0 1 1-2.6-5.9M20 4v5h-5",
  close: "M6 6l12 12M18 6 6 18",
  check: "M4 12.5 9 17l11-11",
};

function Icon({ name }: { name: keyof typeof PATHS | string }) {
  return (
    <svg className="chat-ico" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <path d={PATHS[name] ?? ""} />
    </svg>
  );
}

/** Bottom sheet. Tapping the backdrop or pressing Android back dismisses it. */
export function Sheet({
  title,
  onClose,
  children,
  heading = true,
}: {
  title: string;
  onClose: () => void;
  children: ReactNode;
  /** A sheet whose content already names itself — a profile — skips the
   *  heading rather than printing the person's name twice. The dialog keeps it
   *  as its accessible name either way. */
  heading?: boolean;
}) {
  useBackClose(true, onClose);
  const armed = useArmed();
  return createPortal(
    // The guard is on the WRAPPER, so it covers the backdrop as well as the
    // rows. A sheet opened by a long press received the click from that press's
    // own release: on the backdrop it closed the sheet again the instant the
    // finger came up, and on a row it ran the row.
    <div
      className="modalwrap chat-sheet-wrap"
      onClickCapture={(e) => {
        if (armed) return;
        e.preventDefault();
        e.stopPropagation();
      }}
      onClick={onClose}
    >
      <div className="card modalcard chat-sheet" role="dialog" aria-modal="true" aria-label={title} onClick={(e) => e.stopPropagation()}>
        <div className="chat-sheet-grab" aria-hidden="true" />
        {heading && <h2>{title}</h2>}
        {children}
      </div>
    </div>,
    document.body,
  );
}

/** A row whose action cannot be undone by the same gesture that caused it.
 *
 *  Mute and Report change what this person sees and what the network is told,
 *  and both sit one tap deep in a menu that opens under the thumb. The first tap
 *  only ASKS; the label says exactly what the second one will do. */
function ConfirmRow({
  label,
  confirm,
  onConfirm,
  icon,
  menu,
}: {
  label: string;
  confirm: string;
  onConfirm: () => void;
  icon: string;
  menu?: boolean;
}) {
  const [asking, setAsking] = useState(false);
  useEffect(() => {
    if (!asking) return;
    // Not a trap: stop asking if it is ignored, so the row cannot sit armed.
    const id = setTimeout(() => setAsking(false), 4000);
    return () => clearTimeout(id);
  }, [asking]);
  const base = menu ? "chat-menu-row" : "chat-sheet-row";
  return (
    <button className={`${base} danger${asking ? " arming" : ""}`} onClick={() => (asking ? onConfirm() : setAsking(true))}>
      <Icon name={icon} />
      <span>{asking ? confirm : label}</span>
    </button>
  );
}

function Row({
  label,
  onClick,
  danger,
  detail,
  icon,
}: {
  label: string;
  onClick: () => void;
  danger?: boolean;
  detail?: string;
  icon?: string;
}) {
  return (
    <button className={danger ? "chat-sheet-row danger" : "chat-sheet-row"} onClick={onClick}>
      {icon && <Icon name={icon} />}
      <span>{label}</span>
      {detail && <span className="chat-sheet-detail">{detail}</span>}
    </button>
  );
}

function MenuRow({ label, onClick, icon, danger }: { label: string; onClick: () => void; icon: string; danger?: boolean }) {
  return (
    <button className={danger ? "chat-menu-row danger" : "chat-menu-row"} onClick={onClick}>
      <Icon name={icon} />
      <span>{label}</span>
    </button>
  );
}

/** "Send ZKAS", but only when there is somewhere to send it.
 *
 *  It used to be rendered disabled with a line of explanation under it whenever
 *  the person had published no address — a dead control plus a sentence about
 *  why it is dead, on the majority of people in the room. If there is nowhere to
 *  send, the command is simply not offered. */
function sendZkasRow(zkas: string | undefined, mine: boolean): boolean {
  return !mine && !!zkas;
}

/* ------------------------------------------------- the message menu (Telegram)

   Long-press or tap a message and Telegram does three things at once: it dims
   the conversation, it lifts THAT message out of the list, and it puts a row of
   reactions directly above it with the commands directly below. You never lose
   sight of which message you are acting on, and a reaction is one tap away in a
   bar, not a row inside a sheet.

   The stack is positioned so the lifted copy sits exactly where the real message
   was, then clamped into the viewport. */
export interface Anchor {
  top: number;
  bottom: number;
  left: number;
  right: number;
  mine: boolean;
}

export function MessageMenu({
  message,
  anchor,
  preview,
  onClose,
  onReply,
  onReact,
  onDm,
  onTip,
  onProfile,
  onMute,
  onReport,
  onCopy,
  onRetry,
}: {
  message: ChatMessage;
  anchor: Anchor;
  /** The message, rendered exactly as the list renders it. */
  preview: ReactNode;
  onClose: () => void;
  onReply: () => void;
  onReact: (emoji: string) => void;
  onDm: () => void;
  onTip: () => void;
  onProfile: () => void;
  onMute: () => void;
  onReport: () => void;
  onCopy: () => void;
  onRetry: () => void;
}) {
  const { t } = useTranslation();
  const p = message.person;
  useBackClose(true, onClose);
  const armed = useArmed();
  const stack = useRef<HTMLDivElement | null>(null);
  const lift = useRef<HTMLDivElement | null>(null);
  const [at, setAt] = useState<{ top: number; left?: number; right?: number } | null>(null);

  // Place the stack so the lifted copy lands exactly on the original, then clamp
  // it into the viewport. In a layout effect, so it is never painted in the
  // wrong place first.
  useLayoutEffect(() => {
    const el = stack.current;
    const li = lift.current;
    if (!el || !li) return;
    const vh = window.visualViewport?.height ?? window.innerHeight;
    const vw = window.innerWidth;
    const h = el.offsetHeight;
    const top = Math.max(10, Math.min(anchor.top - li.offsetTop, vh - h - 10));
    // Horizontally it hangs off the side the message is on, so the menu reads as
    // belonging to that message rather than to the screen.
    const EDGE = 8;
    const MIN = 236;
    setAt(
      anchor.mine
        ? { top, right: Math.max(EDGE, Math.min(vw - anchor.right, vw - MIN)) }
        : { top, left: Math.max(EDGE, Math.min(anchor.left, vw - MIN)) },
    );
  }, [anchor.top, anchor.left, anchor.right, anchor.mine]);

  const side = anchor.mine ? "mine" : "theirs";
  return createPortal(
    <div
      className="chat-menu-scrim"
      role="dialog"
      aria-modal="true"
      aria-label={p.name || t("chat.anon")}
      onClickCapture={(e) => {
        if (armed) return;
        e.preventDefault();
        e.stopPropagation();
      }}
      onClick={onClose}
      onContextMenu={(e) => {
        e.preventDefault();
        onClose();
      }}
    >
      <div
        ref={stack}
        className={`chat-menu-stack ${side}`}
        style={at ? { ...at, maxWidth: `calc(100% - ${(at.left ?? at.right ?? 0) + 8}px)` } : { top: -9999, visibility: "hidden" }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="chat-reactions" role="group" aria-label={t("chat.actions.react")}>
          {REACTIONS.map((r, i) => (
            <button
              key={r}
              className="chat-reaction-pick"
              style={{ animationDelay: `${i * 22}ms` }}
              onClick={() => onReact(r)}
              aria-label={r === "+" ? "👍" : r}
            >
              {r === "+" ? "👍" : r}
            </button>
          ))}
        </div>

        {/* The message itself, lifted. Not a quotation of it — the same markup,
            so what you are acting on is unmistakably what you touched. */}
        {/* Tapping the lifted message dismisses, as every messenger does: it is the
            thing directly under the finger that just opened this, so it is the most
            likely place to tap to get out. The stack swallows clicks so the card and
            the reaction bar keep working, which left this one spot inert. */}
        <div ref={lift} className="chat-menu-lift" aria-hidden="true" onClick={onClose}>
          {preview}
        </div>

        <div className="chat-menu-card">
          {message.failed && <MenuRow icon="retry" label={t("chat.actions.retry")} onClick={onRetry} />}
          <MenuRow icon="reply" label={t("chat.actions.reply")} onClick={onReply} />
          {sendZkasRow(p.zkas, message.mine) && <MenuRow icon="send" label={t("chat.actions.sendZkas")} onClick={onTip} />}
          {/* Writing privately is reached from the message itself, not only from
              "View profile". Deliberately the SAME key as the profile's row, so
              the two cannot read differently. */}
          {!message.mine && <MenuRow icon="dm" label={t("chat.dm.start")} onClick={onDm} />}
          <MenuRow icon="copy" label={t("chat.actions.copy")} onClick={onCopy} />
          <MenuRow icon="profile" label={t("chat.actions.profile")} onClick={onProfile} />
          {!message.mine && (
            <>
              {p.muted ? (
                <MenuRow icon="unmute" label={t("chat.actions.unmute")} onClick={onMute} />
              ) : (
                <ConfirmRow
                  menu
                  icon="mute"
                  label={t("chat.actions.mute")}
                  confirm={t("chat.actions.muteConfirm", { name: p.name || t("chat.anon") })}
                  onConfirm={onMute}
                />
              )}
              <ConfirmRow menu icon="report" label={t("chat.actions.report")} confirm={t("chat.actions.reportConfirm")} onConfirm={onReport} />
            </>
          )}
        </div>
      </div>
    </div>,
    document.body,
  );
}

export function ProfileSheet({
  person,
  onClose,
  onMute,
  onTip,
  onCopyKey,
  onDm,
}: {
  person: Person;
  onClose: () => void;
  onMute: () => void;
  onTip: () => void;
  onCopyKey: () => void;
  onDm: () => void;
}) {
  const { t } = useTranslation();
  return (
    <Sheet title={person.name || t("chat.anon")} onClose={onClose} heading={false}>
      <div className="chat-profile-head">
        <span className="chat-avatar big" style={{ background: `hsl(${person.hue} 58% 42%)` }}>
          {person.pubkey.slice(0, 2)}
        </span>
        <div className="chat-profile-id">
          <div className="chat-profile-name">
            <b>{person.name || t("chat.anon")}</b>
          </div>
          <span className="chat-fp">·{person.fingerprint}</span>
        </div>
      </div>
      {/* A rename is surfaced, never silently accepted — it is the cheapest
          impersonation there is, and the only defence is remembering. */}
      {person.firstName && person.name && person.firstName !== person.name && (
        <div className="msg warn small">{t("chat.profile.wasKnownAs", { name: person.firstName })}</div>
      )}
      {person.about && <p className="chat-profile-about">{person.about}</p>}
      {/* Where the money would actually go. A chat name is not an identity, so
          seeing the destination before tapping is the only check there is. */}
      {person.zkas && (
        <>
          <Row icon="send" label={t("chat.actions.sendZkas")} onClick={onTip} detail={t("chat.actions.tipDetail")} />
          <p className="muted small chat-sheet-note mono chat-sheet-addr">{person.zkas}</p>
        </>
      )}
      <Row icon="dm" label={t("chat.dm.start")} onClick={onDm} detail={t("chat.dm.openDetail")} />
      <Row icon="copy" label={t("chat.profile.copyKey")} onClick={onCopyKey} />
      {person.muted ? (
        <Row icon="unmute" label={t("chat.actions.unmute")} onClick={onMute} />
      ) : (
        <ConfirmRow
          icon="mute"
          label={t("chat.actions.mute")}
          confirm={t("chat.actions.muteConfirm", { name: person.name || t("chat.anon") })}
          onConfirm={onMute}
        />
      )}
      <p className="muted small" style={{ marginBottom: 0 }}>{t("chat.profile.muteNote")}</p>
    </Sheet>
  );
}

export function RoomsSheet({
  current,
  unread,
  mutedCount,
  onPick,
  onClose,
  onDms,
  onMuted,
  onProfile,
}: {
  current: string;
  unread: Record<string, number>;
  mutedCount: number;
  onPick: (room: string) => void;
  onClose: () => void;
  onDms: () => void;
  onMuted: () => void;
  onProfile: () => void;
}) {
  const { t } = useTranslation();
  // Grouped, because twenty flat rows is a list you scan rather than read.
  const groups: Array<{ key: string; rooms: typeof ROOMS }> = [
    { key: "chat.rooms.main", rooms: ROOMS.filter((r) => r.group === "main") },
    { key: "chat.rooms.languages", rooms: ROOMS.filter((r) => r.group === "lang") },
  ];
  return (
    <Sheet title={t("chat.rooms.title")} onClose={onClose}>
      <Row icon="dm" label={t("chat.dm.open")} onClick={onDms} detail={t("chat.dm.openDetail")} />
      {/* Editing your own name, bio and tip address was reachable ONLY in the
          prompt before your first message — after that there was no way back to
          it at all. */}
      <Row icon="profile" label={t("chat.profileTitle")} onClick={onProfile} />
      <Row icon="mute" label={t("chat.muted.title")} onClick={onMuted} detail={mutedCount ? String(mutedCount) : undefined} />
      {groups.map((g) => (
        <div key={g.key}>
          <div className="chat-sheet-group">{t(g.key)}</div>
          {g.rooms.map((r) => (
            <button
              key={r.id}
              className={r.id === current ? "chat-sheet-row current" : "chat-sheet-row"}
              onClick={() => onPick(r.id)}
            >
              <span className="chat-room-label">
                {r.flag ? `${r.flag} ` : ""}
                {r.label}
              </span>
              {unread[r.id] ? <span className="chat-sheet-detail">{unread[r.id]} {t("chat.new")}</span> : null}
              {r.id === current ? <Icon name="check" /> : null}
            </button>
          ))}
        </div>
      ))}
    </Sheet>
  );
}

/** Everyone this device has muted, and the way back.
 *
 *  Without this, muting was a ONE-WAY door: the only unmute lives on a muted
 *  person's message or profile, and muting hides their messages — so the way
 *  back disappeared at the moment it was needed. That is also why the mute
 *  itself now asks before it acts.
 *
 *  Names come from profiles seen earlier and are often missing, so the key
 *  fingerprint is always shown: it is the only thing that actually identifies
 *  someone here. */
export function MutedSheet({
  people,
  onClose,
  onUnmute,
}: {
  people: Person[];
  onClose: () => void;
  onUnmute: (pubkey: string) => void;
}) {
  const { t } = useTranslation();
  return (
    <Sheet title={t("chat.muted.title")} onClose={onClose}>
      {people.length === 0 && <p className="muted small">{t("chat.muted.none")}</p>}
      {people.map((p) => (
        <div key={p.pubkey} className="chat-muted-row">
          <span className="chat-avatar" style={{ background: `hsl(${p.hue} 58% 42%)` }}>
            {p.pubkey.slice(0, 2)}
          </span>
          <div className="chat-muted-who">
            <b>{p.name || p.firstName || t("chat.anon")}</b>
            <span className="chat-fp">·{p.fingerprint}</span>
          </div>
          <button className="btn ghost small" onClick={() => onUnmute(p.pubkey)}>
            {t("chat.actions.unmute")}
          </button>
        </div>
      ))}
      <p className="muted small" style={{ marginBottom: 0 }}>{t("chat.muted.note")}</p>
    </Sheet>
  );
}
