import puppeteer from "puppeteer";
import http from "node:http";
import { readFileSync } from "node:fs";
// Bundled on the fly so the test always runs the CURRENT source. jsdom has no
// IndexedDB and fake-indexeddb would be testing the fake, which is how a fix
// lands in a file the app does not even import.
const dir = process.argv[2];
const srv = http.createServer((req, res) => {
  const f = req.url === "/" ? "/t.html" : req.url.split("?")[0];
  try {
    const body = readFileSync(dir + f);
    res.writeHead(200, { "content-type": f.endsWith(".mjs") ? "text/javascript" : "text/html" });
    res.end(body);
  } catch { res.writeHead(404); res.end(); }
}).listen(5491, "127.0.0.1");
const b = await puppeteer.launch({ executablePath:"/root/.cache/puppeteer/chrome/linux-148.0.7778.97/chrome-linux64/chrome", args:["--no-sandbox","--disable-dev-shm-usage"] });
try {
  const p = await b.newPage();
  p.on("pageerror", e => console.log("PAGEERROR:", String(e).slice(0,200)));
  await p.goto("http://127.0.0.1:5491/", { waitUntil:"networkidle2", timeout:60000 });
  await p.waitForFunction(()=>document.getElementById("out").textContent !== "running…", { timeout: 60000 });
  console.log(await p.evaluate(()=>document.getElementById("out").textContent));
} finally { await b.close(); srv.close(); }

// Exit non-zero if anything failed, so this can gate a release.
