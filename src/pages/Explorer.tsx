import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { useTranslation } from "react-i18next";
import i18n from "../i18n";
import {
  explorerApi,
  type BlockdagInfo,
  type BlockDetail,
  type BlockSummary,
  type CoinSupplyInfo,
  type HalvingInfo,
  type NetworkInfo,
  type NodesInfo,
  type PulseInfo,
  type ShieldedPoolInfo,
  type TransactionDetail,
} from "../api/explorer";

const NetworkGlobe = lazy(() => import("../components/NetworkGlobe"));

type Dashboard = {
  dag: BlockdagInfo;
  network: NetworkInfo;
  shielded: ShieldedPoolInfo;
  halving: HalvingInfo;
  supply: CoinSupplyInfo;
  pulse: PulseInfo;
  blocks: BlockSummary[];
  nodes?: NodesInfo | null;
  savedAt: number;
};

const CACHE_KEY = "zkas_explorer_dashboard_v2";

/// Resolve to the value, or to null if the call failed. Lets one endpoint fail
/// without taking the rest of the dashboard with it.
function settled<T>(p: Promise<T>): Promise<T | null> {
  return p.then((v) => v).catch(() => null);
}

function cachedDashboard(): Dashboard | null {
  try {
    const value = JSON.parse(localStorage.getItem(CACHE_KEY) || "null") as Dashboard | null;
    return value?.dag && Array.isArray(value.blocks) ? value : null;
  } catch {
    return null;
  }
}

function short(value: string, width = 10): string {
  return value.length > width * 2 + 1 ? `${value.slice(0, width)}…${value.slice(-width)}` : value;
}

function integer(value: string | number): string {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? new Intl.NumberFormat().format(parsed) : String(value);
}

function zkasFromSompi(value: string): string {
  try {
    const sompi = BigInt(value);
    const whole = sompi / 100_000_000n;
    const fraction = (sompi % 100_000_000n).toString().padStart(8, "0").replace(/0+$/, "");
    return `${new Intl.NumberFormat().format(whole)}${fraction ? `.${fraction.slice(0, 2)}` : ""}`;
  } catch {
    return "—";
  }
}

function hashrate(value: number): string {
  const units = ["H/s", "KH/s", "MH/s", "GH/s", "TH/s", "PH/s", "EH/s"];
  let n = value;
  let i = 0;
  while (Math.abs(n) >= 1_000 && i < units.length - 1) {
    n /= 1_000;
    i += 1;
  }
  return `${n >= 100 ? n.toFixed(0) : n.toFixed(2)} ${units[i]}`;
}

function ago(timestamp: string | number): string {
  const raw = Number(timestamp);
  const ms = raw < 10_000_000_000 ? raw * 1_000 : raw;
  const seconds = Math.max(0, Math.floor((Date.now() - ms) / 1_000));
  if (seconds < 5) return i18n.t("explorer.now");
  if (seconds < 60) return i18n.t("explorer.secondsAgo", { n: seconds });
  if (seconds < 3_600) return i18n.t("explorer.minutesAgo", { n: Math.floor(seconds / 60) });
  return i18n.t("explorer.hoursAgo", { n: Math.floor(seconds / 3_600) });
}

function Sparkline({ values }: { values: number[] }) {
  const { t } = useTranslation();
  const path = useMemo(() => {
    const useful = values.filter(Number.isFinite);
    if (useful.length < 2) return "";
    const min = Math.min(...useful);
    const max = Math.max(...useful);
    const span = max - min || 1;
    return useful
      .map((v, i) => `${i ? "L" : "M"}${(i / (useful.length - 1)) * 300},${58 - ((v - min) / span) * 48}`)
      .join(" ");
  }, [values]);
  return (
    <svg className="explorer-spark" viewBox="0 0 300 64" role="img" aria-label={t("sparkline.aria")}>
      <path className="explorer-spark-grid" d="M0 58H300 M0 34H300 M0 10H300" />
      {path && <path className="explorer-spark-line" d={path} />}
    </svg>
  );
}

