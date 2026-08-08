import { beforeEach, describe, expect, it } from "vitest";
import { getTxLabel, setTxLabel } from "../src/txlabels";

describe("private transaction labels", () => {
  beforeEach(() => localStorage.clear());

  it("saves, trims, and removes labels locally", () => {
    setTxLabel("AABB", "  supplier  ");
    expect(getTxLabel("aabb")).toBe("supplier");
    setTxLabel("aabb", "");
    expect(getTxLabel("AABB")).toBe("");
  });

  it("recovers from corrupt local storage", () => {
    localStorage.setItem("zkas_tx_labels_v1", "not-json");
    expect(getTxLabel("anything")).toBe("");
  });
});
