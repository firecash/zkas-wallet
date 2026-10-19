import { defineConfig } from "vitest/config";
import { versionDefines } from "./buildinfo";

export default defineConfig({
  // The app build injects these; without them here every test read the
  // "dev" fallback and the version display was effectively untested.
  define: versionDefines(),
  test: {
    environment: "jsdom",
    globals: true,
    // 5s (the default) is optimistic for this suite and made it fail for reasons that had
    // nothing to do with the code.
    //
    // Several tests do REAL work rather than mocking it: `backup`/`applock` derive keys with
    // PBKDF2 at 600,000 iterations, and the component tests render the whole app. Those sit
    // close enough to 5s that merely ADDING a test file could tip them over — observed twice,
    // once as two `accounts` tests failing in a full run while passing 11/11 alone, and again
    // as five failures across `flows`, `watch-ui` and `reseal-durability` that all passed with
    // a longer timeout and no code change. Both were the scheduler, not a bug.
    //
    // A suite that depends on having a spare core is a suite that fails in CI for no reason,
    // and chasing those costs more than the real failures it hides.
    testTimeout: 20_000,
    hookTimeout: 20_000,
    setupFiles: ["./test/setup.ts"],
    include: ["test/**/*.test.tsx", "test/**/*.test.ts"],
  },
});
