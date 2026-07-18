// Exercise the real applock module against a fake localStorage, covering the
// multi-wallet lifecycle end to end.
const store = new Map();
globalThis.localStorage = {
  get length() { return store.size; },
  key: (i) => [...store.keys()][i] ?? null,
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => store.set(k, String(v)),
  removeItem: (k) => store.delete(k),
};
globalThis.document = { addEventListener() {} };

const m = await import("../src/applock.ts");

const A = "tokenA", B = "tokenB";
const seedA = "a".repeat(64), seedB = "b".repeat(64);
localStorage.setItem("wallet_token", A);
localStorage.setItem(`device_seed_${A}`, seedA);
localStorage.setItem(`device_seed_${B}`, seedB);

let pass = 0, fail = 0;
const check = (name, cond) => { cond ? pass++ : fail++; console.log(`${cond ? "PASS" : "FAIL"}  ${name}`); };

// Enable the lock: both wallets sealed, no cleartext left.
await m.enableLock("open-sesame", "passphrase");
check("both wallets sealed", Object.keys(JSON.parse(localStorage.getItem("app_lock_v2")).wallets).length === 2);
check("no cleartext seed A", localStorage.getItem("device_seed_" + A) === null);
check("no cleartext seed B", localStorage.getItem("device_seed_" + B) === null);
check("seed not recoverable from storage", !JSON.stringify([...store.values()]).includes(seedA));
check("active seed usable while unlocked", m.unlockedDeviceSeed() === seedA);

// A wallet CREATED while unlocked must be sealed, not held only in RAM.
const C = "tokenC", seedC = "c".repeat(64);
localStorage.setItem("wallet_token", C);
await m.sealNewSeed(C, seedC);
check("new wallet sealed to storage", !!JSON.parse(localStorage.getItem("app_lock_v2")).wallets[C]);

// Simulate a reload: memory gone, storage is all that remains.
m.lock();
check("locked: no seed in memory", m.unlockedDeviceSeed() === null);
check("locked: still enabled", m.isLockEnabled() === true);
check("wrong passphrase rejected", (await m.unlock("guess")) === false);
check("still locked after a wrong try", m.unlockedDeviceSeed() === null);
check("correct passphrase unlocks", (await m.unlock("open-sesame")) === true);
check("wallet created while locked SURVIVED reload", m.unlockedDeviceSeed() === seedC);
localStorage.setItem("wallet_token", A);
check("wallet A still intact", m.unlockedDeviceSeed() === seedA);

// Removing one wallet must not disturb the others.
m.forgetWalletLock(B);
const rec = JSON.parse(localStorage.getItem("app_lock_v2"));
check("removed wallet's key dropped", !rec.wallets[B]);
check("other wallets keep their keys", !!rec.wallets[A] && !!rec.wallets[C]);

// Turning the lock off restores cleartext for every wallet.
check("disable needs the passphrase", (await m.disableLock("nope")) === false);
check("disable works with it", (await m.disableLock("open-sesame")) === true);
check("cleartext restored", localStorage.getItem("device_seed_" + A) === seedA);
check("lock record gone", localStorage.getItem("app_lock_v2") === null);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
