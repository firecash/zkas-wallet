// Getting a file OUT of the wallet, on every platform it runs on.
//
// The wallet exported its transaction CSV and its encrypted backup the way a web page
// does: a Blob URL on an `<a download>`, clicked programmatically. That works in a
// browser and is a silent no-op inside a Capacitor WebView and inside Tauri — the tap
// landed, nothing happened, no error. Reported as "export csv on apps doesn't work",
// and the backup export had exactly the same bug sitting next to it unnoticed.
//
// No Filesystem or Share plugin is installed (only @capacitor/core and haptics), and
// adding one needs a native rebuild — so this uses what every shell already has, in
// descending order of how good the result feels:
//
//   1. navigator.share with a real File — the native sheet, so the user picks Files,
//      Drive, mail, wherever. This is what a native app is expected to do.
//   2. navigator.clipboard — the data still reaches the user; they paste it somewhere.
//      A worse experience than a file, but an honest one, and it never silently fails.
//   3. the <a download> path — correct on the web, where it has always worked.
//
// Every branch reports what actually happened so the caller can say so. Nothing here
// is allowed to fail silently, because a backup a user believes they took and did not
// is worse than no backup at all.

export type ExportOutcome = "shared" | "copied" | "downloaded";

/// True when a native share sheet can take an actual file. Feature-detected rather
/// than platform-sniffed: `canShare` with a `files` payload is the only reliable
/// signal, since several shells expose `navigator.share` but reject files.
function canShareFile(file: File): boolean {
  try {
    const nav = navigator as Navigator & { canShare?: (d: { files?: File[] }) => boolean };
    return typeof navigator.share === "function" && typeof nav.canShare === "function" && nav.canShare({ files: [file] });
  } catch {
    return false;
  }
}

/**
 * Hand `content` to the user as `filename`, by whatever means this platform supports.
 *
 * Throws only if every route failed, so a caller can tell the user the export did not
 * happen instead of leaving them believing it did.
 */
export async function exportFile(filename: string, mime: string, content: string): Promise<ExportOutcome> {
  const file = new File([content], filename, { type: mime });

  // 1. Native share sheet.
  if (canShareFile(file)) {
    try {
      await navigator.share({ files: [file], title: filename });
      return "shared";
    } catch (e) {
      // A user dismissing the sheet is a cancellation, NOT a failure to export, and
      // must not fall through to silently copying their backup to the clipboard.
      if ((e as Error)?.name === "AbortError") return "shared";
      /* anything else: fall through and try the next route */
    }
  }

  // 2. Clipboard. Needs a user gesture on most platforms, which every caller has —
  // these run from a button press.
  //
  // Two attempts, not one. `navigator.clipboard` is unavailable or rejects outside a
  // secure context, and several native shells serve the app from capacitor:// or
  // tauri:// where that check does not pass — so the modern API alone would leave the
  // fallback path itself silently failing on exactly the platforms it exists for.
  // `execCommand("copy")` is deprecated and works there.
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(content);
      return "copied";
    }
  } catch {
    /* fall through to the legacy path */
  }
  try {
    const ta = document.createElement("textarea");
    ta.value = content;
    ta.style.position = "fixed";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand("copy");
    ta.remove();
    if (ok) return "copied";
  } catch {
    /* fall through */
  }

  // 3. Browser download.
  const url = URL.createObjectURL(new Blob([content], { type: mime }));
  try {
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    a.rel = "noopener";
    document.body.appendChild(a);
    a.click();
    a.remove();
    return "downloaded";
  } finally {
    // Revoke on a later tick: revoking synchronously can cancel the download the
    // click just started in some engines.
    setTimeout(() => URL.revokeObjectURL(url), 10_000);
  }
}

/// What to tell the user, given how the export actually left the device. Separate from
/// the mechanism so the message can never claim a file was saved when it was copied.
export function exportMessage(outcome: ExportOutcome, filename: string): string {
  switch (outcome) {
    case "shared":
      return `${filename} is ready to save or send.`;
    case "copied":
      return `${filename} copied to your clipboard — paste it into a file to keep it.`;
    case "downloaded":
      return `${filename} saved to your downloads.`;
  }
}
