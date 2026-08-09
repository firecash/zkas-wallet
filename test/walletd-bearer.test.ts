import { beforeEach, describe, expect, it, vi } from "vitest";
import { api, setBase, setWalletdBearer } from "../src/api";

describe("wallet service authentication", () => {
  beforeEach(() => {
    localStorage.clear();
    localStorage.setItem("wallet_token", "device-wallet-token");
    setBase("http://192.168.1.20:8501");
  });

  it("sends the saved bearer without replacing the wallet identity token", async () => {
    setWalletdBearer("host-access-token");
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({ has_wallet: false }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    }));

    await api.status();

    const request = fetchMock.mock.calls[0][1] as RequestInit;
    expect(request.headers).toMatchObject({
      Authorization: "Bearer host-access-token",
      "X-Wallet-Token": "device-wallet-token",
    });
    fetchMock.mockRestore();
  });
});
