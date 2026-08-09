import { describe, expect, it } from "vitest";
import {
  BRIDGE_DASHBOARD_PORT,
  BRIDGE_HEALTH_PORT,
  MANAGED_KASPA_P2P_PORT,
  MANAGED_KASPA_RPC_PORT,
  MANAGED_ZKAS_P2P_PORT,
  MANAGED_ZKAS_RPC_PORT,
  STRATUM_PORT,
  WALLET_SERVICE_PORT,
} from "../src/ports";

describe("managed service port contract", () => {
  it("keeps wallet HTTP, node gRPC/P2P, and mining listeners separate", () => {
    expect(WALLET_SERVICE_PORT).toBe(8501);
    expect(STRATUM_PORT).toBe(5555);
    expect(BRIDGE_HEALTH_PORT).toBe(18080);
    expect(BRIDGE_DASHBOARD_PORT).toBe(18114);
    expect(MANAGED_ZKAS_RPC_PORT).toBe(16810);
    expect(MANAGED_ZKAS_P2P_PORT).toBe(16811);
    expect(MANAGED_KASPA_RPC_PORT).toBe(16110);
    expect(MANAGED_KASPA_P2P_PORT).toBe(16111);
    expect(new Set([
      WALLET_SERVICE_PORT,
      STRATUM_PORT,
      BRIDGE_HEALTH_PORT,
      BRIDGE_DASHBOARD_PORT,
      MANAGED_ZKAS_RPC_PORT,
      MANAGED_ZKAS_P2P_PORT,
      MANAGED_KASPA_RPC_PORT,
      MANAGED_KASPA_P2P_PORT,
    ]).size).toBe(8);
  });
});
