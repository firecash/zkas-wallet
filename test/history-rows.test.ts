// The History tab has hidden a user's own send twice now. Both regressions were in
// the same place: deciding which device-recorded sends the chain has superseded.
// These pin the behaviour down so it cannot happen a third time.

import { describe, expect, it } from "vitest";
import { visibleDeviceRows } from "../src/App";
import type { LocalTx } from "../src/localtx";

const send = (txid: string): LocalTx => ({
  txid,
  to: "zkas:pyw7hwzs2r9a4agcxjeu8ucfq999rvx8dqsaalsz9egnata4c7qhrnyz5mlrqumcx5mezfc8khsvwdu",
  amountFc: 4400,
  feeFc: 0.0438,
  ts: Date.now(),
  preFc: 10000,
  spentFc: 4400.0438,
  pending: true,
});

describe("which device-recorded sends History still shows", () => {
  it("keeps a send the chain has not reported at all", () => {
    expect(visibleDeviceRows([send("aa")], [])).toHaveLength(1);
  });

  it("keeps a send the chain reports only as RECEIVED under the same txid", () => {
    // The reported bug. Our own payment sends change back to us; a wallet that has
    // not attributed the spend files that under the payment's txid as `received`.
    // Suppressing on txid alone dropped the "− 4400 sent" row in favour of a
    // "+ received" one — the send vanished the moment the chain answered.
    const rows = [{ txid: "aa", kind: "received" }];
    expect(visibleDeviceRows([send("aa")], rows)).toHaveLength(1);
  });

  it("steps aside once the chain reports it as a SEND", () => {
    const rows = [{ txid: "aa", kind: "sent" }];
    expect(visibleDeviceRows([send("aa")], rows)).toHaveLength(0);
  });

  it("keeps a send when the chain has a sent row for a DIFFERENT payment", () => {
    const rows = [{ txid: "bb", kind: "sent" }];
    expect(visibleDeviceRows([send("aa")], rows)).toHaveLength(1);
  });

  it("handles the mixed page a real wallet returns", () => {
    // A mined-heavy wallet: coinbase rows, one settled send, one still in flight.
    const rows = [
      { txid: "cb1", kind: "coinbase" },
      { txid: "cb2", kind: "coinbase" },
      { txid: "old", kind: "sent" },
      { txid: "new", kind: "received" },
    ];
    const kept = visibleDeviceRows([send("old"), send("new")], rows);
    expect(kept.map((t) => t.txid)).toEqual(["new"]);
  });
});
