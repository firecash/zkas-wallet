// The unread count behind the Chat button, and the DM read cursor.
//
// Three things were wrong here, and each produced a number a user could see was
// untrue: it counted ONE room (the one last open), so a message in your own
// language's room never appeared; it never counted private messages at all; and
// private messages, when the chat screen did count them, were measured against
// the read cursor of a public ROOM.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const RELAY = "wss://relay.example/chat";
const ME = "a".repeat(64);
const PEER = "b".repeat(64);
const MUTED = "c".repeat(64);

/** A scripted relay: every REQ gets the frames the test queued for it. */
class FakeSocket {
  static last: FakeSocket | null = null;
  static script: Record<string, unknown[]> = {};
  static opened: string[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((e: { data: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  closed = false;
  constructor(url: string) {
    FakeSocket.last = this;
    FakeSocket.opened.push(url);
    setTimeout(() => this.onopen?.(), 0);
  }
  send(raw: string) {
    const [, sub] = JSON.parse(raw) as [string, string];
    const events = FakeSocket.script[sub] ?? [];
    setTimeout(() => {
      for (const ev of events) this.onmessage?.({ data: JSON.stringify(["EVENT", sub, ev]) });
      this.onmessage?.({ data: JSON.stringify(["EOSE", sub]) });
    }, 0);
  }
  close() {
    this.closed = true;
  }
}

function note(id: string, pubkey: string, room: string, created_at: number) {
  return { id, pubkey, kind: 1, created_at, tags: [["t", room]], content: "hi", sig: "" };
}
function wrap(id: string) {
  return { id, pubkey: "d".repeat(64), kind: 1059, created_at: 1, tags: [["p", ME]], content: "", sig: "" };
}

beforeEach(() => {
  localStorage.clear();
  localStorage.setItem("zkas_chat_relay_v1", RELAY);
  FakeSocket.script = {};
  FakeSocket.opened = [];
  vi.stubGlobal("WebSocket", FakeSocket);
  vi.resetModules();
});

afterEach(() => {
  vi.unstubAllGlobals();
  localStorage.clear();
});

const CURSORS: Record<string, number> = { "zkas-global": 100, "zkas-fr": 200 };
const since = (room: string) => CURSORS[room] ?? 0;

describe("countUnread", () => {
  it("counts every followed room, each against its OWN cursor", async () => {
    FakeSocket.script.unread = [
      note("n1", PEER, "zkas-global", 150), // after the global cursor  → unread
      note("n2", PEER, "zkas-global", 90), //  before it                → read
      note("n3", PEER, "zkas-fr", 250), //     after the fr cursor      → unread
      note("n4", PEER, "zkas-fr", 150), //     before it (but after global's) → read
    ];
    const { countUnread } = await import("../src/chatclient");
    const n = await countUnread({ rooms: ["zkas-global", "zkas-fr"], since, mine: ME, seenWraps: [] });
    expect(n).toEqual({ rooms: 2, dms: 0 });
  });

  it("ignores our own messages and muted authors", async () => {
    localStorage.setItem("zkas_chat_muted_v1", JSON.stringify([MUTED]));
    FakeSocket.script.unread = [
      note("n1", ME, "zkas-global", 150),
      note("n2", MUTED, "zkas-global", 150),
      note("n3", PEER, "zkas-global", 150),
    ];
    const { countUnread } = await import("../src/chatclient");
    const n = await countUnread({ rooms: ["zkas-global"], since, mine: ME, seenWraps: [] });
    expect(n.rooms).toBe(1);
  });

  it("counts an event once even if the relay sends it twice", async () => {
    const dup = note("n1", PEER, "zkas-global", 150);
    FakeSocket.script.unread = [dup, dup];
    const { countUnread } = await import("../src/chatclient");
    const n = await countUnread({ rooms: ["zkas-global"], since, mine: ME, seenWraps: [] });
    expect(n.rooms).toBe(1);
  });

  it("counts private messages, and only the wraps not already seen", async () => {
    FakeSocket.script["unread-dm"] = [wrap("w1"), wrap("w2"), wrap("w3")];
    const { countUnread } = await import("../src/chatclient");
    const n = await countUnread({ rooms: ["zkas-global"], since, mine: ME, seenWraps: ["w1"] });
    expect(n).toEqual({ rooms: 0, dms: 2 });
  });

  it("asks for no private messages when this device has no chat key yet", async () => {
    const sent: string[] = [];
    FakeSocket.script.unread = [];
    const { countUnread } = await import("../src/chatclient");
    const orig = FakeSocket.prototype.send;
    FakeSocket.prototype.send = function (raw: string) {
      sent.push(JSON.parse(raw)[1] as string);
      return orig.call(this, raw);
    };
    const n = await countUnread({ rooms: ["zkas-global"], since, mine: "", seenWraps: [] });
    FakeSocket.prototype.send = orig;
    expect(sent).toEqual(["unread"]);
    expect(n).toEqual({ rooms: 0, dms: 0 });
  });

  it("opens nothing when there are no rooms to ask about", async () => {
    const { countUnread } = await import("../src/chatclient");
    await expect(countUnread({ rooms: [], since, mine: ME, seenWraps: [] })).resolves.toEqual({ rooms: 0, dms: 0 });
    expect(FakeSocket.opened).toEqual([]);
  });
});

describe("the private-message read cursor", () => {
  it("is kept by wrap id, and bounded", async () => {
    const { markDmWrapsSeen, seenDmWraps } = await import("../src/lib/chatprefs");
    markDmWrapsSeen(["w1", "w2"]);
    markDmWrapsSeen(["w2", "w3"]); // re-marking must not duplicate
    expect(seenDmWraps()).toEqual(["w1", "w2", "w3"]);

    markDmWrapsSeen(Array.from({ length: 500 }, (_, i) => `x${i}`));
    const after = seenDmWraps();
    expect(after).toHaveLength(400);
    // The newest are what matter: trimming can show an old thread as unread
    // once, but must never hide a new one.
    expect(after.at(-1)).toBe("x499");
    expect(after).not.toContain("w1");
  });

  it("starts empty and survives nothing being marked", async () => {
    const { markDmWrapsSeen, seenDmWraps } = await import("../src/lib/chatprefs");
    expect(seenDmWraps()).toEqual([]);
    markDmWrapsSeen([]);
    expect(seenDmWraps()).toEqual([]);
  });
});

describe("followedRooms", () => {
  it("is the global room, the locale's room, and the ones recently opened", async () => {
    const { followedRooms, rememberRoom, GLOBAL_ROOM } = await import("../src/lib/chatprefs");
    expect(followedRooms("fr")).toEqual([GLOBAL_ROOM, "zkas-fr"]);
    rememberRoom("zkas-de");
    expect(followedRooms("fr")).toEqual([GLOBAL_ROOM, "zkas-fr", "zkas-de"]);
    // The global room is always present and never costs a remembered slot.
    rememberRoom(GLOBAL_ROOM);
    expect(followedRooms("fr").filter((r) => r === GLOBAL_ROOM)).toHaveLength(1);
  });

  it("falls back to the global room alone for a language with no room", async () => {
    const { followedRooms, GLOBAL_ROOM } = await import("../src/lib/chatprefs");
    expect(followedRooms("xx")).toEqual([GLOBAL_ROOM]);
  });
});
