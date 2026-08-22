import { onionSiblingBase } from "./api";

export type ServiceCategory = "store" | "use" | "earn" | "verify" | "build";

export type ServiceStatus = "Live" | "Testing" | "Developer preview" | "Available" | "Published" | "Open";

export type ServiceIcon =
  | "bot"
  | "book"
  | "code"
  | "credit-card"
  | "file-key"
  | "git"
  | "pickaxe"
  | "search"
  | "server"
  | "terminal"
  | "users"
  | "wallet";

export type ServiceLink = {
  label: string;
  href: string;
};

export type DirectoryService = {
  id: string;
  name: string;
  description: string;
  categories: ServiceCategory[];
  status: ServiceStatus;
  tags: string[];
  action: string;
  href: string;
  icon: ServiceIcon;
  secondary?: ServiceLink[];
};

type ServicesDocument = {
  schema_version: 1;
  updated_at: string;
  services: DirectoryService[];
};

export const SERVICES_DIRECTORY_URL =
  import.meta.env.VITE_SERVICES_DIRECTORY_URL || "https://services.zkas.info/services.v1.json";

/// The directory URL to fetch right now. On Tor it is served on the same onion so
/// the services list never reaches clearnet either; otherwise the default host.
function servicesDirectoryUrl(): string {
  try {
    const onion = onionSiblingBase();
    if (onion) return onion + "/services.v1.json";
  } catch { /* fall through to default */ }
  return SERVICES_DIRECTORY_URL;
}

const CACHE_KEY = "zkas_services_directory_v1";
const MAX_DOCUMENT_BYTES = 256 * 1024;
const MAX_SERVICES = 100;
const REQUEST_TIMEOUT_MS = 5_000;

const CATEGORIES = new Set<ServiceCategory>(["store", "use", "earn", "verify", "build"]);
const STATUSES = new Set<ServiceStatus>(["Live", "Testing", "Developer preview", "Available", "Published", "Open"]);
const ICONS = new Set<ServiceIcon>(["bot", "book", "code", "credit-card", "file-key", "git", "pickaxe", "search", "server", "terminal", "users", "wallet"]);

