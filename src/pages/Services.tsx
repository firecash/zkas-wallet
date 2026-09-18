import { useEffect, useMemo, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { useTranslation } from "react-i18next";
import {
  BookOpen,
  Bot,
  Code2,
  CreditCard,
  FileKey,
  GitFork,
  Pickaxe,
  ScanSearch,
  Server,
  SquareTerminal,
  Users,
  WalletCards,
  type LucideIcon,
} from "lucide-react";
import {
  BUNDLED_SERVICES,
  readCachedServices,
  refreshServicesDirectory,
  type DirectoryService,
  type ServiceCategory,
  type ServiceIcon,
  type ServiceStatus,
} from "../services-directory";
import { isDesktop } from "../desktop";
import i18n from "../i18n";

type Category = ServiceCategory;

const ICONS: Record<ServiceIcon, LucideIcon> = {
  bot: Bot,
  book: BookOpen,
  code: Code2,
  "credit-card": CreditCard,
  "file-key": FileKey,
  git: GitFork,
  pickaxe: Pickaxe,
  search: ScanSearch,
  server: Server,
  terminal: SquareTerminal,
  users: Users,
  wallet: WalletCards,
};

// Known ZKAS tools open inside the app. This mapping is bundled rather than
// accepted from the remote directory, so remote data cannot invent app routes.
const INTERNAL_ROUTES: Record<string, string> = {
  "web-wallet": "/",
  explorer: "/explore",
};
// Mining and node supervision are pages only the desktop shell can act on; on a
// phone or the web they render a "Get the desktop app" dead end, so those cards
// open the directory's own page instead.
const DESKTOP_ROUTES: Record<string, string> = {
  "mining-pools": "/mine",
  "node-solo-mining": "/node",
};

/// Where the directory opens when the user has not asked for anything specific.
const DEFAULT_CATEGORY: "all" | Category = "use";

// Labels are functions: the catalogue for a non-English language arrives after
// this module has loaded, so the text must be looked up at render time.
const CATEGORIES: { id: "all" | Category; label: () => string }[] = [
  { id: "all", label: () => i18n.t("services.catAll") },
  { id: "store", label: () => i18n.t("services.catStore") },
  { id: "use", label: () => i18n.t("services.catUse") },
  { id: "earn", label: () => i18n.t("services.catEarn") },
  { id: "verify", label: () => i18n.t("services.catVerify") },
  { id: "build", label: () => i18n.t("services.catBuild") },
];

// Status and category values are validated enum tokens (shared with the remote
// directory), so they are looked up at render time, not translated where stored.
const STATUS_LABELS: Record<ServiceStatus, () => string> = {
  Live: () => i18n.t("services.statusLive"),
  Testing: () => i18n.t("services.statusTesting"),
  "Developer preview": () => i18n.t("services.statusDeveloperPreview"),
  Available: () => i18n.t("services.statusAvailable"),
  Published: () => i18n.t("services.statusPublished"),
  Open: () => i18n.t("services.statusOpen"),
};
const CATEGORY_LABELS: Record<Category, () => string> = {
  store: () => i18n.t("services.categoryStore"),
  use: () => i18n.t("services.categoryUse"),
  earn: () => i18n.t("services.categoryEarn"),
  verify: () => i18n.t("services.categoryVerify"),
  build: () => i18n.t("services.categoryBuild"),
};

export function Services() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const [services, setServices] = useState<DirectoryService[]>(() => readCachedServices() ?? BUNDLED_SERVICES);
  const initial = params.get("filter");
  const linked = CATEGORIES.some((item) => item.id === initial) ? (initial as "all" | Category) : null;
  // This is the wallet's action directory, so lead with things a holder can
  // actually use. Explicit deep links such as ?filter=store still win.
  const [category, setCategoryState] = useState<"all" | Category>(linked ?? DEFAULT_CATEGORY);
  // Only a landing category chosen for the user is corrected; a category the user
  // clicked, or asked for by link, keeps its honest empty state.
  const [chosen, setChosen] = useState(linked !== null);
  useEffect(() => {
    setCategoryState(linked ?? DEFAULT_CATEGORY);
    setChosen(linked !== null);
  }, [linked]);
  useEffect(() => {
    let active = true;
    refreshServicesDirectory()
      .then((updated) => { if (active) setServices(updated); })
      .catch(() => { /* keep the last validated or bundled directory */ });
    return () => { active = false; };
  }, []);
  // The directory is remotely updatable, so the landing category can legitimately
  // hold nothing — and an empty page is indistinguishable from a broken one. Fall
  // back to the whole directory rather than opening on "No matching services."
  const effective = useMemo(() => {
    if (chosen || category === "all") return category;
    return services.some((service) => service.categories.includes(category)) ? category : "all";
  }, [category, chosen, services]);
  const shown = useMemo(
    () => services.filter((service) => effective === "all" || service.categories.includes(effective)),
    [effective, services],
  );
  const choose = (next: "all" | Category) => {
    setCategoryState(next);
    setChosen(true);
    setParams(next === "all" ? {} : { filter: next }, { replace: true });
  };
  const open = (service: DirectoryService) => {
    const internalRoute = INTERNAL_ROUTES[service.id] ?? (isDesktop() ? DESKTOP_ROUTES[service.id] : undefined);
    if (internalRoute) navigate(internalRoute);
    // The desktop WebView has no window.open target, so the click went nowhere;
    // hand the URL to the system browser through the shell's opener plugin.
    else if (isDesktop()) void import("@tauri-apps/plugin-opener").then(({ openUrl }) => openUrl(service.href)).catch(() => {});
    else window.open(service.href, "_blank", "noopener,noreferrer");
  };
  return (
    <main className="control-page services-page">
      <div className="services-controls">
        <div className="services-filters" role="group" aria-label={t("services.filterAria")}>
          {CATEGORIES.map((item) => {
            const count = item.id === "all" ? services.length : services.filter((service) => service.categories.includes(item.id as Category)).length;
            return <button key={item.id} className={effective === item.id ? "active" : ""} onClick={() => choose(item.id)}>{item.label()} <span>{count}</span></button>;
          })}
        </div>
      </div>
      <div className="services-grid">
        {shown.map((service) => {
          const Icon = ICONS[service.icon];
          return (
            <article className="service-card" key={service.id}>
              <div className="card-title-row">
                <span className="service-icon" aria-hidden="true"><Icon size={21} strokeWidth={1.8} /></span>
                <span className="service-meta"><span className={`service-status ${["Live", "Available", "Published", "Open"].includes(service.status) ? "live" : "testing"}`} title={STATUS_LABELS[service.status]()}>{STATUS_LABELS[service.status]()}</span><span className="service-category">{service.categories.map((category) => CATEGORY_LABELS[category]()).join(" · ")}</span></span>
              </div>
              <h2>{service.name}</h2>
              <p>{service.description}</p>
              <div className="service-tags">{service.tags.map((tag) => <span key={tag}>{tag}</span>)}</div>
              <button className="service-action" onClick={() => open(service)}>{service.action}<span>→</span></button>
              {service.secondary && <div className="service-secondary">{service.secondary.map((item) => <a key={item.label} href={item.href} target="_blank" rel="noreferrer">{item.label} ↗</a>)}</div>}
            </article>
          );
        })}
      </div>
      {shown.length === 0 && <div className="control-card empty-state">{t("services.noMatching")}</div>}
    </main>
  );
}