function DashboardView() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const [data, setData] = useState<Dashboard | null>(() => cachedDashboard());
  const dataRef = useRef(data);
  const fullRefreshInFlight = useRef(false);
  const blocksRefreshInFlight = useRef(false);
  const [error, setError] = useState("");
  const [refreshing, setRefreshing] = useState(false);
  const [activeNode, setActiveNode] = useState<string | null>(null);

  const refreshAll = useCallback(async () => {
    if (fullRefreshInFlight.current) return;
    fullRefreshInFlight.current = true;
    setRefreshing(true);
    try {
      // Settled, not all-or-nothing. With `Promise.all` a single endpoint hiccuping
      // threw away the other seven and left the ENTIRE dashboard on its last saved
      // snapshot — reported live, hours old. Each panel now keeps its own last good
      // value, so one sulking endpoint costs one panel instead of the screen.
      const [dag, network, shielded, halving, supply, pulse, blocks, nodes] = await Promise.all([
        settled(explorerApi.blockdag()),
        settled(explorerApi.network()),
        settled(explorerApi.shieldedPool()),
        settled(explorerApi.halving()),
        settled(explorerApi.coinSupply()),
        settled(explorerApi.pulse("1h")),
        settled(explorerApi.recentBlocks()),
        settled(explorerApi.nodes()),
      ]);
      const previous = dataRef.current;
      // Something has to have arrived, or there is no snapshot to speak of.
      const anyFresh = [dag, network, shielded, halving, supply, pulse, blocks].some((r) => r !== null);
      if (!anyFresh) {
        setError(previous ? t("dashboardView.liveUnavailable") : t("dashboardView.notResponding"));
        return;
      }
      const next: Dashboard = {
        dag: dag ?? previous!.dag,
        network: network ?? previous!.network,
        shielded: shielded ?? previous!.shielded,
        halving: halving ?? previous!.halving,
        supply: supply ?? previous!.supply,
        pulse: pulse ?? previous!.pulse,
        blocks: blocks ?? previous!.blocks,
        nodes: nodes ?? previous?.nodes ?? null,
        // Stamped only from data that actually arrived, so `savedAt` means "this is
        // how fresh the screen is" and the age shown to the user cannot flatter it.
        savedAt: Date.now(),
      };
      dataRef.current = next;
      setData(next);
      localStorage.setItem(CACHE_KEY, JSON.stringify(next));
      setError("");
    } catch {
      setError(dataRef.current ? t("dashboardView.liveUnavailable") : t("dashboardView.notResponding"));
    } finally {
      fullRefreshInFlight.current = false;
      setRefreshing(false);
    }
  }, [t]);

  // A snapshot older than a couple of poll intervals is not a live feed, and the
  // chrome around it must say so. Re-rendered by the poll, so it ages visibly
  // instead of freezing at whatever it said when the tab was opened.
  const [nowTick, setNowTick] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNowTick(Date.now()), 5_000);
    return () => window.clearInterval(timer);
  }, []);
  const snapshotAgeMs = data ? Math.max(0, nowTick - data.savedAt) : 0;
  const stale = !!data && snapshotAgeMs > 30_000;
  const ageLabel = ago(Math.floor(data ? data.savedAt / 1000 : 0));

  const globeNodes = useMemo(() => data?.nodes?.nodes.map((node) => ({ id: node.id, lat: node.lat, lon: node.lon, self: node.self, country: node.country })) ?? [], [data?.nodes]);
  const globeLabels = useMemo(() => data?.nodes?.countries.map((country) => ({ code: country.code, name: country.name, count: country.count, lat: country.lat, lon: country.lon })) ?? [], [data?.nodes]);
  const globeBlocks = useMemo(() => data?.blocks.map((block) => ({ hash: block.block_hash, blue: Number(block.blueScore) || 0, txs: block.txCount })) ?? [], [data?.blocks]);
  const selectedNode = data?.nodes?.nodes.find((node) => node.id === activeNode);

  const refreshBlocks = useCallback(async () => {
    if (blocksRefreshInFlight.current) return;
    blocksRefreshInFlight.current = true;
    try {
      const blocks = await explorerApi.recentBlocks();
      setData((previous) => {
        if (!previous) return previous;
        const next = { ...previous, blocks, savedAt: Date.now() };
        dataRef.current = next;
        return next;
      });
    } catch {
      // The slower full refresh owns the visible offline state.
    } finally {
      blocksRefreshInFlight.current = false;
    }
  }, []);

  useEffect(() => {
    void refreshAll();
    const blocks = window.setInterval(() => void refreshBlocks(), 2_000);
    const dashboard = window.setInterval(() => void refreshAll(), 15_000);
    return () => {
      clearInterval(blocks);
      clearInterval(dashboard);
    };
  }, [refreshAll, refreshBlocks]);

  return (
    <>
      <div className="control-heading">
        <div>
          <span className="eyebrow">{t("dashboardView.eyebrow")}</span>
          <h1>{t("dashboardView.title")}</h1>
          <p>{t("dashboardView.intro")}</p>
        </div>
        <span className={`status-pill ${data ? "good" : "warm"}`} title={refreshing ? t("dashboardView.updating") : data ? t("dashboardView.live") : t("dashboardView.offline")}>{refreshing ? t("dashboardView.updating") : data ? t("dashboardView.live") : t("dashboardView.offline")}</span>
      </div>

      <section className="explorer-live-hero" aria-label={t("dashboardView.heroAria")}>
        <iframe
          className="explorer-live-frame"
          src="https://explorer.zkas.info/live?embed=1"
          title={t("dashboardView.heroTitle")}
          loading="lazy"
          referrerPolicy="no-referrer"
          sandbox="allow-scripts allow-same-origin"
        />
        <a className="explorer-live-full" href="https://explorer.zkas.info/live" target="_blank" rel="noreferrer">{t("dashboardView.fullView")}</a>
      </section>
      {error && <div className="control-error">{error}</div>}
      {!data ? (
        <div className="control-card empty-state"><span className="spin" /> {t("dashboardView.connecting")}</div>
      ) : (
        <>
          <div className="explorer-metrics">
            <div className="metric"><span title={t("dashboardView.daaScore")}>{t("dashboardView.daaScore")}</span><strong>{integer(data.dag.virtualDaaScore)}</strong></div>
            <div className="metric"><span title={t("dashboardView.blockRate")}>{t("dashboardView.blockRate")}</span><strong>{t("dashboardView.bps", { bps: data.pulse.bps15m.toFixed(2) })}</strong></div>
            <div className="metric"><span title={t("dashboardView.estHashrate")}>{t("dashboardView.estHashrate")}</span><strong>{hashrate(data.dag.difficulty * 2)}</strong></div>
            <div className="metric"><span title={t("dashboardView.connectedPeers")}>{t("dashboardView.connectedPeers")}</span><strong>{integer(data.network.connectedPeers)}</strong></div>
          </div>

          <section className="control-card explorer-map-card">
            <div className="card-title-row">
              <div><h2>{t("dashboardView.liveNetwork")}</h2><p>{data.nodes ? t("dashboardView.nodesCountries", { nodes: integer(data.nodes.totals.nodes), countries: integer(data.nodes.totals.countries) }) : t("dashboardView.peerMapUnavailable")}</p></div>
              <a className="text-button" href="https://explorer.zkas.info/map" target="_blank" rel="noreferrer">{t("dashboardView.fullMap")}</a>
            </div>
            <div className="explorer-globe-stage">
              {data.nodes ? <Suspense fallback={<div className="explorer-globe-loading"><span className="spin" /></div>}><NetworkGlobe nodes={globeNodes} labels={globeLabels} blocks={globeBlocks} activeId={activeNode} onHover={(id) => setActiveNode(id)} onSelect={setActiveNode} onNavigate={(to) => navigate(to.replace("/blocks/", "/explore/block/").replace("/transactions/", "/explore/tx/"))} /></Suspense> : <div className="explorer-globe-loading">{t("dashboardView.mapUnavailable")}</div>}
              {selectedNode && <div className="explorer-node-tip"><b>{selectedNode.countryName ?? t("dashboardView.unknownLocation")}</b><span>{selectedNode.self ? t("dashboardView.explorerNode") : t("dashboardView.connectedPeer")}</span></div>}
            </div>
          </section>

          <div className="control-card explorer-work-card">
            <div className="card-title-row">
              <div><h2>{t("dashboardView.networkWork")}</h2><p>{t("dashboardView.trailingHour", { hashrate: hashrate(data.pulse.workHashrateBins[data.pulse.workHashrateBins.length - 1] || data.dag.difficulty * 2) })}</p></div>
            </div>
            <Sparkline values={data.pulse.workHashrateBins} />
          </div>

          <div className="explorer-columns">
            <section className="control-card">
              {/* The badge reports what is on screen, not what the page intends. It
                  said "live" unconditionally, so a snapshot that had not refreshed in
                  hours — every block stamped "17h ago" — still presented itself as a
                  live feed. A stale screen is recoverable; a stale screen insisting it
                  is current is not, because nobody thinks to reload it. */}
              <div className="card-title-row">
                <div><h2>{t("dashboardView.latestBlocks")}</h2><p>{stale ? t("dashboardView.lastUpdated", { age: ageLabel }) : t("dashboardView.updatesEvery")}</p></div>
                <span className={stale ? "status-pill" : "live-dot"}>{stale ? ageLabel : t("dashboardView.liveDot")}</span>
              </div>
              <div className="explorer-list">
                {data.blocks.slice(0, 12).map((block) => (
                  <button key={block.block_hash} onClick={() => navigate(`/explore/block/${block.block_hash}`)}>
                    <span><b>{t("dashboardView.blueScore", { score: integer(block.blueScore) })}</b><small className="mono">{short(block.block_hash, 7)}</small></span>
                    <span><b>{t("dashboardView.txCount", { n: block.txCount })}</b><small>{ago(block.timestamp)}</small></span>
                  </button>
                ))}
              </div>
            </section>

            <aside>
              <section className="control-card">
                <h2>{t("dashboardView.mandatoryPrivacy")}</h2>
                <div className="detail-row"><span className="k">{t("dashboardView.shieldedNotes")}</span><span className="v">{integer(data.shielded.noteCount)}</span></div>
                <div className="detail-row"><span className="k">{t("dashboardView.privateSpends")}</span><span className="v">{integer(data.shielded.nullifierCount)}</span></div>
                <div className="detail-row"><span className="k">{t("dashboardView.currentAnchor")}</span><span className="v mono">{data.shielded.anchor ? short(data.shielded.anchor, 7) : t("dashboardView.building")}</span></div>
              </section>
              <section className="control-card">
                <h2>{t("dashboardView.supply")}</h2>
                <div className="detail-row"><span className="k">{t("dashboardView.inCirculation")}</span><span className="v">{t("dashboardView.amountZkas", { amount: zkasFromSompi(data.supply.circulatingSupply) })}</span></div>
                <div className="detail-row"><span className="k">{t("dashboardView.blockEmission")}</span><span className="v">{t("dashboardView.amountZkas", { amount: data.shielded.emissionPerBlock })}</span></div>
                <div className="detail-row"><span className="k">{t("dashboardView.nextReduction")}</span><span className="v">{data.halving.nextHalvingDate}</span></div>
                <p className="subtle explorer-note">{t("dashboardView.tailNote")}</p>
              </section>
            </aside>
          </div>
        </>
      )}
    </>
  );
}

