import { useMemo, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import {
  BookOpen,
  Code2,
  CreditCard,
  FileKey,
  GitFork,
  Pickaxe,
  QrCode,
  ScanSearch,
  Server,
  SquareTerminal,
  Users,
  WalletCards,
  type LucideIcon,
} from "lucide-react";

type Category = "store" | "use" | "earn" | "verify" | "build";
type Status = "Live" | "Testing" | "Developer preview";

type Service = {
  name: string;
  description: string;
  categories: Category[];
  status: Status;
  tags: string[];
  action: string;
  href: string;
  internal?: boolean;
  secondary?: { label: string; href: string }[];
  icon: LucideIcon;
};

const SERVICES: Service[] = [
  { name: "Wallet", description: "Send, receive, back up, and manage ZKAS.", categories: ["store", "use"], status: "Live", tags: ["Local key", "Private payments"], action: "Open wallet", href: "/", internal: true, icon: WalletCards },
  { name: "CLI & self-hosted wallet", description: "Run walletd or shielded-pay on your own machine.", categories: ["store", "build"], status: "Live", tags: ["Self-hosted", "CLI + API"], action: "Wallet tools", href: "https://github.com/firecash/zkas-rusty#wallet", icon: SquareTerminal },
  { name: "Paper wallet", description: "Create a recovery key offline for cold storage.", categories: ["store"], status: "Live", tags: ["Offline", "Cold storage"], action: "Create paper wallet", href: "https://zkas.info/paper-wallet.html", icon: FileKey },
  { name: "BlockDAG explorer", description: "Inspect public blocks and shielded transactions.", categories: ["verify"], status: "Live", tags: ["Live chain", "No public balances"], action: "Open explorer", href: "/explore", internal: true, icon: ScanSearch },
  { name: "Mining pools", description: "Compare pools and mine ZKAS with kHeavyHash hardware.", categories: ["earn"], status: "Live", tags: ["ASIC", "Merged mining"], action: "Open mining", href: "/mine", internal: true, icon: Pickaxe, secondary: [
    { label: "ZKas Pool", href: "https://mining-pool.zkas.info" },
    { label: "K1Pool", href: "https://k1pool.com" },
    { label: "Rusty Kaspa Bridge", href: "https://bridge.rustykaspa.org" },
    { label: "KekPool", href: "https://kekpool.com" },
    { label: "CoreBlock", href: "https://coreblock.cc" },
  ] },
  { name: "Node & solo mining", description: "Verify the chain and mine directly to your address.", categories: ["earn", "verify"], status: "Live", tags: ["Self-verified", "Direct payout"], action: "Run a node", href: "/node", internal: true, icon: Server },
  { name: "Payment requests & POS", description: "Create payment QR codes and accept ZKAS in person.", categories: ["use"], status: "Live", tags: ["QR", "Point of sale"], action: "Accept payment", href: "/tools?tab=request", internal: true, icon: QrCode },
  { name: "Payment gateway", description: "Merchant invoices, checkout pages, and webhooks.", categories: ["use", "build"], status: "Testing", tags: ["Self-hosted", "WooCommerce"], action: "Gateway project", href: "https://github.com/firecash/zkas-payment-gateway", icon: CreditCard },
  { name: "ZKAS SDK", description: "TypeScript and Rust libraries for wallet integrations.", categories: ["build"], status: "Developer preview", tags: ["TypeScript", "Rust"], action: "Open SDK", href: "https://github.com/firecash/zkas-rusty/tree/main/sdk", icon: Code2 },
  { name: "Core source", description: "Node, consensus, wallet, and mining source code.", categories: ["build", "verify"], status: "Live", tags: ["Open source", "Rust"], action: "View source", href: "https://github.com/firecash/zkas-rusty", icon: GitFork },
  { name: "Whitepaper", description: "Protocol, privacy, consensus, and economics.", categories: ["build", "verify"], status: "Live", tags: ["Protocol", "Documentation"], action: "Read whitepaper", href: "https://zkas.info/whitepaper.html", icon: BookOpen },
  { name: "Community", description: "Support, network updates, and discussion.", categories: ["use", "build"], status: "Live", tags: ["Discord", "X"], action: "Open Discord", href: "https://discord.gg/jysMS4XNFT", icon: Users, secondary: [{ label: "X", href: "https://x.com/ZKas_X" }] },
];

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
  const initial = params.get("filter");
  const [category, setCategoryState] = useState<"all" | Category>(CATEGORIES.some((item) => item.id === initial) ? (initial as "all" | Category) : "all");
  const shown = useMemo(
    () => SERVICES.filter((service) => category === "all" || service.categories.includes(category)),
    [category],
  );
  const choose = (next: "all" | Category) => {
    setCategoryState(next);
    setParams(next === "all" ? {} : { filter: next }, { replace: true });
  };
  const open = (service: Service) => {
    if (service.internal) navigate(service.href);
    else window.open(service.href, "_blank", "noopener,noreferrer");
  };
  return (
    <main className="control-page services-page">
      <div className="services-controls">
        <div className="services-filters" role="group" aria-label="Filter services">
          {CATEGORIES.map((item) => {
            const count = item.id === "all" ? SERVICES.length : SERVICES.filter((service) => service.categories.includes(item.id as Category)).length;
            return <button key={item.id} className={category === item.id ? "active" : ""} onClick={() => choose(item.id)}>{item.label} <span>{count}</span></button>;
          })}
        </div>
      </div>
      <div className="services-grid">
        {shown.map((service) => {
          const Icon = service.icon;
          return (
            <article className="service-card" key={service.name}>
              <div className="card-title-row">
                <span className="service-icon" aria-hidden="true"><Icon size={21} strokeWidth={1.8} /></span>
                <span className="service-meta"><span className={`service-status ${service.status === "Live" ? "live" : "testing"}`}>{service.status}</span><span className="service-category">{service.categories.join(" · ")}</span></span>
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
