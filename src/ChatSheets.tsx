// The three sheets the chat reaches for. One primitive, three contents.
//
// Everything the chat can do is reached by tapping the thing it applies to: a
// message, a person, the room name. That is what keeps the message row free of
// controls — a visible Reply button on every line is N buttons of permanent
// clutter buying one action, where a tap target buys all of them.

import type { ReactNode } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import { useBackClose } from "./lib/backclose";
import { ROOMS } from "./lib/chatprefs";
import type { ChatMessage, Person } from "./chatclient";

/** Bottom sheet. Tapping the backdrop or pressing Android back dismisses it. */
export function Sheet({ title, onClose, children }: { title: string; onClose: () => void; children: ReactNode }) {
  useBackClose(true, onClose);
  return createPortal(
    <div className="modalwrap chat-sheet-wrap" onClick={onClose}>
      <div className="card modalcard chat-sheet" role="dialog" aria-modal="true" aria-label={title} onClick={(e) => e.stopPropagation()}>
        <h2>{title}</h2>
        {children}
      </div>
    </div>,
    document.body,
  );
}

function Row({
  label,
  onClick,
  danger,
  detail,
}: {
  label: string;
  onClick: () => void;
  danger?: boolean;
  detail?: string;
}) {
  return (
    <button className={danger ? "chat-sheet-row danger" : "chat-sheet-row"} onClick={onClick}>
      <span>{label}</span>
      {detail && <span className="chat-sheet-detail">{detail}</span>}
    </button>
  );
}

export function MessageSheet({
  message,
  onClose,
  onReply,
  onReact,
  onTip,
  onProfile,
  onMute,
  onReport,
  onCopy,
  onRetry,
}: {
  message: ChatMessage;
  onClose: () => void;
  onReply: () => void;
  onReact: () => void;
  onTip: () => void;
  onProfile: () => void;
  onMute: () => void;
  onReport: () => void;
  onCopy: () => void;
  onRetry: () => void;
}) {
  const { t } = useTranslation();
  const p = message.person;
  return (
    <Sheet title={p.name || t("chat.anon")} onClose={onClose}>
      <p className="muted small chat-sheet-quote">{message.content.slice(0, 160)}</p>
      {message.failed && <Row label={t("chat.actions.retry")} onClick={onRetry} />}
      <Row label={t("chat.actions.reply")} onClick={onReply} />
      <Row label={t("chat.actions.react")} onClick={onReact} />
      {/* Only offered when the author published an address: a chat key is
          secp256k1 and an address is Orchard, so one cannot be derived from the
          other, and a tip button that cannot pay would be a lie. */}
      {p.zkas && !message.mine && <Row label={t("chat.actions.tip")} onClick={onTip} detail={t("chat.actions.tipDetail")} />}
      <Row label={t("chat.actions.copy")} onClick={onCopy} />
      <Row label={t("chat.actions.profile")} onClick={onProfile} />
      {!message.mine && (
        <>
          <Row label={p.muted ? t("chat.actions.unmute") : t("chat.actions.mute")} onClick={onMute} danger />
          <Row label={t("chat.actions.report")} onClick={onReport} danger />
        </>
      )}
    </Sheet>
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
    <Sheet title={person.name || t("chat.anon")} onClose={onClose}>
      <div className="chat-profile-head">
        <span className="chat-avatar big" style={{ background: `hsl(${person.hue} 58% 42%)` }}>
          {person.pubkey.slice(0, 2)}
        </span>
        <div>
          <div className="chat-profile-name">
            <b>{person.name || t("chat.anon")}</b>
            <span className="chat-fp">·{person.fingerprint}</span>
          </div>
          {/* A rename is surfaced, never silently accepted — it is the cheapest
              impersonation there is, and the only defence is remembering. */}
          {person.firstName && person.name && person.firstName !== person.name && (
            <div className="msg warn small">{t("chat.profile.wasKnownAs", { name: person.firstName })}</div>
          )}
        </div>
      </div>
      <Row label={t("chat.dm.start")} onClick={onDm} detail={t("chat.dm.openDetail")} />
      <Row label={t("chat.profile.copyKey")} onClick={onCopyKey} />
      {person.zkas && <Row label={t("chat.actions.tip")} onClick={onTip} detail={t("chat.actions.tipDetail")} />}
      <Row label={person.muted ? t("chat.actions.unmute") : t("chat.actions.mute")} onClick={onMute} danger />
      <p className="muted small" style={{ marginBottom: 0 }}>{t("chat.profile.muteNote")}</p>
    </Sheet>
  );
}

export function RoomsSheet({
  current,
  unread,
  onPick,
  onClose,
  onDms,
}: {
  current: string;
  unread: Record<string, number>;
  onPick: (room: string) => void;
  onClose: () => void;
  onDms: () => void;
}) {
  const { t } = useTranslation();
  // Grouped, because twenty flat rows is a list you scan rather than read.
  const groups: Array<{ key: string; rooms: typeof ROOMS }> = [
    { key: "chat.rooms.main", rooms: ROOMS.filter((r) => r.group === "main") },
    { key: "chat.rooms.languages", rooms: ROOMS.filter((r) => r.group === "lang") },
  ];
  return (
    <Sheet title={t("chat.rooms.title")} onClose={onClose}>
      <button className="chat-sheet-row" onClick={onDms}>
        <span>{t("chat.dm.open")}</span>
        <span className="chat-sheet-detail">{t("chat.dm.openDetail")}</span>
      </button>
      {groups.map((g) => (
        <div key={g.key}>
          <div className="chat-sheet-group">{t(g.key)}</div>
          {g.rooms.map((r) => (
            <button
              key={r.id}
              className={r.id === current ? "chat-sheet-row current" : "chat-sheet-row"}
              onClick={() => onPick(r.id)}
            >
              <span>
                {r.flag ? `${r.flag} ` : ""}
                {r.label}
              </span>
              {unread[r.id] ? <span className="chat-sheet-detail">{unread[r.id]} {t("chat.new")}</span> : null}
            </button>
          ))}
        </div>
      ))}
    </Sheet>
  );
}

/** A tiny fixed set, because an emoji keyboard in a sheet is a worse experience
 *  than six good choices. NIP-25 allows any content; these are the common ones. */
export const REACTIONS = ["+", "🔥", "😂", "👀", "🙏", "💜"] as const;

export function ReactionSheet({ onPick, onClose }: { onPick: (emoji: string) => void; onClose: () => void }) {
  const { t } = useTranslation();
  return (
    <Sheet title={t("chat.actions.react")} onClose={onClose}>
      <div className="chat-reactions">
        {REACTIONS.map((r) => (
          <button key={r} className="chat-reaction-pick" onClick={() => onPick(r)} aria-label={r}>
            {r === "+" ? "👍" : r}
          </button>
        ))}
      </div>
    </Sheet>
  );
}
