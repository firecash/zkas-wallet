import { describe, it, expect, beforeEach } from "vitest";
import { embeddedNode, embeddedPrimaryNode, embeddedBackupNode, setEmbeddedNode, setEmbeddedBackupNode, normalizeNodeAddr, repairStoredNodeAddrs, PUBLIC_EMBEDDED_NODES, DEFAULT_EMBEDDED_NODE } from "../src/embedded";

const NODE_KEY = "wallet_embedded_node";
const BACKUP_KEY = "wallet_embedded_node_backup";

// The default moved from a hardcoded IP to seed.zkas.info, which is the address
// that can be repointed without shipping an app release. The seeding runs once
// per install, so the migration has to reach wallets that are already out there
// — without ever overwriting a node somebody typed themselves.
describe("the embedded node default", () => {
  beforeEach(() => localStorage.clear());

  it("is the DNS name, not an IP", () => {
    expect(DEFAULT_EMBEDDED_NODE).toBe("seed.zkas.info:16110");
    expect(PUBLIC_EMBEDDED_NODES[0]).toBe("seed.zkas.info:16110");
  });

  it("gives a fresh install the DNS name", () => {
    expect(embeddedNode()).toBe("seed.zkas.info:16110");
  });

  it("migrates an install pinned to an old hardcoded default", () => {
    localStorage.setItem(NODE_KEY, "185.147.157.125:16110");
    expect(embeddedNode()).toBe("seed.zkas.info:16110");
  });

  it("NEVER overwrites a node the user chose", () => {
    localStorage.setItem(NODE_KEY, "my-own-node.example:16110");
    expect(embeddedNode()).toBe("my-own-node.example:16110");
  });

  it("still sets a backup that differs from the primary", () => {
    embeddedNode();
    const backup = localStorage.getItem(BACKUP_KEY);
    expect(backup).toBeTruthy();
    expect(backup).not.toBe(localStorage.getItem(NODE_KEY));
  });
});

// A node address without a port made the engine dial port 80 (the web server), which
// fails every call with an HTTP/2 FRAME_SIZE_ERROR shown as "cannot reach the ZKas node".
describe("node addresses always carry the gRPC port", () => {
  beforeEach(() => localStorage.clear());

  it("adds the port to a bare host, IPv4 and IPv6", () => {
    expect(normalizeNodeAddr("seed.zkas.info")).toBe("seed.zkas.info:16110");
    expect(normalizeNodeAddr(" 160.187.211.153 ")).toBe("160.187.211.153:16110");
    expect(normalizeNodeAddr("2001:db8::1")).toBe("[2001:db8::1]:16110");
    expect(normalizeNodeAddr("[2001:db8::1]")).toBe("[2001:db8::1]:16110");
  });

  it("keeps an explicit port exactly", () => {
    expect(normalizeNodeAddr("my-node.example:17110")).toBe("my-node.example:17110");
    expect(normalizeNodeAddr("[2001:db8::1]:17110")).toBe("[2001:db8::1]:17110");
  });

  it("drops a pasted scheme and trailing slash", () => {
    expect(normalizeNodeAddr("grpc://seed.zkas.info/")).toBe("seed.zkas.info:16110");
    expect(normalizeNodeAddr("https://seed.zkas.info")).toBe("seed.zkas.info:16110");
  });

  it("repairs an install that already saved the host without a port", () => {
    localStorage.setItem("wallet_embedded_nodes_seeded_v3", "1");
    localStorage.setItem(NODE_KEY, "seed.zkas.info");
    expect(embeddedNode()).toBe("seed.zkas.info:16110");
    expect(embeddedPrimaryNode()).toBe("seed.zkas.info:16110");
  });

  it("stores what the user types with the port", () => {
    setEmbeddedNode("seed.zkas.info");
    setEmbeddedBackupNode("160.187.211.153");
    expect(localStorage.getItem(NODE_KEY)).toBe("seed.zkas.info:16110");
    expect(embeddedBackupNode()).toBe("160.187.211.153:16110");
  });
});

