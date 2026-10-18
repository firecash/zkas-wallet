import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { SubmitUnknownError } from "../src/noncustodial";
import en from "../src/i18n/en/app-send.json";

/**
 * `/api/wallet/submit` is the call that broadcasts. If it ANSWERS, the daemon decided, and
 * the daemon is explicit when it has not broadcast ("cannot reach the node to broadcast;
 * nothing was sent"). If it does not answer, the wallet knows nothing — and api.ts's own
 * note says a timeout means "something accepted the connection and is still working", which
 * for a broadcast is the dangerous case: the transaction may already be on the network.
 *
 * That case had no type of its own, so a 60-second submit timeout reached the user worded
 * exactly like a failure that never left the device. Being told a payment failed while it is
 * in flight is how somebody pays twice.
 */
describe("a submit with no answer is unknown, not failed", () => {
  it("has its own error type", () => {
    const e = new SubmitUnknownError("x");
    expect(e.name).toBe("SubmitUnknownError");
    expect(e).toBeInstanceOf(Error);
  });

  it("is raised for a timeout and for an unreachable daemon, and only there", () => {
    const src = readFileSync("src/noncustodial.ts", "utf8");
    const i = src.indexOf("res = await api.submit(");
    expect(i).toBeGreaterThan(0);
    const around = src.slice(i - 400, i + 500);
    expect(around).toContain("timedOut");
    expect(around).toContain("unreachable");
    expect(around).toContain("SubmitUnknownError");
    // A daemon that ANSWERED with an error is a real refusal and must pass through
    // unchanged, because the daemon knows whether it broadcast.
    expect(around).toContain("throw e;");
  });

  it("tells the user it cannot tell, and warns that retrying may pay twice", () => {
    const m = en.send.submitOutcomeUnknown;
    expect(m).toMatch(/cannot tell|cannot say|unable to tell/i);
    expect(m).toMatch(/history/i);
    expect(m).toMatch(/twice/i);
  });
});

describe("the unreadable-failure fallback does not claim funds stayed put", () => {
  it("no longer asserts that nothing was sent", () => {
    // It read "Nothing was sent — check History before trying again" while also saying the
    // wallet "could not read why" the payment was refused. Those cannot both be true: an
    // error the wallet cannot read is exactly one it cannot draw that conclusion from.
    const m = en.send.unknownFailure;
    expect(m).not.toMatch(/nothing was sent/i);
    expect(m).toMatch(/history/i);
  });

  it("still names the one thing the user can actually do", () => {
    expect(en.send.unknownFailure).toMatch(/before trying again/i);
  });
});
