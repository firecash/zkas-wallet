/// Strip the characters that let a string rearrange the text around it.
///
/// Unicode's bidi controls are not display quirks, they are overrides: U+202E
/// (RIGHT-TO-LEFT OVERRIDE) reverses the visual order of everything after it until it is
/// popped, and the isolates behave similarly. In a wallet that matters because the strings
/// a stranger controls — a contact name, a chat profile name, the `label` on a payment URI
/// — are rendered BESIDE an address, and `displayName()` puts a name where an address would
/// otherwise be. A name ending in U+202E can therefore reorder the address next to it, which
/// is the oldest trick in filename spoofing pointed at the one string a user is told to
/// check.
///
/// Also removed: the zero-width characters and the BOM. They are invisible, so two names
/// that look identical can differ, which defeats "is this the contact I saved before?" —
/// and a zero-width space inside an address-looking string hides a difference entirely.
///
/// Everything else is left alone. This is not a filter for rude words or a normaliser; it
/// removes exactly the characters whose purpose is to make text display as something other
/// than its contents.
const UNSAFE = /[​-‏‪-‮⁦-⁩﻿؜]/g;

/// Also strip C0/C1 controls apart from nothing — a name with a newline or a NUL in it
/// breaks layout and log lines, and no legitimate display name contains one.
const CONTROLS = /[\u0000-\u001F\u007F-\u009F]/g;

export function safeText(s: string): string {
  return s.replace(UNSAFE, "").replace(CONTROLS, " ").replace(/\s+/g, " ").trim();
}

/// True when a string carries anything this strips — so a caller can refuse rather than
/// silently alter what someone typed, where that is the better answer.
export function hasUnsafeText(s: string): boolean {
  return UNSAFE.test(s) || CONTROLS.test(s);
}

/// The protocol's memo field is 512 BYTES of UTF-8, not 512 characters.
///
/// The send and payment-request inputs capped at 400 CHARACTERS, which is only the same
/// thing in ASCII. walletd answers `memo too long (max 512 bytes)` with a 400, so a memo
/// written in most of the languages this wallet ships in was rejected AFTER the user had
/// typed it and tapped send: 400 Cyrillic or Arabic characters is 800 bytes, 400 CJK is
/// 1200, 400 emoji is 1600. What actually fits is 256 Cyrillic, 170 CJK, 128 emoji.
///
/// Truncation is by code POINT, never by byte index, so a multi-byte character is never cut
/// in half into a replacement glyph — and the loop walks back from the character boundary
/// rather than slicing blind.
export function clampUtf8Bytes(s: string, maxBytes: number): string {
  const enc = new TextEncoder();
  if (enc.encode(s).length <= maxBytes) return s;
  // Whole code points, so surrogate pairs stay intact.
  const points = [...s];
  let out = "";
  for (const p of points) {
    if (enc.encode(out + p).length > maxBytes) break;
    out += p;
  }
  return out;
}

/// The memo field's real capacity, as walletd enforces it.
export const MEMO_MAX_BYTES = 512;
