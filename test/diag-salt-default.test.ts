import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { getSaltForTests, pseudonym, redactText } from "../src/diag/redact";

/**
 * What the redactor does BEFORE the device's own salt arrives.
 *
 * `installDiagnostics()` installs every synchronous collector first and only then awaits
 * `connectSink()`, which is an IPC round trip on desktop and on Android. Everything recorded
 * in that window — the boot errors, the console mirror, the first taps and screens — is
 * redacted with whatever salt the module currently holds, and it is queued, so it reaches the
 * file and the export.
 *
 * With no salt at all every pseudonym is a bare SHA-256 of the value, which anyone holding
 * the export can CONFIRM against a candidate address or txid by hashing it. The file's own
 * header promises the opposite ("salted pseudonyms"), so the salt must never be empty.
 *
 * This file deliberately never calls setSalt: that is the whole point of it.
 */
describe("the salt is never empty", () => {
  it("is a random per-load salt until the platform installs the device's own", () => {
    expect(getSaltForTests()).toMatch(/^[0-9a-f]{32}$/);
  });

  it("a boot-time pseudonym cannot be confirmed by hashing a candidate", () => {
    const addr = "zkas:py82h42m9qjff0knpcmllzq3c7qhurje5auh4tq2ceagf69wjpf23djwwmqr26zhsua8rrglrwdltsh";
    const txid = "35dd94a1d8d20d8b19e1b70531f105736071876945f04b2028d5b97fdeff43ff";
    const unsalted = (kind: string, value: string) => createHash("sha256").update(`:${kind}:${value.toLowerCase()}`).digest("hex").slice(0, 8);
    expect(pseudonym("addr", addr)).not.toBe(unsalted("addr", addr));
    expect(redactText(`pay ${addr}`)).not.toContain(unsalted("addr", addr));
    expect(redactText(`tx ${txid} accepted`)).not.toContain(unsalted("hash", txid));
  });

  it("still correlates two lines about the same payment", () => {
    const txid = "35dd94a1d8d20d8b19e1b70531f105736071876945f04b2028d5b97fdeff43ff";
    const out = redactText(`tx ${txid} accepted; tx ${txid} mined`);
    const ids = out.match(/h:[0-9a-f]{8}/g) ?? [];
    expect(ids.length).toBe(2);
    expect(ids[0]).toBe(ids[1]);
  });
});