function BlockView({ id }: { id: string }) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const [block, setBlock] = useState<BlockDetail | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    setBlock(null);
    setError("");
    explorerApi.block(id).then(setBlock).catch((e) => setError((e as Error).message));
  }, [id]);
  return (
    <DetailShell title={t("blockView.title")} id={id} error={error}>
      {block && (
        <>
          <div className="explorer-metrics">
            <div className="metric"><span title={t("blockView.blueScore")}>{t("blockView.blueScore")}</span><strong>{integer(block.header.blueScore)}</strong></div>
            <div className="metric"><span title={t("blockView.daaScore")}>{t("blockView.daaScore")}</span><strong>{integer(block.header.daaScore)}</strong></div>
            <div className="metric"><span title={t("blockView.transactions")}>{t("blockView.transactions")}</span><strong>{block.verboseData.transactionIds.length}</strong></div>
            <div className="metric"><span title={t("blockView.chainBlock")}>{t("blockView.chainBlock")}</span><strong>{block.verboseData.isChainBlock ? t("blockView.yes") : t("blockView.no")}</strong></div>
          </div>
          <section className="control-card">
            <div className="detail-row"><span className="k">{t("blockView.timestamp")}</span><span className="v">{new Date(block.header.timestamp).toLocaleString()}</span></div>
            <div className="detail-row"><span className="k">{t("blockView.difficulty")}</span><span className="v mono">{block.verboseData.difficulty.toPrecision(8)}</span></div>
            <div className="detail-row"><span className="k">{t("blockView.selectedParent")}</span><button className="text-button mono v" onClick={() => navigate(`/explore/block/${block.verboseData.selectedParentHash}`)}>{short(block.verboseData.selectedParentHash, 12)}</button></div>
            <div className="detail-row"><span className="k">{t("blockView.nonce")}</span><span className="v mono">{block.header.nonce}</span></div>
          </section>
          <section className="control-card">
            <h2>{t("blockView.transactionsHeading")}</h2>
            <div className="explorer-list">
              {block.verboseData.transactionIds.map((txid, index) => (
                <button key={txid} onClick={() => navigate(`/explore/tx/${txid}`)}>
                  <span><b>{index === 0 ? t("blockView.coinbase") : t("blockView.shieldedTransaction")}</b><small className="mono">{short(txid, 10)}</small></span><span>›</span>
                </button>
              ))}
            </div>
          </section>
        </>
      )}
    </DetailShell>
  );
}

