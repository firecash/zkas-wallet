// Used by the diag-smoke CI job: launch the built desktop app with the scripted
// diagnostics tour, optionally register a throwaway watch-only wallet so the engine really
// syncs, let it run, then stop it. Run with vite-node (the FVK comes from the real signer).
//
//   npx vite-node ci/diag-run.mjs <binary> <seconds> <label> <outdir> <kill|close> [register] [secretsfile]
import { spawn, spawnSync } from "node:child_process";
import { appendFileSync, createWriteStream, existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const [bin, secsStr, label, outDir, stopMode, register, secretsFile] = process.argv.slice(2);
const win = process.platform === "win32";
const home = process.env.HOME || process.env.USERPROFILE;
const data = win ? join(process.env.APPDATA, "info.zkas.wallet") : join(home, "Library/Application Support/info.zkas.wallet");
mkdirSync(outDir, { recursive: true });
const crash = join(data, "crash.log");
const startLen = existsSync(crash) ? readFileSync(crash, "utf8").length : 0;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const say = (s) => console.log(`[${label} +${Math.round(process.uptime())}s] ${s}`);

// stdout/stderr stay on the runner (not uploaded): the engine's raw lines are not redacted.
const raw = createWriteStream(join(process.env.RUNNER_TEMP || outDir, `${label}.raw.log`));
const p = spawn(bin, [], { env: { ...process.env, ZKAS_DIAG_TOUR: "1" }, stdio: ["ignore", "pipe", "pipe"] });
p.stdout.pipe(raw);
p.stderr.pipe(raw);
let exited = null;
p.on("exit", (code, sig) => { exited = { code, sig }; });
say(`started pid ${p.pid}`);

let port;
for (let i = 0; i < 240 && !port && !exited; i++) {
  await sleep(1000);
  if (!existsSync(crash)) continue;
  const m = [...readFileSync(crash, "utf8").slice(startLen).matchAll(/embedded walletd on 127\.0\.0\.1:(\d+)/g)].pop();
  if (m) port = m[1];
}
say(`engine port ${port ?? "none"}${exited ? " (app exited: " + JSON.stringify(exited) + ")" : ""}`);

if (register && port) {
  try {
    const token = readFileSync(join(data, "wallet-token"), "utf8").trim();
    if (secretsFile) appendFileSync(secretsFile, token + "\n");
    await sleep(40_000);
    const st = await (await fetch(`http://127.0.0.1:${port}/api/status`, { headers: { "X-Wallet-Token": token }, signal: AbortSignal.timeout(20_000) })).text();
    const tip = Number((st.match(/"daa_score":(\d+)/) || [])[1] || 0);
    say(`tip daa ${tip || "unknown"}`);
    if (tip > 30_000) {
      const { generateWallet, fvkHex } = await import("../src/signer/index.ts");
      const w = await generateWallet("mainnet");
      const fvk = await fvkHex(w.seedHex);
      if (secretsFile) appendFileSync(secretsFile, fvk + "\n" + w.seedHex + "\n");
      const r = await fetch(`http://127.0.0.1:${port}/api/wallet/watch`, {
        method: "POST",
        headers: { "X-Wallet-Token": token, "Content-Type": "application/json" },
        body: JSON.stringify({ fvk_hex: fvk, birthday: tip - 30_000 }),
        signal: AbortSignal.timeout(200_000),
      });
      say(`registered throwaway watch-only wallet (empty, fresh random seed), birthday tip-30000: http ${r.status}`);
    }
  } catch (e) {
    say(`registration skipped: ${e?.name}: ${e?.message}`);
  }
}

const until = Date.now() + Number(secsStr) * 1000;
while (Date.now() < until && !exited) await sleep(2000);
if (exited) say(`app exited on its own: ${JSON.stringify(exited)}`);
else if (stopMode === "kill") {
  p.kill("SIGKILL");
  say("hard kill (as a crash / OOM / power cut would)");
} else {
  if (win) say(`taskkill (WM_CLOSE): ${spawnSync("taskkill", ["/PID", String(p.pid)]).status}`);
  else p.kill("SIGTERM");
  for (let i = 0; i < 30 && !exited; i++) await sleep(1000);
  say(exited ? `exited after close request: ${JSON.stringify(exited)}` : "did not exit within 30 s of the close request; killing");
  if (!exited) p.kill("SIGKILL");
}
await sleep(3000);
process.exit(0);
