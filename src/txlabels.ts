const STORAGE_KEY = "zkas_tx_labels_v1";

type Labels = Record<string, string>;

function read(): Labels {
  try {
    const value = JSON.parse(localStorage.getItem(STORAGE_KEY) || "{}");
    return value && typeof value === "object" && !Array.isArray(value) ? value as Labels : {};
  } catch {
    return {};
  }
}

export function getTxLabel(txid: string): string {
  const value = read()[txid.toLowerCase()];
  return typeof value === "string" ? value : "";
}

export function setTxLabel(txid: string, label: string): void {
  const labels = read();
  const key = txid.toLowerCase();
  const clean = label.trim().slice(0, 160);
  if (clean) labels[key] = clean;
  else delete labels[key];
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(labels));
  } catch {
    throw new Error("This device could not save the label.");
  }
}
