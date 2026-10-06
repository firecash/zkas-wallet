// The three sheets the chat reaches for. One primitive, three contents.
//
// Everything the chat can do is reached by tapping the thing it applies to: a
// message, a person, the room name. That is what keeps the message row free of
// controls — a visible Reply button on every line is N buttons of permanent
// clutter buying one action, where a tap target buys all of them.

import { useEffect, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import { useBackClose } from "./lib/backclose";
import { ROOMS } from "./lib/chatprefs";
import type { ChatMessage, Person } from "./chatclient";

/** A tiny fixed set, because an emoji keyboard is a worse experience than six
 *  good choices. NIP-25 allows any content; these are the common ones. */
export const REACTIONS = ["+", "🔥", "😂", "👀", "🙏", "💜"] as const;

/** How long a freshly opened sheet ignores taps.
 *
 *  The sheet opens under the finger that opened it. Without this, a second tap
 *  — or the release of a long press — landed on whatever row happened to be
 *  beneath it, and the rows include "Mute this person": people muted someone by
 *  tapping a message twice and never saw the menu that did it. */
const ARM_MS = 350;

/** Bottom sheet. Tapping the backdrop or pressing Android back dismisses it. */
export function Sheet({ title, onClose, children }: { title: string; onClose: () => void; children: ReactNode }) {
  useBackClose(true, onClose);
  const [armed, setArmed] = useState(false);
  useEffect(() => {
    const id = setTimeout(() => setArmed(true), ARM_MS);
    return () => clearTimeout(id);
  }, []);
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
        <h2>{title}</h2>
        {children}
      </div>
    </div>,
    document.body,
  );
}

/** A row whose action cannot be undone by the same gesture that caused it.
 *
 *  Mute and Report change what this person sees and what the network is told,
 *  and both sat one tap deep in a sheet that opens under the thumb. The first
 *  tap now only ASKS; the label says exactly what the second one will do. */
function ConfirmRow({ label, confirm, onConfirm }: { label: string; confirm: string; onConfirm: () => void }) {
  const [asking, setAsking] = useState(false);
  useEffect(() => {
    if (!asking) return;
    // Not a trap: stop asking if it is ignored, so the row cannot sit armed.
    const id = setTimeout(() => setAsking(false), 4000);
    return () => clearTimeout(id);
  }, [asking]);
  return (
    <button
      className={asking ? "chat-sheet-row danger arming" : "chat-sheet-row danger"}
      onClick={() => (asking ? onConfirm() : setAsking(true))}
    >
      <span>{asking ? confirm : label}</span>
    </button>
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
  onDm,
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
  return (
    <Sheet title={p.name || t("chat.anon")} onClose={onClose}>
      <p className="muted small chat-sheet-quote">{message.content.slice(0, 160)}</p>
      {/* Reactions first, as a row of emoji rather than a row that opens
          another sheet. Holding a message is how a reaction is chosen in every
          messenger people already use, and it cost two sheets here. Double-tap
          still sends 👍 without opening anything. */}
      <div className="chat-reactions">
        {REACTIONS.map((r) => (
          <button key={r} className="chat-reaction-pick" onClick={() => onReact(r)} aria-label={r}>
            {r === "+" ? "👍" : r}
          </button>
        ))}
      </div>
      {message.failed && <Row label={t("chat.actions.retry")} onClick={onRetry} />}
      <Row label={t("chat.actions.reply")} onClick={onReply} />
      {/* Writing to this person privately is reached from the message itself,
          not only from "View profile" — reaching it through the profile was two
          taps and a screen that exists to show a key. Deliberately the SAME key
          and detail as the profile's row, so the two cannot read differently:
          one action, one name, wherever it is offered. */}
      {!message.mine && <Row label={t("chat.dm.start")} onClick={onDm} detail={t("chat.dm.openDetail")} />}
      {/* Only offered when the author published an address: a chat key is
          secp256k1 and an address is Orchard, so one cannot be derived from the
          other, and a tip button that cannot pay would be a lie. */}
      {p.zkas && !message.mine && <Row label={t("chat.actions.tip")} onClick={onTip} detail={t("chat.actions.tipDetail")} />}
      <Row label={t("chat.actions.copy")} onClick={onCopy} />
      <Row label={t("chat.actions.profile")} onClick={onProfile} />
      {!message.mine && (
        <>
          {p.muted ? (
            <Row label={t("chat.actions.unmute")} onClick={onMute} />
          ) : (
            <ConfirmRow
              label={t("chat.actions.mute")}
              confirm={t("chat.actions.muteConfirm", { name: p.name || t("chat.anon") })}
              onConfirm={onMute}
            />
          )}
          <ConfirmRow label={t("chat.actions.report")} confirm={t("chat.actions.reportConfirm")} onConfirm={onReport} />
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
      {person.muted ? (
        <Row label={t("chat.actions.unmute")} onClick={onMute} />
      ) : (
        <ConfirmRow
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
}: {
  current: string;
  unread: Record<string, number>;
  mutedCount: number;
  onPick: (room: string) => void;
  onClose: () => void;
  onDms: () => void;
  onMuted: () => void;
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
      <button className="chat-sheet-row" onClick={onMuted}>
        <span>{t("chat.muted.title")}</span>
        <span className="chat-sheet-detail">{mutedCount || ""}</span>
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

