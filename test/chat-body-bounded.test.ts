import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * A chat message's `content` is the most attacker-controlled string in the app: anyone on a
 * public relay writes it, and `parseEvent` type-checks it without capping it — unlike the
 * profile fields beside it, `name` (32) and `about` (160).
 *
 * `Body` renders it by splitting on URLs and mapping every part to a node, so an uncapped
 * message means an array and a React tree proportional to its length. A multi-megabyte post
 * freezes every reader's client, which anyone can send.
 *
 * The cap belongs at the RENDER, not at the parser: a DM arrives as an encrypted gift wrap
 * whose `content` is ciphertext, and truncating that would destroy the message rather than
 * bound a draw.
 */
const chat = readFileSync("src/Chat.tsx", "utf8");

describe("one message cannot render without bound", () => {
  it("caps what Body draws", () => {
    expect(chat).toMatch(/const BODY_MAX = 4_000;/);
    const i = chat.indexOf("function Body(");
    const body = chat.slice(i, i + 420);
    expect(body).toContain("text.length > BODY_MAX");
    expect(body).toContain("text.slice(0, BODY_MAX)");
  });

  it("splits the CAPPED text, not the original", () => {
    // Splitting first would do the expensive work before the cap could help.
    const i = chat.indexOf("function Body(");
    const body = chat.slice(i, i + 420);
    expect(body.indexOf("const shown")).toBeLessThan(body.indexOf(".split("));
    expect(body).toMatch(/shown\.split\(/);
  });

  it("still only linkifies http(s), so a javascript: URL cannot reach href", () => {
    // The other half of rendering a stranger's text: React does not sanitise href.
    const i = chat.indexOf("function Body(");
    const body = chat.slice(i, i + 900);
    expect(body).toMatch(/\^https\?:\\\/\\\//);
    expect(body).toContain('rel="noopener noreferrer nofollow ugc"');
  });

  it("does not use safeText on message bodies", () => {
    // safeText collapses ALL whitespace — right for a display name, destructive for a
    // multi-line message. Keeping it out is deliberate.
    const i = chat.indexOf("function Body(");
    expect(chat.slice(i, i + 900)).not.toContain("safeText(");
  });
});
