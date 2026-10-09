import { describe, it, expect, beforeEach } from "vitest";
import { embeddedNode, PUBLIC_EMBEDDED_NODES, DEFAULT_EMBEDDED_NODE } from "../src/embedded";

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
