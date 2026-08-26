import { readFileSync } from "node:fs";

/// Build-time constants shared by the app build and the test run.
///
/// Defined in ONE place because they were not: vite.config.ts had them and
/// vitest.config.ts did not, so every test saw the "dev" fallback and could not
/// have caught a broken version display.
export function versionDefines(): Record<string, string> {
  const pkg = JSON.parse(readFileSync(new URL("./package.json", import.meta.url), "utf8")) as { version: string };
  // A build stamp rather than a git sha: the release build runs from an rsynced
  // tree with no .git, where a sha would silently become "unknown" exactly where
  // it is needed.
  const built = new Date().toISOString().slice(0, 16).replace("T", " ");
  return {
    __APP_VERSION__: JSON.stringify(pkg.version),
    __APP_BUILT__: JSON.stringify(built),
  };
}