// This copy is deliberately bundled with every wallet build. It is used only
// until the live directory arrives, or when the directory is unreachable and
// this device has no previously validated copy.
export const BUNDLED_SERVICES: DirectoryService[] = [
  { id: "ai-uncensored", name: "AI Uncensored", description: "Private, uncensored AI you pay for with ZKAS — no accounts, no tracking.", categories: ["use"], status: "Live", tags: ["Pay with ZKAS", "Private", "AI"], action: "Open AI Uncensored", href: "https://ai-uncensored.online/", icon: "bot" },
  { id: "cli-wallet", name: "CLI & self-hosted wallet", description: "Run walletd or shielded-pay on your own machine.", categories: ["store", "build"], status: "Live", tags: ["Local custody", "Self-hosted", "CLI + API"], action: "View wallet tools", href: "https://github.com/firecash/zkas-rusty#wallet", icon: "terminal" },
  { id: "web-wallet", name: "Web Wallet", description: "Browser wallet for everyday ZKAS. Web keys are less protected than local custody.", categories: ["store"], status: "Live", tags: ["Web", "Less secure"], action: "Open web wallet", href: "https://wallet.zkas.info", icon: "wallet" },
  { id: "app-wallet", name: "Light Wallet", description: "Wallet app with local keys for secure ZKAS custody.", categories: ["store"], status: "Available", tags: ["App", "Secure", "Self-custody"], action: "Download app", href: "https://github.com/firecash/zkas-wallet/releases", icon: "wallet" },
  { id: "paper-wallet", name: "Paper Wallet", description: "Create keys offline and keep the seed disconnected.", categories: ["store"], status: "Live", tags: ["Cold storage", "Self-custody"], action: "Create offline wallet", href: "https://zkas.info/paper-wallet.html", icon: "file-key" },
  { id: "explorer", name: "BlockDAG Explorer", description: "Inspect blocks and public chain activity. Shielded details stay private.", categories: ["verify"], status: "Live", tags: ["Chain data", "No balances", "Search"], action: "Explore the DAG", href: "https://explorer.zkas.info", icon: "search" },
  { id: "mining-pools", name: "Mining Pools", description: "Choose a kHeavyHash pool and check its fees and payout rules.", categories: ["earn"], status: "Live", tags: ["Shielded payout", "Merged mining", "Stratum"], action: "Choose a pool", href: "https://services.zkas.info/earn", icon: "pickaxe", secondary: [
    { label: "ZKas Pool", href: "https://mining-pool.zkas.info" },
    { label: "K1Pool", href: "https://k1pool.com" },
    { label: "KekPool", href: "https://kekpool.com" },
    { label: "CoreBlock", href: "https://coreblock.cc" },
  ] },
  { id: "node-solo-mining", name: "Node & Solo Mining", description: "Run a node, verify the chain and mine to your own shielded address.", categories: ["earn", "verify"], status: "Live", tags: ["Self-verified", "Self-hosted", "CLI"], action: "Run the software", href: "https://github.com/firecash/zkas-rusty#run-a-node--join-the-network", icon: "server" },
  { id: "payment-gateway", name: "Payment Gateway", description: "Accept ZKAS with invoices, checkout pages and webhooks.", categories: ["build"], status: "Testing", tags: ["Watch-only", "Self-hosted", "WooCommerce"], action: "View gateway project", href: "https://github.com/firecash/zkas-rusty/tree/main/gateway", icon: "credit-card" },
  { id: "sdk", name: "ZKAS SDK", description: "Rust and TypeScript tools for addresses, wallets and private payments.", categories: ["build"], status: "Developer preview", tags: ["SDK", "Rust", "TypeScript"], action: "Build with ZKAS", href: "https://github.com/firecash/zkas-rusty/tree/main/sdk", icon: "code" },
  { id: "core-source", name: "Core Source", description: "Source code for the node, consensus, wallet and mining tools.", categories: ["build", "verify"], status: "Live", tags: ["Source", "Open", "Rust"], action: "View repository", href: "https://github.com/firecash/zkas-rusty", icon: "git" },
  { id: "whitepaper", name: "Whitepaper", description: "Learn how ZKas privacy, consensus and economics work.", categories: ["build"], status: "Published", tags: ["Documentation", "Protocol"], action: "Read whitepaper", href: "https://zkas.info/whitepaper.html", icon: "book" },
  { id: "community", name: "Community", description: "Get help, follow updates and talk with ZKAS users.", categories: ["build"], status: "Open", tags: ["Discord", "X", "Support"], action: "Open Discord", href: "https://discord.gg/jysMS4XNFT", icon: "users", secondary: [{ label: "X", href: "https://x.com/ZKas_X" }] },
];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringField(value: unknown, maxLength: number): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim();
  return normalized.length > 0 && normalized.length <= maxLength ? normalized : null;
}

function httpsUrl(value: unknown): string | null {
  const href = stringField(value, 2_048);
  if (!href) return null;
  try {
    const url = new URL(href);
    if (url.protocol !== "https:" || url.username || url.password) return null;
    return url.toString();
  } catch {
    return null;
  }
}

function stringList(value: unknown, maximum: number, maxLength: number): string[] | null {
  if (!Array.isArray(value) || value.length > maximum) return null;
  const result: string[] = [];
  for (const entry of value) {
    const parsed = stringField(entry, maxLength);
    if (!parsed || result.includes(parsed)) return null;
    result.push(parsed);
  }
  return result;
}

