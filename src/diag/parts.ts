// Which parts of the logs are kept: Settings → Debug logs → "Log parts".
//
// A support log is only useful if the line that matters is in it, and on a phone the app's
// own taps and request summaries can push the engine's sync lines out of a ring. So every
// line belongs to one PART, and a part can be switched off. Errors and warnings are kept
// whatever is switched off — a filter that could hide the failure being reported would make
// the log worse than no filter.
//
// The choice is a per-device convenience, so it lives in localStorage; when storage is
// unavailable everything is kept.

export type LogPart =
  | "ui" // taps, navigation, screens
  | "net" // the app's own requests
  | "app" // app lifecycle, performance, the diagnostics module itself
  | "sync" // scan progress and timings
  | "files" // chain files and the frontier almanac
  | "send" // proving, sending, notes
  | "node" // node connection, RPC, Tor
  | "libs"; // third-party libraries inside the engine (hyper, h2, tonic, rustls…)

export const LOG_PARTS: readonly LogPart[] = ["sync", "files", "send", "node", "ui", "net", "app", "libs"];

const KEY = "zkas.logs.partsOff";
let off: Set<LogPart> | null = null;

function load(): Set<LogPart> {
  if (off) return off;
  off = new Set();
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) for (const p of JSON.parse(raw) as string[]) if ((LOG_PARTS as readonly string[]).includes(p)) off.add(p as LogPart);
  } catch {
    /* no storage: keep everything */
  }
  return off;
}

export function partEnabled(p: LogPart): boolean {
  return !load().has(p);
}

export function setPartEnabled(p: LogPart, on: boolean): void {
  const s = load();
  if (on) s.delete(p);
  else s.add(p);
  try {
    localStorage.setItem(KEY, JSON.stringify([...s]));
  } catch {
    /* kept for this session only */
  }
}

/// For tests.
export function resetPartsForTests(): void {
  off = null;
}

/// The part an app diagnostics category belongs to.
export function partOfCategory(cat: string): LogPart | null {
  switch (cat) {
    case "ui":
    case "nav":
      return "ui";
    case "net":
      return "net";
    case "app":
    case "perf":
    case "diag":
      return "app";
    case "sync":
      return "sync";
    case "send":
    case "signer":
      return "send";
    default:
      return null; // errors, engine meta-events and anything new: always kept
  }
}

const FILES_RE = /chain files|chain_files|frontier almanac|almanac/i;
const SEND_RE = /\b(prepare|send|submit|broadcast|prove|proof|proving|witness|spend|consolidat|note selection|fee)\b/i;
const NODE_RE = /\b(node|grpc|rpc|tor|socks|connect|reconnect|tip)\b/i;

/// The part an ENGINE log line belongs to, from its target (the Rust module path, or its
/// last segment) and message. walletd's own lines are split by what they are about;
/// anything from another crate is "libs".
export function partOfEngineLine(target: string | undefined, msg: string): LogPart {
  const t = target ?? "";
  if (t && !/zkas|walletd|wallet_engine|firecash/i.test(t) && t !== "chain_files" && t !== "almanac" && t !== "lib") return "libs";
  if (t.endsWith("chain_files") || t.endsWith("almanac") || FILES_RE.test(msg)) return "files";
  if (SEND_RE.test(msg)) return "send";
  if (NODE_RE.test(msg) && !/\bscan|page pipeline|scan cost|fast-sync|birthday/i.test(msg)) return "node";
  return "sync";
}

const KEEP_RE = /\[(ERROR|WARN)/;

/// Filter a whole engine log text (`secs [LEVEL] target: msg` or `… [LEVEL target] msg`)
/// to the enabled parts. Lines that do not parse (the exit-history header, continuation
/// lines) are kept.
export function filterEngineText(text: string): string {
  const s = load();
  if (s.size === 0 || !text) return text;
  const out: string[] = [];
  for (const raw of text.split("\n")) {
    if (KEEP_RE.test(raw)) {
      out.push(raw);
      continue;
    }
    let m = /^\d+ \[\w+\] (\S+?): (.*)$/.exec(raw);
    let target: string | undefined;
    let msg: string;
    if (m) {
      target = m[1];
      msg = m[2];
    } else {
      m = /^(?:[\d:]+ )?(?:\d+ )?\[\w+(?: ([^\]]+))?\] (.*)$/.exec(raw);
      if (!m) {
        out.push(raw);
        continue;
      }
      target = m[1];
      msg = m[2];
    }
    if (!s.has(partOfEngineLine(target, msg))) out.push(raw);
  }
  return out.join("\n");
}
