import { useEffect, useMemo, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
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
} from "../services-directory";

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
  "mining-pools": "/mine",
  "node-solo-mining": "/node",
};

/// Where the directory opens when the user has not asked for anything specific.
const DEFAULT_CATEGORY: "all" | Category = "use";

const CATEGORIES: { id: "all" | Category; label: string }[] = [
  { id: "all", label: "All" },
  { id: "store", label: "Store" },
  { id: "use", label: "Use" },
  { id: "earn", label: "Earn" },
  { id: "verify", label: "Verify" },
  { id: "build", label: "Build" },
];

export function Services() {
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
    const internalRoute = INTERNAL_ROUTES[service.id];
    if (internalRoute) navigate(internalRoute);
    else window.open(service.href, "_blank", "noopener,noreferrer");
  };
  return (
    <main className="control-page services-page">
      <div className="services-controls">
        <div className="services-filters" role="group" aria-label="Filter services">
          {CATEGORIES.map((item) => {
            const count = item.id === "all" ? services.length : services.filter((service) => service.categories.includes(item.id as Category)).length;
            return <button key={item.id} className={effective === item.id ? "active" : ""} onClick={() => choose(item.id)}>{item.label} <span>{count}</span></button>;
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
                <span className="service-meta"><span className={`service-status ${["Live", "Available", "Published", "Open"].includes(service.status) ? "live" : "testing"}`}>{service.status}</span><span className="service-category">{service.categories.join(" · ")}</span></span>
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
      {shown.length === 0 && <div className="control-card empty-state">No matching services.</div>}
    </main>
  );
}