function TransactionView({ id }: { id: string }) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const [tx, setTx] = useState<TransactionDetail | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    setTx(null);
    setError("");
    explorerApi.transaction(id).then(setTx).catch((e) => setError((e as Error).message));
  }, [id]);
  return (
    <DetailShell title={t("transactionView.title")} id={id} error={error}>
      {tx && (
        <>
          <div className="explorer-metrics">
            <div className="metric"><span title={t("transactionView.status")}>{t("transactionView.status")}</span><strong>{tx.is_accepted ? t("transactionView.confirmed") : t("transactionView.pending")}</strong></div>
            <div className="metric"><span title={t("transactionView.confirmations")}>{t("transactionView.confirmations")}</span><strong>{integer(tx.confirmations)}</strong></div>
            <div className="metric"><span title={t("transactionView.blueScore")}>{t("transactionView.blueScore")}</span><strong>{integer(tx.accepting_block_blue_score)}</strong></div>
            <div className="metric"><span title={t("transactionView.mass")}>{t("transactionView.mass")}</span><strong>{integer(tx.mass)}</strong></div>
          </div>
          <section className="control-card privacy-explainer">
            <h2>{t("transactionView.privateTitle")}</h2>
            <p>{t("transactionView.privateNote")}</p>
          </section>
          {tx.accepting_block_hash && (
            <section className="control-card">
              <div className="detail-row"><span className="k">{t("transactionView.acceptedIn")}</span><button className="text-button mono v" onClick={() => navigate(`/explore/block/${tx.accepting_block_hash}`)}>{short(tx.accepting_block_hash, 12)}</button></div>
              <div className="detail-row"><span className="k">{t("transactionView.time")}</span><span className="v">{new Date(tx.block_time).toLocaleString()}</span></div>
              <div className="detail-row"><span className="k">{t("transactionView.visibility")}</span><span className="v">{t("transactionView.hidden")}</span></div>
            </section>
          )}
        </>
      )}
    </DetailShell>
  );
}