// An engine started with a portless address keeps running across app restarts, so the stored
// value must be rewritten ONCE and reported, letting ensureEmbedded restart the engine.
describe("repairStoredNodeAddrs", () => {
  beforeEach(() => localStorage.clear());

  it("rewrites portless primary and backup once and reports it", () => {
    localStorage.setItem(NODE_KEY, "seed.zkas.info");
    localStorage.setItem(BACKUP_KEY, "160.187.211.153");
    expect(repairStoredNodeAddrs()).toBe(true);
    expect(localStorage.getItem(NODE_KEY)).toBe("seed.zkas.info:16110");
    expect(localStorage.getItem(BACKUP_KEY)).toBe("160.187.211.153:16110");
    expect(repairStoredNodeAddrs()).toBe(false);
  });

  it("leaves correct and empty values alone", () => {
    localStorage.setItem(NODE_KEY, "my-node.example:17110");
    expect(repairStoredNodeAddrs()).toBe(false);
    expect(localStorage.getItem(NODE_KEY)).toBe("my-node.example:17110");
    expect(localStorage.getItem(BACKUP_KEY)).toBeNull();
  });
});

describe("a node address the app shows is the one the engine dials", () => {
  // The engine parses the port as a u16 and silently falls back to 16110 when it does
  // not fit. The app used to accept any digits, so `host:99999` was DISPLAYED as typed
  // while the engine connected to `host:16110` — the wallet naming one node and talking
  // to another. These cases are the ones where the two used to disagree.
  it("falls back to the default port when the port cannot be dialled", () => {
    expect(normalizeNodeAddr("host:99999")).toBe("host:16110");
    expect(normalizeNodeAddr("host:65536")).toBe("host:16110");
    expect(normalizeNodeAddr("host:0")).toBe("host:16110");
    expect(normalizeNodeAddr("[2001:db8::1]:99999")).toBe("[2001:db8::1]:16110");
  });

  it("keeps a port that can be dialled", () => {
    expect(normalizeNodeAddr("host:65535")).toBe("host:65535");
    expect(normalizeNodeAddr("host:1")).toBe("host:1");
    expect(normalizeNodeAddr("127.0.0.1:17110")).toBe("127.0.0.1:17110");
    expect(normalizeNodeAddr("[2001:db8::1]:17110")).toBe("[2001:db8::1]:17110");
  });

  it("drops a path pasted from a browser instead of making it part of the host", () => {
    // "host/rpc:16110" is not a host; it never resolves and the failure reads as
    // "cannot reach the ZKas node", which is the symptom this whole change exists for.
    expect(normalizeNodeAddr("grpc://host/path")).toBe("host:16110");
    expect(normalizeNodeAddr("https://seed.zkas.info/rpc/")).toBe("seed.zkas.info:16110");
    expect(normalizeNodeAddr("http://1.2.3.4:17110/x")).toBe("1.2.3.4:17110");
  });
  it("is idempotent, so repairing a stored address cannot loop", () => {
    // repairStoredNodeAddrs() restarts the engine whenever it CHANGES a stored address.
    // If normalizing an already-normalized address changed it again, every launch would
    // repair, restart, repair — for ever. This is the guard on that.
    for (const a of [
      "seed.zkas.info", "seed.zkas.info:16110", "host:99999", "host:65536", "host:0",
      "host:abc", "grpc://host/path", "https://seed.zkas.info/rpc/", "2001:db8::1",
      "[2001:db8::1]", "[2001:db8::1]:99999", "[2001:db8::1]:17110", "127.0.0.1:17110",
      " spaced.host ", "1.2.3.4:", "host.onion", "grpc://[2001:db8::1]:16110/",
    ]) {
      const once = normalizeNodeAddr(a);
      expect(normalizeNodeAddr(once), `normalizing ${a} twice`).toBe(once);
    }
  });
});