function parseService(value: unknown): DirectoryService | null {
  if (!isRecord(value)) return null;
  const id = stringField(value.id, 64);
  const name = stringField(value.name, 80);
  const description = stringField(value.description, 240);
  const action = stringField(value.action, 80);
  const href = httpsUrl(value.href);
  if (!id || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(id) || !name || !description || !action || !href) return null;

  const categories = stringList(value.categories, 5, 16);
  if (!categories?.length || !categories.every((category): category is ServiceCategory => CATEGORIES.has(category as ServiceCategory))) return null;
  const tags = stringList(value.tags, 8, 40);
  if (!tags) return null;
  if (typeof value.status !== "string" || !STATUSES.has(value.status as ServiceStatus)) return null;
  if (typeof value.icon !== "string" || !ICONS.has(value.icon as ServiceIcon)) return null;

  let secondary: ServiceLink[] | undefined;
  if (value.secondary !== undefined) {
    if (!Array.isArray(value.secondary) || value.secondary.length > 8) return null;
    secondary = [];
    for (const entry of value.secondary) {
      if (!isRecord(entry)) return null;
      const label = stringField(entry.label, 60);
      const secondaryHref = httpsUrl(entry.href);
      if (!label || !secondaryHref) return null;
      secondary.push({ label, href: secondaryHref });
    }
  }

  return {
    id,
    name,
    description,
    categories: categories as ServiceCategory[],
    status: value.status as ServiceStatus,
    tags,
    action,
    href,
    icon: value.icon as ServiceIcon,
    ...(secondary?.length ? { secondary } : {}),
  };
}

export function parseServicesDocument(value: unknown): ServicesDocument | null {
  if (!isRecord(value) || value.schema_version !== 1 || !Array.isArray(value.services)) return null;
  if (value.services.length === 0 || value.services.length > MAX_SERVICES) return null;
  const updatedAt = stringField(value.updated_at, 40);
  if (!updatedAt || !Number.isFinite(Date.parse(updatedAt))) return null;

  const services: DirectoryService[] = [];
  const ids = new Set<string>();
  for (const entry of value.services) {
    const service = parseService(entry);
    if (!service || ids.has(service.id)) return null;
    ids.add(service.id);
    services.push(service);
  }
  return { schema_version: 1, updated_at: updatedAt, services };
}

function browserStorage(): Storage | null {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null;
  }
}

export function readCachedServices(storage: Storage | null = browserStorage()): DirectoryService[] | null {
  if (!storage) return null;
  try {
    const raw = storage.getItem(CACHE_KEY);
    if (!raw || raw.length > MAX_DOCUMENT_BYTES) return null;
    return parseServicesDocument(JSON.parse(raw))?.services ?? null;
  } catch {
    return null;
  }
}

function cacheDocument(document: ServicesDocument, storage: Storage | null = browserStorage()) {
  if (!storage) return;
  try {
    storage.setItem(CACHE_KEY, JSON.stringify(document));
  } catch {
    // Private browsing and full storage must never prevent the directory loading.
  }
}

export async function refreshServicesDirectory(
  fetcher: typeof fetch = fetch,
  storage: Storage | null = browserStorage(),
): Promise<DirectoryService[]> {
  const controller = new AbortController();
  const timer = window.setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await fetcher(servicesDirectoryUrl(), {
      method: "GET",
      headers: { Accept: "application/json" },
      cache: "no-cache",
      credentials: "omit",
      referrerPolicy: "no-referrer",
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`services directory returned HTTP ${response.status}`);
    const declaredLength = Number(response.headers.get("content-length") || "0");
    if (declaredLength > MAX_DOCUMENT_BYTES) throw new Error("services directory is too large");
    const body = await response.text();
    if (body.length > MAX_DOCUMENT_BYTES) throw new Error("services directory is too large");
    const document = parseServicesDocument(JSON.parse(body));
    if (!document) throw new Error("services directory failed validation");
    cacheDocument(document, storage);
    return document.services;
  } finally {
    window.clearTimeout(timer);
  }
}
