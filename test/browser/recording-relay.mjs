// A minimal Nostr relay that RECORDS every filter it is asked for, so the test
// can prove the second connect asks for a delta rather than the whole window.
import { WebSocketServer } from "ws";
import { writeFileSync } from "node:fs";
const PORT = Number(process.argv[2] || 7471);
const LOG = process.argv[3] || "/tmp/relay-filters.json";
const notes = [];
const now = Math.floor(Date.now() / 1000);
for (let i = 0; i < 40; i++) {
  notes.push({
    id: "n" + String(i).padStart(3, "0") + "0".repeat(53),
    pubkey: "a".repeat(64), created_at: now - (40 - i) * 60, kind: 1,
    tags: [["t", "zkas-global"]], content: "message " + i, sig: "0".repeat(128),
  });
}
const filters = [];
new WebSocketServer({ port: PORT, host: "127.0.0.1" }).on("connection", (ws) => {
  ws.on("message", (raw) => {
    let f; try { f = JSON.parse(String(raw)); } catch { return; }
    if (f[0] === "REQ") {
      const [, id, filter] = f;
      filters.push({ id, filter, at: Date.now() });
      writeFileSync(LOG, JSON.stringify(filters, null, 1));
      if (filter.kinds?.includes(1)) {
        for (const n of notes) {
          if (filter.since && n.created_at < filter.since) continue;
          if (filter.until && n.created_at > filter.until) continue;
          ws.send(JSON.stringify(["EVENT", id, n]));
        }
      }
      ws.send(JSON.stringify(["EOSE", id]));
    }
    if (f[0] === "EVENT") ws.send(JSON.stringify(["OK", f[1].id, true, ""]));
  });
});
console.log("relay on " + PORT);
