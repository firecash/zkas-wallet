// puppeteer is not a dependency of this project — it lives in the session's
// scratch node_modules. Resolved by path so the test runs from the repo.
const { default: puppeteer } = await import(
  process.env.PUPPETEER_PATH || "/tmp/node_modules/puppeteer/lib/esm/puppeteer/puppeteer.js"
);
import { readFileSync, writeFileSync } from "node:fs";
const LOG = "/tmp/relay-filters.json";
const b = await puppeteer.launch({ executablePath:"/root/.cache/puppeteer/chrome/linux-148.0.7778.97/chrome-linux64/chrome", args:["--no-sandbox","--disable-dev-shm-usage"] });
const seed = () => {
  localStorage.setItem("walletd_base","http://127.0.0.1:8599");
  localStorage.setItem("wallet_token","demo");
  localStorage.setItem("device_seed_demo","cd".repeat(32));
  localStorage.setItem("zkas_chat_relay_v1","ws://127.0.0.1:7471");
  localStorage.setItem("zkas_chat_consent_v1","1");
  localStorage.setItem("zkas_chat_nickname_v1","Tester");
};
const watch = (p) => p.on("console", m => { const t=m.text(); if (t.includes("zkas-dbg")) console.log("              page:", t); });
const openChat = async (p) => {
  await p.goto("http://127.0.0.1:5480/#/chat", { waitUntil:"networkidle2", timeout:60000 });
  await new Promise(r=>setTimeout(r,1500));
  const bx = await p.evaluate(()=>{const e=[...document.querySelectorAll("button,a")].find(b=>/^chat/i.test(b.textContent.trim()));if(!e)return null;const r=e.getBoundingClientRect();if(!r.width)return null;return{x:Math.round(r.left+r.width/2),y:Math.round(r.top+r.height/2)};});
  if (bx) { await p.touchscreen.tap(bx.x, bx.y); }
  await new Promise(r=>setTimeout(r,4000));
};
const count = (p) => p.evaluate(()=>document.querySelectorAll("[data-mid]").length);
const meta = (p) => p.evaluate(() => new Promise((res) => {
  const r = indexedDB.open("zkas-chat");
  r.onsuccess = () => { try { const q = r.result.transaction("meta","readonly").objectStore("meta").getAll(); q.onsuccess = () => res(q.result); q.onerror = () => res("err"); } catch(e) { res("no store: "+e); } };
  r.onerror = () => res("open failed");
}));
const idbCount = (p) => p.evaluate(() => new Promise((res) => {
  const r = indexedDB.open("zkas-chat");
  r.onsuccess = () => { try { const q = r.result.transaction("notes","readonly").objectStore("notes").count(); q.onsuccess = () => res(q.result); q.onerror = () => res(-1); } catch { res(-1); } };
  r.onerror = () => res(-1);
}));
try {
  writeFileSync(LOG, "[]");
  // --- first visit: nothing cached, relay supplies everything
  const p1 = await b.newPage();
  await p1.setViewport({ width:390, height:844, deviceScaleFactor:2, isMobile:true, hasTouch:true });
  await p1.emulateMediaFeatures([{ name:"prefers-reduced-motion", value:"no-preference" }]);
  watch(p1);
  await p1.evaluateOnNewDocument(seed);
  await openChat(p1);
  console.log(`first visit : ${await count(p1)} bubbles rendered, ${await idbCount(p1)} notes in IndexedDB`);
  const all1 = JSON.parse(readFileSync(LOG,"utf8")).filter(f=>f.id==="room"); const f1 = [all1[all1.length-1]];
  console.log(`              room REQ since=${f1[0]?.filter.since ?? "none"} (first visit should ask for the week)`);
  console.log("              meta rows:", JSON.stringify(await meta(p1)));
  await p1.close();

  // --- second visit: same profile dir? no — a new page shares the browser's
  // storage, so IndexedDB persists across this reload.
  writeFileSync(LOG, "[]");
  const p2 = await b.newPage();
  await p2.setViewport({ width:390, height:844, deviceScaleFactor:2, isMobile:true, hasTouch:true });
  await p2.emulateMediaFeatures([{ name:"prefers-reduced-motion", value:"no-preference" }]);
  watch(p2);
  await p2.evaluateOnNewDocument(seed);
  await openChat(p2);
  const all2 = JSON.parse(readFileSync(LOG,"utf8")).filter(f=>f.id==="room"); const f2 = [all2[all2.length-1]];
  const since2 = f2[0]?.filter.since;
  const week = Math.floor(Date.now()/1000) - 7*24*3600;
  console.log(`second visit: ${await count(p2)} bubbles rendered, ${await idbCount(p2)} notes in IndexedDB`);
  console.log("              meta rows:", JSON.stringify(await meta(p2)));
  console.log(`              room REQ since=${since2} -> ${since2 && since2 > week + 3600 ? "DELTA (cursor used)" : "still the full week"}`);
  await p2.close();
} finally { await b.close(); }
