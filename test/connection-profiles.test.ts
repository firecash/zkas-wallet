import { beforeEach, describe, expect, it } from "vitest";
import { miningNodeProfiles, walletNodeProfiles, walletdProfiles } from "../src/connection-profiles";

describe("connection profile separation", () => {
  beforeEach(() => localStorage.clear());

  it("removes the legacy Mining node row before the wallet chooser renders", () => {
    localStorage.setItem("zkas_node_profiles_v1", JSON.stringify([
      { id: "legacy-miner", name: "Mining node", address: "127.0.0.1:16810" },
      { id: "history", name: "Home history", address: "192.168.1.8:16110" },
    ]));

    expect(walletNodeProfiles.load()).toEqual([
      { id: "history", name: "Home history", address: "192.168.1.8:16110" },
    ]);
    expect(miningNodeProfiles.load()).toEqual([
      { id: "legacy-miner", name: "Mining node", address: "127.0.0.1:16810" },
    ]);
  });

  it("never guesses from the address and preserves user-named history nodes", () => {
    localStorage.setItem("zkas_node_profiles_v1", JSON.stringify([
      { id: "user-node", name: "My full-history node", address: "127.0.0.1:16810" },
    ]));

    expect(walletNodeProfiles.load()).toHaveLength(1);
    expect(miningNodeProfiles.load()).toEqual([]);
  });

  it("keeps a wallet service bearer with that endpoint only", () => {
    walletdProfiles.save("Home wallet", "http://192.168.1.8:8501", "secret-token");
    expect(walletdProfiles.load()).toEqual([
      expect.objectContaining({
        name: "Home wallet",
        address: "http://192.168.1.8:8501",
        bearer: "secret-token",
      }),
    ]);
    expect(walletNodeProfiles.load()).toEqual([]);
  });
});
