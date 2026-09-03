// Whether the "Access token" field appears in wallet-service setup. Off by default:
// most services need no token, so the field is a question the user should not have to
// answer. Anyone running a token-protected walletd turns it on in Settings.
const KEY = "show_access_token_field";

export function showAccessTokenField(): boolean {
  try {
    return localStorage.getItem(KEY) === "1";
  } catch {
    return false;
  }
}

export function setShowAccessTokenField(on: boolean): void {
  try {
    if (on) localStorage.setItem(KEY, "1");
    else localStorage.removeItem(KEY);
  } catch {
    /* ignore */
  }
}
