import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useLocation, useNavigate, useParams } from "react-router-dom";
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
  if (seconds < 5) return "now";
  if (seconds < 60) return `${seconds}s ago`;
  if (seconds < 3_600) return `${Math.floor(seconds / 60)}m ago`;
  return `${Math.floor(seconds / 3_600)}h ago`;
}

function Sparkline({ values }: { values: number[] }) {
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
    <svg className="explorer-spark" viewBox="0 0 300 64" role="img" aria-label="Recent network work">
      <path className="explorer-spark-grid" d="M0 58H300 M0 34H300 M0 10H300" />
      {path && <path className="explorer-spark-line" d={path} />}
    </svg>
  );
}

function DashboardView() {
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
        setError(previous ? "Live data is temporarily unavailable. Showing the last saved snapshot." : "The explorer API is not responding.");
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
      setError(dataRef.current ? "Live data is temporarily unavailable. Showing the last saved snapshot." : "The explorer API is not responding.");
    } finally {
      fullRefreshInFlight.current = false;
      setRefreshing(false);
    }
  }, []);

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
          <span className="eyebrow">BlockDAG explorer</span>
          <h1>Network</h1>
          <p>Public chain facts. Payment details remain private.</p>
        </div>
        <span className={`status-pill ${data ? "good" : "warm"}`}>{refreshing ? "Updating" : data ? "Live" : "Offline"}</span>
      </div>
      {error && <div className="control-error">{error}</div>}
      {!data ? (
        <div className="control-card empty-state"><span className="spin" /> Connecting to the explorer…</div>
      ) : (
        <>
          <div className="explorer-metrics">
            <div className="metric"><span>DAA score</span><strong>{integer(data.dag.virtualDaaScore)}</strong></div>
            <div className="metric"><span>Block rate · 15m</span><strong>{data.pulse.bps15m.toFixed(2)} BPS</strong></div>
            <div className="metric"><span>Est. hashrate</span><strong>{hashrate(data.dag.difficulty * 2)}</strong></div>
            <div className="metric"><span>Connected peers</span><strong>{integer(data.network.connectedPeers)}</strong></div>
          </div>

          <button type="button" className="control-card explorer-live-teaser" onClick={() => navigate("/explore/live")}>
            <div>
              <h2>Shielded Pool · Live</h2>
              <p>Watch private coins drop into the shielded pool in real time — amounts stay hidden.</p>
            </div>
            <span className="text-button">Open live view →</span>
          </button>

          <section className="control-card explorer-map-card">
            <div className="card-title-row">
              <div><h2>Live network</h2><p>{data.nodes ? `${integer(data.nodes.totals.nodes)} nodes · ${integer(data.nodes.totals.countries)} countries` : "Peer map unavailable"}</p></div>
              <a className="text-button" href="https://explorer.zkas.info/map" target="_blank" rel="noreferrer">Full map ↗</a>
            </div>
            <div className="explorer-globe-stage">
              {data.nodes ? <Suspense fallback={<div className="explorer-globe-loading"><span className="spin" /></div>}><NetworkGlobe nodes={globeNodes} labels={globeLabels} blocks={globeBlocks} activeId={activeNode} onHover={(id) => setActiveNode(id)} onSelect={setActiveNode} onNavigate={(to) => navigate(to.replace("/blocks/", "/explore/block/").replace("/transactions/", "/explore/tx/"))} /></Suspense> : <div className="explorer-globe-loading">Map data is temporarily unavailable.</div>}
              {selectedNode && <div className="explorer-node-tip"><b>{selectedNode.countryName ?? "Unknown location"}</b><span>{selectedNode.self ? "Explorer node" : "Connected peer"}</span></div>}
            </div>
          </section>

          <div className="control-card explorer-work-card">
            <div className="card-title-row">
              <div><h2>Network work</h2><p>Trailing hour · {hashrate(data.pulse.workHashrateBins[data.pulse.workHashrateBins.length - 1] || data.dag.difficulty * 2)}</p></div>
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
                <div><h2>Latest blocks</h2><p>{stale ? `Last updated ${ageLabel}.` : "Updates every two seconds."}</p></div>
                <span className={stale ? "status-pill" : "live-dot"}>{stale ? ageLabel : "live"}</span>
              </div>
              <div className="explorer-list">
                {data.blocks.slice(0, 12).map((block) => (
                  <button key={block.block_hash} onClick={() => navigate(`/explore/block/${block.block_hash}`)}>
                    <span><b>Blue score {integer(block.blueScore)}</b><small className="mono">{short(block.block_hash, 7)}</small></span>
                    <span><b>{block.txCount} tx</b><small>{ago(block.timestamp)}</small></span>
                  </button>
                ))}
              </div>
            </section>

            <aside>
              <section className="control-card">
                <h2>Mandatory privacy</h2>
                <div className="detail-row"><span className="k">Shielded notes</span><span className="v">{integer(data.shielded.noteCount)}</span></div>
                <div className="detail-row"><span className="k">Private spends</span><span className="v">{integer(data.shielded.nullifierCount)}</span></div>
                <div className="detail-row"><span className="k">Current anchor</span><span className="v mono">{data.shielded.anchor ? short(data.shielded.anchor, 7) : "building"}</span></div>
              </section>
              <section className="control-card">
                <h2>Supply</h2>
                <div className="detail-row"><span className="k">In circulation</span><span className="v">{zkasFromSompi(data.supply.circulatingSupply)} ZKAS</span></div>
                <div className="detail-row"><span className="k">Block emission</span><span className="v">{data.shielded.emissionPerBlock} ZKAS</span></div>
                <div className="detail-row"><span className="k">Next reduction</span><span className="v">{data.halving.nextHalvingDate}</span></div>
                <p className="subtle explorer-note">The schedule ends in a permanent tail emission; it has no fixed terminal supply.</p>
              </section>
            </aside>
          </div>
        </>
      )}
    </>
  );
}

