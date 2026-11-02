import { describe, expect, it } from "vitest";
import { browserSources, CHAIN_FILES_CDN } from "../src/webengine";

describe("browser mode chain-file sources", () => {
  it("on wallet.zkas.info: the Cloudflare CDN first, the site's own copy as fallback", () => {
    const s = browserSources("https://wallet.zkas.info");
    expect(s.files).toEqual([CHAIN_FILES_CDN, "https://wallet.zkas.info/shielded-chain"]);
    expect(s.gateway).toBe("https://wallet.zkas.info/chain-gateway");
  });
  it("any other origin keeps zkas.info only (its CSP does not allow the CDN)", () => {
    const s = browserSources("https://localhost:8443");
    expect(s.files).toEqual(["https://zkas.info/shielded-chain"]);
    expect(s.files).not.toContain(CHAIN_FILES_CDN);
  });
});
