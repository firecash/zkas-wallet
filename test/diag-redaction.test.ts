import { readFileSync, readdirSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { error, event, flush, installSink, recent, resetForTests, setLevel } from "../src/diag/log";
import { bucketAmount, describeUrl, redactField, redactText, safeLabel, setKnownSecrets, setSalt, templatePath, violations } from "../src/diag/redact";
import { recordRequest, uninstallFetchWrapper } from "../src/diag/net";
import { ingestEngineText, resetSyncForTests } from "../src/diag/sync";
import { ingestNativeLine } from "../src/diag/native";
import { describeElement } from "../src/diag/instrument";
import { resetScreensForTests, screenChanged } from "../src/diag/screens";

/**
 * The diagnostic log is a document written to be handed to someone else, from a privacy
 * wallet. These tests push real-shaped secrets through EVERY way into the log and fail if any
 * of them — or anything shaped like one — reaches a stored line.
 */

const MNEMONIC = "abandon ability able about above absent absorb abstract absurd abuse access accident";
const MNEMONIC24 = `${MNEMONIC} account accuse achieve acid acoustic acquire across act action actor actress actual`;
const SEED_HEX = "9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08";
const FVK_HEX = "0a1b2c3d4e5f60718293a4b5c6d7e8f9".repeat(6);
const TOKEN_HEX = "a1b2c3d4e5f60718293a4b5c6d7e8f90";
const TOKEN_ALNUM = "Ab3dE5gH7jK9mN1pQ3sT5vW7yZ9aB1cD";
const ADDR = "zkas:py82h42m9qjff0knpcmllzq3c7qhurje5auh4tq2ceagf69wjpf23djwwmqr26zhsua8rrglrwdltsh";
const ADDR_TEST = "zkastest:qq82h42m9qjff0knpcmllzq3c7qhurje5auh4tq2ceagf69wjpf23djwwmqr26zhsua8rrglrwdltsh";
const ADDR_LEGACY = "firecash:py82h42m9qjff0knpcmllzq3c7qhurje5auh4tq2ceagf69wjpf23djwwmqr26zhsua8rrglrwdl";
const ADDR_KAS = "kaspa:qrap6w97jjpwrp59yj8fd3tfkz9jkxjd2spsjn4yxfpw60zzpdzsxnddcggqe";
const BARE_BODY = "py82h42m9qjff0knpcmllzq3c7qhurje5auh4tq2ceagf69wjpf23djwwmqr26zhsua8rrglrwdltsh";
const TXID = "35dd94a1d8d20d8b19e1b70531f105736071876945f04b2028d5b97fdeff43ff";
const MEMO = "rent for october flat 4b";
const PIN = "482916";
const PASSPHRASE = "correct horse battery staple";
const EMAIL = "someone@example.org";
const CUSTOM_IP = "203.0.113.77";
const LAN_IP = "192.168.1.23";
const CUSTOM_ONION = "abcdefghijklmnopqrstuvwxyz234567abcdefghijklmnopqrstuvwx.onion";

const SECRETS = [MNEMONIC, SEED_HEX, FVK_HEX, TOKEN_HEX, TOKEN_ALNUM, ADDR, ADDR_TEST, ADDR_LEGACY, ADDR_KAS, BARE_BODY, TXID, MEMO, PIN, PASSPHRASE, EMAIL, CUSTOM_IP, LAN_IP, CUSTOM_ONION];
// Every amount below; none may survive as a figure.
const AMOUNT_TEXT = ["1234.5678 ZKAS", "42 ZKAS", "123456789012 sompi", "0.5 KAS"];

function allLines(): string[] {
  return recent().map((e) => JSON.stringify(e));
}

function expectClean(lines: string[]) {
  expect(lines.length).toBeGreaterThan(0);
  for (const line of lines) {
    const v = violations(line, SECRETS);
    expect(v, `${v.join(",")} in ${line.slice(0, 400)}`).toEqual([]);
  }
}

describe("the checker is not vacuous", () => {
  it("flags every raw secret and amount", () => {
    for (const s of [MNEMONIC, SEED_HEX, FVK_HEX, TOKEN_HEX, TOKEN_ALNUM, ADDR, ADDR_KAS, TXID, EMAIL, ...AMOUNT_TEXT]) {
      expect(violations(`x ${s} y`), s).not.toEqual([]);
    }
    expect(violations(`x ${MEMO} y`, SECRETS)).not.toEqual([]);
  });
  it("passes the redactor's own output", () => {
    setSalt("00".repeat(16));
    for (const s of [...SECRETS, ...AMOUNT_TEXT]) {
      const out = redactText(`value ${s} end`);
      expect(violations(out), `${s} -> ${out}`).toEqual([]);
    }
  });
});

describe("redaction rules", () => {
  beforeEach(() => setSalt("11".repeat(16)));

  it("pseudonymises identifiers stably and per install", () => {
    const a = redactText(`pay ${ADDR}`);
    expect(a).toMatch(/^pay addr:[0-9a-f]{8}$/);
    expect(redactText(`pay ${ADDR}`)).toBe(a);
    setSalt("22".repeat(16));
    expect(redactText(`pay ${ADDR}`)).not.toBe(a);
  });

  it("keeps txids correlatable without revealing them", () => {
    const out = redactText(`tx ${TXID} accepted; tx ${TXID} mined`);
    const ids = out.match(/h:[0-9a-f]{8}/g) ?? [];
    expect(ids.length).toBe(2);
    expect(ids[0]).toBe(ids[1]);
  });

  it("buckets amounts, in text and in fields", () => {
    expect(bucketAmount(0)).toBe("0");
    expect(bucketAmount(0.0004)).toBe("<0.001");
    expect(bucketAmount(5)).toBe("1-10");
    expect(bucketAmount(1234.5)).toBe("1k-10k");
    expect(bucketAmount(5e6)).toBe(">=1M");
    expect(redactText("sent 1234.5678 ZKAS")).toBe("sent ~1k-10k ZKAS");
    expect(redactText("fee 3,000,000 sompi")).toBe("fee ~0.01-0.1 ZKAS");
    expect(redactField("amount_sompi", 123456789012)).toBe("1k-10k");
    expect(redactField("balance_fc", "42.5")).toBe("10-100");
    expect(redactField("spendable_zkas", 0)).toBe("0");
  });

  it("drops secret-named fields whatever their value", () => {
    for (const k of ["seed", "seedHex", "mnemonic", "phrase", "passphrase", "password", "pin", "app_pin", "secret", "fvk", "fvk_hex", "viewKey", "memo", "sigs", "signature", "alpha", "bundle_hex", "disclosure", "spend_auth", "sighash", "body", "authorization"]) {
      expect(redactField(k, "anything at all"), k).toBe("[redacted]");
    }
  });

  it("does not over-redact ordinary diagnostic fields", () => {
    // `priv` once matched `privacy_mode` and blanked the one field saying whether Tor was on.
    for (const [k, v] of [["privacy_mode", "onion"], ["route", "ipc-engine"], ["status", 200], ["screen", "wallet.send"], ["since_tap", 120]] as const) {
      expect(redactField(k, v), k).toBe(v);
    }
  });

  it("hashes identifier-named fields", () => {
    expect(redactField("address", ADDR)).toMatch(/^#[0-9a-f]{8}$/);
    expect(redactField("txid", TXID)).toMatch(/^#[0-9a-f]{8}$/);
    expect(redactField("token", TOKEN_HEX)).toMatch(/^#[0-9a-f]{8}$/);
  });

  it("removes phrase-shaped runs, tokens, keys, emails, custom hosts", () => {
    expect(redactText(`restore: ${MNEMONIC24} ok`)).toBe("restore: [phrase] ok");
    expect(redactText(`fvk ${FVK_HEX}`)).toMatch(/^fvk x:[0-9a-f]{8}$/);
    expect(redactText(`token ${TOKEN_ALNUM}`)).toMatch(/^token b:[0-9a-f]{8}$/);
    expect(redactText(`mail ${EMAIL}`)).toBe("mail [email]");
    expect(redactText(`node ${CUSTOM_IP}:16110`)).toMatch(/^node ip:[0-9a-f]{8}:16110$/);
    expect(redactText(`node ${LAN_IP}:16110`)).toMatch(/^node lan:[0-9a-f]{8}:16110$/);
    expect(redactText(`via ${CUSTOM_ONION}`)).toMatch(/^via onion:[0-9a-f]{8}$/);
  });

  it("keeps the project's own public hosts readable", () => {
    expect(redactText("connected to node at seed.zkas.info:16110")).toBe("connected to node at seed.zkas.info:16110");
    expect(redactText("connected to node at 185.147.157.125:16110")).toBe("connected to node at 185.147.157.125:16110");
  });

  it("is idempotent", () => {
    const once = redactText(`a ${ADDR} b ${TXID} c 12 ZKAS d ${TOKEN_ALNUM}`);
    expect(redactText(once)).toBe(once);
  });

  it("templates URLs and paths: no ids, no query values, no unknown hosts", () => {
    expect(templatePath(`/explore/tx/${TXID}`)).toBe("/explore/tx/:hash");
    expect(templatePath(`/explore/address/${encodeURIComponent(ADDR)}`)).toBe("/explore/address/:addr");
    expect(templatePath("/api/wallet/history?limit=50&before=123456")).toBe("/api/wallet/history?limit=*&before=*");
    const d = describeUrl(`https://my-own-node.example.net:8501/api/wallet/address?index=3&token=${TOKEN_HEX}`);
    expect(d.host).toBe("custom");
    expect(d.hostName).toBeUndefined();
    expect(JSON.stringify(d)).not.toContain(TOKEN_HEX);
    expect(JSON.stringify(d)).not.toContain("my-own-node");
    expect(describeUrl("https://wallet.zkas.info/daemon/api/status").hostName).toBe("wallet.zkas.info");
  });

  it("keeps UI labels only when they are plain words", () => {
    expect(safeLabel("Send")).toBe("Send");
    expect(safeLabel("Copy address")).toBe("Copy address");
    expect(safeLabel("Send 1.5 ZKAS")).toBeUndefined();
    expect(safeLabel(ADDR)).toBeUndefined();
    expect(safeLabel("Balance 42")).toBeUndefined();
  });
});

describe("every entry point into the log is redacted", () => {
  const sunk: string[] = [];
  beforeEach(() => {
    resetForTests();
    resetSyncForTests();
    resetScreensForTests();
    setSalt("33".repeat(16));
    setKnownSecrets([TOKEN_HEX, TOKEN_ALNUM]);
    sunk.length = 0;
    installSink({ append: async (lines) => { sunk.push(...lines); } });
    setLevel("verbose");
  });
  afterEach(() => {
    uninstallFetchWrapper();
    setKnownSecrets([]);
  });

  it("structured fields, nested objects, arrays, errors, free text, native lines, engine lines, clicks, URLs, screens", async () => {
    // 1. A careless call site passing everything it had.
    event("send", "careless", {
      seed: SEED_HEX, mnemonic: MNEMONIC, fvk_hex: FVK_HEX, memo: MEMO, pin: PIN, passphrase: PASSPHRASE,
      to: ADDR, address: ADDR_TEST, txid: TXID, token: TOKEN_HEX, amount_sompi: 123456789012, balance_fc: "1234.5678",
      note: MEMO, label: "Mum", contact: "Mum",
      nested: { inner: { to: ADDR_LEGACY, msg: `paid ${ADDR_KAS} 42 ZKAS with ${TOKEN_ALNUM}`, deeper: { x: SEED_HEX } } },
      list: [ADDR, TXID, `${MNEMONIC}`, { memo: MEMO }],
      text_with_everything: `${MNEMONIC} | ${SEED_HEX} | ${ADDR} | ${TXID} | 1234.5678 ZKAS | ${EMAIL} | ${CUSTOM_IP} | ${BARE_BODY} | ${CUSTOM_ONION}`,
    });
    // 2. An error whose message and stack carry secrets.
    const err = new Error(`could not pay ${ADDR}: token ${TOKEN_HEX} rejected, 42 ZKAS`);
    err.stack = `Error: could not pay ${ADDR}\n    at pay (tauri://localhost/assets/index.js:1:2)\n    at ${TXID}`;
    error("send", "error", err, { memo: MEMO });
    // 3. Engine log lines, both formats.
    ingestEngineText(
      [
        `1729600000 [INFO] zkas_walletd: wallet '${TOKEN_HEX}': rescan from DAA 1234 — birthday`,
        `1729600001 [WARN] zkas_walletd: send to ${ADDR} of 1234.5678 ZKAS tx ${TXID}`,
        `1729600002 [INFO] zkas_walletd: connected to node at ${CUSTOM_IP}:16110 (2 connections: request + sync)`,
      ].join("\n"),
      "android",
    );
    ingestEngineText(`1729600003000 [INFO zkas_walletd] wallet ${TOKEN_ALNUM}: re-registered; seed ${SEED_HEX}`, "desktop");
    // 4. A native line (Rust/Kotlin) forwarded to the tail.
    ingestNativeLine(JSON.stringify({ t: "x", m: 1, src: "rust", sid: "s", seq: 1, lvl: "error", cat: "err", ev: "panic", msg: `panicked at ${ADDR} ${TXID}`, txid: TXID }));
    // 5. Requests with identifiers in the URL.
    recordRequest({ kind: "fetch", method: "GET", url: `https://wallet.zkas.info/chain/transactions/${TXID}?addr=${encodeURIComponent(ADDR)}`, status: 200, ms: 12, outcome: "ok" });
    recordRequest({ kind: "api", method: "GET", path: `/api/wallet/address?index=1&token=${TOKEN_HEX}`, status: 500, ms: 9, outcome: "http", err: `boom ${ADDR}` });
    // 6. A click on a button whose text is an address and an amount.
    const b = document.createElement("button");
    b.textContent = `Send 1234.5678 ZKAS to ${ADDR}`;
    b.setAttribute("aria-label", `Pay ${ADDR}`);
    document.body.appendChild(b);
    event("ui", "tap", { ...(describeElement(b) ?? {}) });
    // 7. A screen name built carelessly from a route.
    screenChanged(`explore/tx/${TXID}`);
    await new Promise((r) => setTimeout(r, 1_600));

    const lines = allLines();
    expectClean(lines);
    await flush();
    expectClean(sunk);
    // The redaction kept the diagnostic value: the kinds of things are still there.
    const all = lines.join("\n");
    expect(all).toContain("addr:");
    expect(all).toContain("h:");
    expect(all).toContain("[redacted]");
    expect(all).toContain("rescan from DAA");
  });

  it("the console mirror and window errors", async () => {
    const { installDiagnostics } = await import("../src/diag/instrument");
    await installDiagnostics();
    setLevel("verbose");
    console.error(`walletd said ${TOKEN_HEX} for ${ADDR}`, new Error(`seed ${SEED_HEX}`));
    console.warn({ to: ADDR, amount: "42 ZKAS", phrase: MNEMONIC });
    window.dispatchEvent(new ErrorEvent("error", { error: new Error(`boom ${TXID} ${MNEMONIC}`), message: "boom" }));
    expectClean(allLines().filter((l) => l.includes('"cat":"err"')));
    expect(allLines().some((l) => l.includes('"ev":"console"'))).toBe(true);
  });
});

describe("the native ports are held to the same vectors", () => {
  it("vectors file matches the canonical JS redactor", () => {
    const v = JSON.parse(readFileSync("test/diag-redaction-vectors.json", "utf8")) as { salt: string; cases: { input: string; expect: string }[] };
    setSalt(v.salt);
    expect(v.cases.length).toBeGreaterThan(15);
    for (const c of v.cases) expect(redactText(c.input), c.input).toBe(c.expect);
  });
});

describe("user agents", () => {
  it("keeps browser and WebView versions, still pseudonymises real addresses", () => {
    setSalt("11".repeat(16));
    const ua = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.6723.92 Safari/537.36 Edg/130.0.2849.80";
    // Found in the Windows smoke run: app.env carried "Chrome/ip:b935fb6c … Edg/ip:b935fb6c".
    expect(redactText(ua)).toBe(ua);
    const out = redactText(`${ua} via 203.0.113.9 and 192.168.1.4`);
    expect(out).toContain("Chrome/130.0.6723.92");
    expect(out).toContain("Edg/130.0.2849.80");
    expect(out).not.toContain("203.0.113.9");
    expect(out).not.toContain("192.168.1.4");
    // Only a product token directly before the slash counts: a path or a URL does not.
    for (const s of ["proxy/203.0.113.9", "http://198.51.100.4:8080/x", "Chrome 203.0.113.10", "Chrome/ 203.0.113.11"]) {
      expect(redactText(s), s).not.toMatch(/\b(?:203\.0\.113|198\.51\.100)\.\d+/);
    }
    expect(redactField("ua", ua)).toBe(ua);
  });
});

describe("the log cannot phone home", () => {
  it("src/diag performs no network I/O of its own", () => {
    for (const f of readdirSync("src/diag")) {
      const src = readFileSync(`src/diag/${f}`, "utf8");
      expect(src, f).not.toMatch(/XMLHttpRequest|sendBeacon|new WebSocket|EventSource\(/);
      // The only `fetch` mention is the transparent wrapper in net.ts.
      if (f !== "net.ts") expect(src, f).not.toMatch(/\bfetch\(/);
    }
  });

  it("no lookbehind anywhere in src/diag (it does not parse on older WebKit)", () => {
    for (const f of readdirSync("src/diag")) expect(readFileSync(`src/diag/${f}`, "utf8"), f).not.toContain("(?<");
  });
});