function BlockView({ id }: { id: string }) {
  const navigate = useNavigate();
  const [block, setBlock] = useState<BlockDetail | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    setBlock(null);
    setError("");
    explorerApi.block(id).then(setBlock).catch((e) => setError((e as Error).message));
  }, [id]);
  return (
    <DetailShell title="Block" id={id} error={error}>
      {block && (
        <>
          <div className="explorer-metrics">
            <div className="metric"><span>Blue score</span><strong>{integer(block.header.blueScore)}</strong></div>
            <div className="metric"><span>DAA score</span><strong>{integer(block.header.daaScore)}</strong></div>
            <div className="metric"><span>Transactions</span><strong>{block.verboseData.transactionIds.length}</strong></div>
            <div className="metric"><span>Chain block</span><strong>{block.verboseData.isChainBlock ? "Yes" : "No"}</strong></div>
          </div>
          <section className="control-card">
            <div className="detail-row"><span className="k">Timestamp</span><span className="v">{new Date(block.header.timestamp).toLocaleString()}</span></div>
            <div className="detail-row"><span className="k">Difficulty</span><span className="v mono">{block.verboseData.difficulty.toPrecision(8)}</span></div>
            <div className="detail-row"><span className="k">Selected parent</span><button className="text-button mono v" onClick={() => navigate(`/explore/block/${block.verboseData.selectedParentHash}`)}>{short(block.verboseData.selectedParentHash, 12)}</button></div>
            <div className="detail-row"><span className="k">Nonce</span><span className="v mono">{block.header.nonce}</span></div>
          </section>
          <section className="control-card">
            <h2>Transactions</h2>
            <div className="explorer-list">
              {block.verboseData.transactionIds.map((txid, index) => (
                <button key={txid} onClick={() => navigate(`/explore/tx/${txid}`)}>
                  <span><b>{index === 0 ? "Coinbase" : "Shielded transaction"}</b><small className="mono">{short(txid, 10)}</small></span><span>›</span>
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
  const navigate = useNavigate();
  const [tx, setTx] = useState<TransactionDetail | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    setTx(null);
    setError("");
    explorerApi.transaction(id).then(setTx).catch((e) => setError((e as Error).message));
  }, [id]);
  return (
    <DetailShell title="Transaction" id={id} error={error}>
      {tx && (
        <>
          <div className="explorer-metrics">
            <div className="metric"><span>Status</span><strong>{tx.is_accepted ? "Confirmed" : "Pending"}</strong></div>
            <div className="metric"><span>Confirmations</span><strong>{integer(tx.confirmations)}</strong></div>
            <div className="metric"><span>Blue score</span><strong>{integer(tx.accepting_block_blue_score)}</strong></div>
            <div className="metric"><span>Mass</span><strong>{integer(tx.mass)}</strong></div>
          </div>
          <section className="control-card privacy-explainer">
            <h2>Payment details are private</h2>
            <p>The public chain proves this transaction is valid. It does not reveal the sender, recipient, or transferred amount.</p>
          </section>
          {tx.accepting_block_hash && (
            <section className="control-card">
              <div className="detail-row"><span className="k">Accepted in</span><button className="text-button mono v" onClick={() => navigate(`/explore/block/${tx.accepting_block_hash}`)}>{short(tx.accepting_block_hash, 12)}</button></div>
              <div className="detail-row"><span className="k">Time</span><span className="v">{new Date(tx.block_time).toLocaleString()}</span></div>
              <div className="detail-row"><span className="k">Visibility</span><span className="v">Payment contents hidden</span></div>
            </section>
          )}
        </>
      )}
    </DetailShell>
  );
}

function AddressView({ id }: { id: string }) {
  const valid = /^(zkas|firecash):[a-z0-9]{50,100}$/i.test(id);
  return (
    <DetailShell title="Shielded address" id={id} error={valid ? "" : "This is not a valid-looking ZKAS address."}>
      {valid && (
        <section className="control-card privacy-explainer">
          <h2>No public balance or history</h2>
          <p>ZKAS addresses do not have transparent explorer pages. Only the holder's viewing key can discover received notes, amounts, and transaction history.</p>
          <div className="detail-row"><span className="k">Network</span><span className="v">ZKAS mainnet</span></div>
          <div className="detail-row"><span className="k">Privacy</span><span className="v">Mandatory</span></div>
        </section>
      )}
    </DetailShell>
  );
}

function DetailShell({ title, id, error, children }: { title: string; id: string; error: string; children: React.ReactNode }) {
  const navigate = useNavigate();
  return (
    <>
      <button className="pane-back" onClick={() => navigate("/explore")}>← Network</button>
      <div className="control-heading explorer-detail-heading">
        <div><span className="eyebrow">{title}</span><h1>{short(id, 13)}</h1><p className="mono explorer-full-id">{id}</p></div>
      </div>
      {error && <div className="control-error">{error}</div>}
      {!error && !children && <div className="control-card empty-state"><span className="spin" /> Loading…</div>}
      {children}
    </>
  );
}

/// The live shielded-pool visualisation. It is maintained in the explorer (a canvas
/// animation of private coins dropping into the pool), so the wallet EMBEDS it rather
/// than duplicating ~600 lines — one source of truth, always in sync. The explorer page
/// talks to its own public API and sets no framing restriction; the wallet only needs to
/// allow it in `frame-src` (web nginx CSP + the desktop tauri CSP). Needs a connection;
/// offline it simply shows nothing but its own frame, and "Full screen" opens it directly.
const LIVE_URL = "https://explorer.zkas.info/live";

function LivePoolView() {
  const navigate = useNavigate();
  const [loaded, setLoaded] = useState(false);
  return (
    <>
      <button className="pane-back" onClick={() => navigate("/explore")}>← Network</button>
      <div className="control-heading">
        <div>
          <span className="eyebrow">BlockDAG explorer</span>
          <h1>Shielded Pool · Live</h1>
          <p>Private coins dropping into the shielded pool, in real time. Amounts stay hidden.</p>
        </div>
        <a className="text-button" href={LIVE_URL} target="_blank" rel="noreferrer">Full screen ↗</a>
      </div>
      <section className="control-card explorer-live-card">
        {!loaded && (
          <div className="explorer-live-loading">
            <span className="spin" /> Connecting to the live pool…
          </div>
        )}
        <iframe
          className="explorer-live-frame"
          src={LIVE_URL}
          title="Shielded Pool Live"
          loading="lazy"
          onLoad={() => setLoaded(true)}
          referrerPolicy="no-referrer"
          sandbox="allow-scripts allow-same-origin allow-popups"
        />
      </section>
      <p className="muted small explorer-live-note">
        Live from explorer.zkas.info — needs a connection. It shows only that shielded activity is happening, never any amounts or who paid whom.
      </p>
    </>
  );
}

export function Explorer() {
  const { kind, id } = useParams();
  const location = useLocation();
  if (location.pathname === "/explore/live") {
    return (
      <main className="control-page explorer-page">
        <LivePoolView />
      </main>
    );
  }
  return (
    <main className="control-page explorer-page">
      {!kind || !id ? <DashboardView /> : kind === "block" ? <BlockView id={id} /> : kind === "tx" ? <TransactionView id={id} /> : kind === "address" ? <AddressView id={decodeURIComponent(id)} /> : <DashboardView />}
    </main>
  );
}
