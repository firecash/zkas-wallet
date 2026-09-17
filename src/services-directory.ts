import { onionSiblingBase } from "./api";
import i18n from "./i18n";

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
//
// The wording is read through i18next at access time (getters), not when this
// module loads: a non-English catalogue arrives asynchronously, so a plain
// string here would be frozen in English before the translation was in.
export const BUNDLED_SERVICES: DirectoryService[] = [
  { id: "ai-uncensored", get name() { return i18n.t("servicesDirectory.aiUncensoredName"); }, get description() { return i18n.t("servicesDirectory.aiUncensoredDescription"); }, categories: ["use"], status: "Live", get tags() { return [i18n.t("servicesDirectory.tagPayWithZkas"), i18n.t("servicesDirectory.tagPrivate"), i18n.t("servicesDirectory.tagAi")]; }, get action() { return i18n.t("servicesDirectory.aiUncensoredAction"); }, href: "https://ai-uncensored.online/", icon: "bot" },
  { id: "cli-wallet", get name() { return i18n.t("servicesDirectory.cliWalletName"); }, get description() { return i18n.t("servicesDirectory.cliWalletDescription"); }, categories: ["store", "build"], status: "Live", get tags() { return [i18n.t("servicesDirectory.tagLocalCustody"), i18n.t("servicesDirectory.tagSelfHosted"), i18n.t("servicesDirectory.tagCliApi")]; }, get action() { return i18n.t("servicesDirectory.cliWalletAction"); }, href: "https://github.com/firecash/zkas-rusty#wallet", icon: "terminal" },
  { id: "web-wallet", get name() { return i18n.t("servicesDirectory.webWalletName"); }, get description() { return i18n.t("servicesDirectory.webWalletDescription"); }, categories: ["store"], status: "Live", get tags() { return [i18n.t("servicesDirectory.tagWeb"), i18n.t("servicesDirectory.tagLessSecure")]; }, get action() { return i18n.t("servicesDirectory.webWalletAction"); }, href: "https://wallet.zkas.info", icon: "wallet" },
  { id: "app-wallet", get name() { return i18n.t("servicesDirectory.appWalletName"); }, get description() { return i18n.t("servicesDirectory.appWalletDescription"); }, categories: ["store"], status: "Available", get tags() { return [i18n.t("servicesDirectory.tagApp"), i18n.t("servicesDirectory.tagSecure"), i18n.t("servicesDirectory.tagSelfCustody")]; }, get action() { return i18n.t("servicesDirectory.appWalletAction"); }, href: "https://github.com/firecash/zkas-wallet/releases", icon: "wallet" },
  { id: "paper-wallet", get name() { return i18n.t("servicesDirectory.paperWalletName"); }, get description() { return i18n.t("servicesDirectory.paperWalletDescription"); }, categories: ["store"], status: "Live", get tags() { return [i18n.t("servicesDirectory.tagColdStorage"), i18n.t("servicesDirectory.tagSelfCustody")]; }, get action() { return i18n.t("servicesDirectory.paperWalletAction"); }, href: "https://zkas.info/paper-wallet.html", icon: "file-key" },
  { id: "explorer", get name() { return i18n.t("servicesDirectory.explorerName"); }, get description() { return i18n.t("servicesDirectory.explorerDescription"); }, categories: ["verify"], status: "Live", get tags() { return [i18n.t("servicesDirectory.tagChainData"), i18n.t("servicesDirectory.tagNoBalances"), i18n.t("servicesDirectory.tagSearch")]; }, get action() { return i18n.t("servicesDirectory.explorerAction"); }, href: "https://explorer.zkas.info", icon: "search" },
  { id: "mining-pools", get name() { return i18n.t("servicesDirectory.miningPoolsName"); }, get description() { return i18n.t("servicesDirectory.miningPoolsDescription"); }, categories: ["earn"], status: "Live", get tags() { return [i18n.t("servicesDirectory.tagShieldedPayout"), i18n.t("servicesDirectory.tagMergedMining"), i18n.t("servicesDirectory.tagStratum")]; }, get action() { return i18n.t("servicesDirectory.miningPoolsAction"); }, href: "https://services.zkas.info/earn", icon: "pickaxe", get secondary() { return [
    { label: i18n.t("servicesDirectory.zkasPoolLabel"), href: "https://mining-pool.zkas.info" },
    { label: "K1Pool", href: "https://k1pool.com" },
    { label: "KekPool", href: "https://kekpool.com" },
    { label: "CoreBlock", href: "https://coreblock.cc" },
  ]; } },
  { id: "node-solo-mining", get name() { return i18n.t("servicesDirectory.nodeSoloMiningName"); }, get description() { return i18n.t("servicesDirectory.nodeSoloMiningDescription"); }, categories: ["earn", "verify"], status: "Live", get tags() { return [i18n.t("servicesDirectory.tagSelfVerified"), i18n.t("servicesDirectory.tagSelfHosted"), i18n.t("servicesDirectory.tagCli")]; }, get action() { return i18n.t("servicesDirectory.nodeSoloMiningAction"); }, href: "https://github.com/firecash/zkas-rusty#run-a-node--join-the-network", icon: "server" },
  { id: "payment-gateway", get name() { return i18n.t("servicesDirectory.paymentGatewayName"); }, get description() { return i18n.t("servicesDirectory.paymentGatewayDescription"); }, categories: ["build"], status: "Testing", get tags() { return [i18n.t("servicesDirectory.tagWatchOnly"), i18n.t("servicesDirectory.tagSelfHosted"), i18n.t("servicesDirectory.tagWooCommerce")]; }, get action() { return i18n.t("servicesDirectory.paymentGatewayAction"); }, href: "https://github.com/firecash/zkas-rusty/tree/main/gateway", icon: "credit-card" },
  { id: "sdk", get name() { return i18n.t("servicesDirectory.sdkName"); }, get description() { return i18n.t("servicesDirectory.sdkDescription"); }, categories: ["build"], status: "Developer preview", get tags() { return [i18n.t("servicesDirectory.tagSdk"), i18n.t("servicesDirectory.tagRust"), i18n.t("servicesDirectory.tagTypeScript")]; }, get action() { return i18n.t("servicesDirectory.sdkAction"); }, href: "https://github.com/firecash/zkas-rusty/tree/main/sdk", icon: "code" },
  { id: "core-source", get name() { return i18n.t("servicesDirectory.coreSourceName"); }, get description() { return i18n.t("servicesDirectory.coreSourceDescription"); }, categories: ["build", "verify"], status: "Live", get tags() { return [i18n.t("servicesDirectory.tagSource"), i18n.t("servicesDirectory.tagOpen"), i18n.t("servicesDirectory.tagRust")]; }, get action() { return i18n.t("servicesDirectory.coreSourceAction"); }, href: "https://github.com/firecash/zkas-rusty", icon: "git" },
  { id: "whitepaper", get name() { return i18n.t("servicesDirectory.whitepaperName"); }, get description() { return i18n.t("servicesDirectory.whitepaperDescription"); }, categories: ["build"], status: "Published", get tags() { return [i18n.t("servicesDirectory.tagDocumentation"), i18n.t("servicesDirectory.tagProtocol")]; }, get action() { return i18n.t("servicesDirectory.whitepaperAction"); }, href: "https://zkas.info/whitepaper.html", icon: "book" },
  { id: "community", get name() { return i18n.t("servicesDirectory.communityName"); }, get description() { return i18n.t("servicesDirectory.communityDescription"); }, categories: ["build"], status: "Open", get tags() { return [i18n.t("servicesDirectory.tagDiscord"), i18n.t("servicesDirectory.tagX"), i18n.t("servicesDirectory.tagSupport")]; }, get action() { return i18n.t("servicesDirectory.communityAction"); }, href: "https://discord.gg/jysMS4XNFT", icon: "users", secondary: [{ label: "X", href: "https://x.com/ZKas_X" }] },
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

/// Bundled services are a FLOOR, not just a fallback: the remote directory can
/// UPDATE or ADD entries (matched by id) but must never make a bundled one — such as
/// the "use" apps — silently vanish when the remote list drops it.
export function mergeWithBundled(remote: DirectoryService[]): DirectoryService[] {
  const byId = new Map<string, DirectoryService>();
  for (const svc of BUNDLED_SERVICES) byId.set(svc.id, svc);
  for (const svc of remote) byId.set(svc.id, svc);
  return [...byId.values()];
}

export function readCachedServices(storage: Storage | null = browserStorage()): DirectoryService[] | null {
  if (!storage) return null;
  try {
    const raw = storage.getItem(CACHE_KEY);
    if (!raw || raw.length > MAX_DOCUMENT_BYTES) return null;
    const svc = parseServicesDocument(JSON.parse(raw))?.services;
    return svc ? mergeWithBundled(svc) : null;
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
    return mergeWithBundled(document.services);
  } finally {
    window.clearTimeout(timer);
  }
}
