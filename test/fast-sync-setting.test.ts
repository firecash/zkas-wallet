import { describe, it, expect, beforeEach } from "vitest";
import { embeddedFastSync, setEmbeddedFastSync, isPublicZkasNode, PUBLIC_EMBEDDED_NODES, DEFAULT_EMBEDDED_NODE, embeddedChainFilesUrl, setEmbeddedChainFilesUrl, normalizeChainFilesUrl, validChainFilesUrl, DEFAULT_CHAIN_FILES_URL } from "../src/embedded";

// "Fast sync" (Run on this phone): the engine reads catch-up from ZKas's published chain
// files. It is on unless the user switches it off, and it only ever applies against ZKas's
// own public nodes — the display rule here mirrors `chain_files::default_for_node` in
// zkas-walletd, which makes the real decision.
describe("fast sync setting", () => {
  beforeEach(() => localStorage.clear());

  it("is on for a new install and stays as the user sets it", () => {
    expect(embeddedFastSync()).toBe(true);
    setEmbeddedFastSync(false);
    expect(embeddedFastSync()).toBe(false);
    setEmbeddedFastSync(true);
    expect(embeddedFastSync()).toBe(true);
  });

  it("applies to every node the app ships as a default", () => {
    for (const n of [DEFAULT_EMBEDDED_NODE, ...PUBLIC_EMBEDDED_NODES]) expect(isPublicZkasNode(n)).toBe(true);
  });

  it("never applies to a node the user runs, or a look-alike name", () => {
    for (const n of ["127.0.0.1:16110", "192.168.1.5:16110", "my-node.example:16110", "evilzkas.info:16110", "zkas.info.evil.com:16110", "[::1]:16110", ""]) {
      expect(isPublicZkasNode(n), n).toBe(false);
    }
  });

  it("matches the engine's list of public hosts", () => {
    for (const n of ["seed.zkas.info:16110", "SEED.ZKAS.INFO:16110", "185.147.157.125:16110", "160.187.211.153:16110", "zkas.info"]) {
      expect(isPublicZkasNode(n), n).toBe(true);
    }
  });
});

describe("fast sync address", () => {
  beforeEach(() => localStorage.clear());

  it("defaults to the public files and stores the default as nothing", () => {
    expect(embeddedChainFilesUrl()).toBe("");
    setEmbeddedChainFilesUrl(DEFAULT_CHAIN_FILES_URL + "/");
    expect(embeddedChainFilesUrl()).toBe("");
    expect(normalizeChainFilesUrl("  " + DEFAULT_CHAIN_FILES_URL + "  ")).toBe("");
  });

  it("keeps an address the user typed, trimmed", () => {
    setEmbeddedChainFilesUrl(" https://mirror.example/chain/ ");
    expect(embeddedChainFilesUrl()).toBe("https://mirror.example/chain");
    setEmbeddedChainFilesUrl("");
    expect(embeddedChainFilesUrl()).toBe("");
  });

  it("accepts only http(s) addresses", () => {
    for (const ok of ["", DEFAULT_CHAIN_FILES_URL, "https://mirror.example/chain", "http://10.0.0.5:8080/files"]) expect(validChainFilesUrl(ok), ok).toBe(true);
    for (const bad of ["mirror.example", "ftp://x/y", "https://", "https:// space", "https://a b", "javascript:alert(1)"]) expect(validChainFilesUrl(bad), bad).toBe(false);
  });
});