function AddressView({ id }: { id: string }) {
  const { t } = useTranslation();
  const valid = /^(zkas|firecash):[a-z0-9]{50,100}$/i.test(id);
  return (
    <DetailShell title={t("addressView.title")} id={id} error={valid ? "" : t("addressView.invalid")}>
      {valid && (
        <section className="control-card privacy-explainer">
          <h2>{t("addressView.noPublic")}</h2>
          <p>{t("addressView.noPublicNote")}</p>
          <div className="detail-row"><span className="k">{t("addressView.network")}</span><span className="v">{t("addressView.mainnet")}</span></div>
          <div className="detail-row"><span className="k">{t("addressView.privacy")}</span><span className="v">{t("addressView.mandatory")}</span></div>
        </section>
      )}
    </DetailShell>
  );
}

function DetailShell({ title, id, error, children }: { title: string; id: string; error: string; children: React.ReactNode }) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  return (
    <>
      <button className="pane-back" onClick={() => navigate("/explore")}>{t("detailShell.back")}</button>
      <div className="control-heading explorer-detail-heading">
        <div><span className="eyebrow">{title}</span><h1>{short(id, 13)}</h1><p className="mono explorer-full-id">{id}</p></div>
      </div>
      {error && <div className="control-error">{error}</div>}
      {!error && !children && <div className="control-card empty-state"><span className="spin" /> {t("detailShell.loading")}</div>}
      {children}
    </>
  );
}

export function Explorer() {
  const { kind, id } = useParams();
  return (
    <main className="control-page explorer-page">
      {!kind || !id ? <DashboardView /> : kind === "block" ? <BlockView id={id} /> : kind === "tx" ? <TransactionView id={id} /> : kind === "address" ? <AddressView id={decodeURIComponent(id)} /> : <DashboardView />}
    </main>
  );
}
