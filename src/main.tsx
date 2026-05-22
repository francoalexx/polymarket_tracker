import React from "react";
import ReactDOM from "react-dom/client";
import { Activity, AlertCircle, Bell, CheckCircle2, CircleDollarSign, Clock3, Plus, Radio, RadioTower, Send, ShieldCheck, Trash2, WifiOff, XCircle } from "lucide-react";
import { DEFAULT_TRACKED_WALLETS, DEFAULT_WALLET, YWS1_WALLET } from "../shared/types";
import type { ActivityTrade, CandidateFeedItem, GroupedPosition, PreparedTradeTicket, PriceUpdate, ScannerSnapshot, StatusPayload } from "../shared/types";
import { isValidWallet, normalizeWallet } from "../shared/polymarket";
import { cancelTicket, confirmTicket, connectScannerStream } from "./scannerApi";
import "./styles.css";

type StreamError = { message: string; receivedAt: number };
type ActivityDelta = { trades: ActivityTrade[]; receivedAt: number };
type PositionsSnapshot = { groups: GroupedPosition[]; rawCount: number; receivedAt: number };

const TARGETS_KEY = "polymarket-tracker.targets";
const SELECTED_KEY = "polymarket-tracker.selected";

function App() {
  const [targets, setTargets] = React.useState<string[]>(loadTargets);
  const [selectedWallet, setSelectedWallet] = React.useState(loadSelected);
  const [newWallet, setNewWallet] = React.useState("");
  const [positions, setPositions] = React.useState<GroupedPosition[]>([]);
  const [activity, setActivity] = React.useState<ActivityTrade[]>([]);
  const [prices, setPrices] = React.useState<Record<string, PriceUpdate>>({});
  const [status, setStatus] = React.useState<StatusPayload>({
    status: "connecting",
    message: "Waiting to connect",
    receivedAt: Date.now()
  });
  const [error, setError] = React.useState<StreamError | null>(null);
  const [expanded, setExpanded] = React.useState<Set<string>>(new Set());
  const [highlightedTrades, setHighlightedTrades] = React.useState<Set<string>>(new Set());
  const [soundEnabled, setSoundEnabled] = React.useState(true);
  const [scannerSnapshot, setScannerSnapshot] = React.useState<ScannerSnapshot | null>(null);
  const [selectedCandidateWallet, setSelectedCandidateWallet] = React.useState<string | null>(null);

  React.useEffect(() => {
    localStorage.setItem(TARGETS_KEY, JSON.stringify(targets));
  }, [targets]);

  React.useEffect(() => {
    localStorage.setItem(SELECTED_KEY, selectedWallet);
  }, [selectedWallet]);

  React.useEffect(() => {
    const source = connectScannerStream(
      (snapshot) => {
        setScannerSnapshot(snapshot);
        if (snapshot.status !== "error") setError(null);
      },
      (message) => setError({ message, receivedAt: Date.now() })
    );
    return () => source.close();
  }, []);

  React.useEffect(() => {
    let source: EventSource | null = null;
    let reconnectTimer: number | undefined;
    let reconnectAttempt = 0;
    let closed = false;

    function connect() {
      setStatus({ status: "connecting", message: "Connecting", receivedAt: Date.now() });
      source = new EventSource(`/api/stream?wallet=${encodeURIComponent(selectedWallet)}`);

      source.addEventListener("positions_snapshot", (event) => {
        const snapshot = JSON.parse((event as MessageEvent).data) as PositionsSnapshot;
        setPositions(snapshot.groups);
        setError(null);
      });

      source.addEventListener("activity_delta", (event) => {
        const delta = JSON.parse((event as MessageEvent).data) as ActivityDelta;
        if (delta.trades.length === 0) return;

        setActivity((current) => [...delta.trades, ...current].slice(0, 150));
        const ids = new Set(delta.trades.map(activityKey));
        setHighlightedTrades(ids);
        if (soundEnabled) playAlert();
        window.setTimeout(() => setHighlightedTrades(new Set()), 1800);
      });

      source.addEventListener("price_update", (event) => {
        const update = JSON.parse((event as MessageEvent).data) as PriceUpdate;
        setPrices((current) => ({ ...current, [update.asset]: update }));
      });

      source.addEventListener("status", (event) => {
        const next = JSON.parse((event as MessageEvent).data) as StatusPayload;
        setStatus(next);
      });

      source.addEventListener("error", (event) => {
        if ("data" in event && event.data) {
          setError(JSON.parse((event as MessageEvent).data) as StreamError);
        }
      });

      source.onopen = () => {
        reconnectAttempt = 0;
      };

      source.onerror = () => {
        source?.close();
        if (closed) return;
        reconnectAttempt += 1;
        const delay = Math.min(10000, 700 * 2 ** reconnectAttempt);
        setStatus({ status: "reconnecting", message: `Reconnecting in ${Math.round(delay / 1000)}s`, receivedAt: Date.now() });
        reconnectTimer = window.setTimeout(connect, delay);
      };
    }

    connect();

    return () => {
      closed = true;
      source?.close();
      if (reconnectTimer) window.clearTimeout(reconnectTimer);
      setPositions([]);
      setActivity([]);
      setPrices({});
    };
  }, [selectedWallet, soundEnabled]);

  const stale = Date.now() - status.receivedAt > 10000 || status.status === "stale";

  function addWallet() {
    const wallet = normalizeWallet(newWallet);
    if (!isValidWallet(wallet)) {
      setError({ message: "Enter a valid 0x wallet address.", receivedAt: Date.now() });
      return;
    }
    setTargets((current) => Array.from(new Set([...current, wallet])));
    setSelectedWallet(wallet);
    setNewWallet("");
  }

  function removeWallet(wallet: string) {
    const next = targets.filter((target) => target !== wallet);
    setTargets(next.length > 0 ? next : [DEFAULT_WALLET]);
    if (selectedWallet === wallet) setSelectedWallet(next[0] ?? DEFAULT_WALLET);
  }

  return (
    <main className="app-shell">
      <section className="topbar">
        <div>
          <p className="eyebrow">Polymarket watcher</p>
          <h1>Bonereaper positions</h1>
        </div>
        <div className={`status-pill ${stale ? "is-stale" : status.status}`}>
          {stale ? <WifiOff size={16} /> : <Radio size={16} />}
          <span>{stale ? "Stale" : status.message}</span>
        </div>
      </section>

      <section className="controls-band">
        <div className="wallet-tabs" aria-label="Tracked wallets">
          {targets.map((wallet) => (
            <button
              className={wallet === selectedWallet ? "wallet-chip active" : "wallet-chip"}
              key={wallet}
              onClick={() => setSelectedWallet(wallet)}
              title={wallet}
            >
              {walletLabel(wallet)}
              <Trash2
                size={14}
                aria-label="Remove wallet"
                onClick={(event) => {
                  event.stopPropagation();
                  removeWallet(wallet);
                }}
              />
            </button>
          ))}
        </div>
        <div className="wallet-input">
          <input
            value={newWallet}
            onChange={(event) => setNewWallet(event.target.value)}
            placeholder="0x wallet address"
            aria-label="Wallet address"
          />
          <button onClick={addWallet} aria-label="Add wallet" title="Add wallet">
            <Plus size={18} />
          </button>
          <button
            className={soundEnabled ? "icon-toggle active" : "icon-toggle"}
            onClick={() => setSoundEnabled((value) => !value)}
            aria-label="Toggle alert sound"
            title="Toggle alert sound"
          >
            <Bell size={18} />
          </button>
        </div>
      </section>

      {error ? (
        <section className="error-band">
          <AlertCircle size={18} />
          <span>{error.message}</span>
        </section>
      ) : null}

      <section className="metrics-grid">
        <Metric icon={<CircleDollarSign size={18} />} label="Position value" value={formatCurrency(sumGroups(positions, "totalCurrentValue"))} />
        <Metric icon={<Activity size={18} />} label="Open markets" value={String(positions.length)} />
        <Metric label="P/L" value={formatCurrency(sumGroups(positions, "totalCashPnl"))} tone={sumGroups(positions, "totalCashPnl") >= 0 ? "good" : "bad"} />
        <Metric label="Last update" value={relativeTime(status.receivedAt)} />
      </section>

      <section className="scanner-grid">
        <CandidateFeed
          snapshot={scannerSnapshot}
          selectedWallet={selectedCandidateWallet}
          onSelect={(candidate) => {
            setSelectedCandidateWallet(candidate.wallet);
            setTargets((current) => Array.from(new Set([...current, candidate.wallet])));
            setSelectedWallet(candidate.wallet);
          }}
        />
        <TicketQueue
          tickets={scannerSnapshot?.tickets ?? []}
          onConfirm={(id) => confirmTicket(id).catch((error) => setError({ message: error.message, receivedAt: Date.now() }))}
          onCancel={(id) => cancelTicket(id).catch((error) => setError({ message: error.message, receivedAt: Date.now() }))}
        />
        <ExecutionLog entries={scannerSnapshot?.executions ?? []} />
      </section>

      <section className="main-grid">
        <div className="positions-panel">
          <header className="panel-header">
            <h2>Open positions</h2>
            <span>{positions.length ? "Short-term crypto pinned first" : "Waiting for positions"}</span>
          </header>
          <PositionTable
            groups={positions}
            prices={prices}
            expanded={expanded}
            onToggle={(conditionId) =>
              setExpanded((current) => {
                const next = new Set(current);
                next.has(conditionId) ? next.delete(conditionId) : next.add(conditionId);
                return next;
              })
            }
          />
        </div>
        <aside className="activity-panel">
          <header className="panel-header">
            <h2>Trade tape</h2>
            <span>{activity.length ? `${activity.length} session trades` : "New trades appear here"}</span>
          </header>
          <div className="activity-list">
            {activity.length === 0 ? <EmptyState text="No new session trades yet." /> : null}
            {activity.map((trade) => (
              <article className={highlightedTrades.has(activityKey(trade)) ? "trade-card flash" : "trade-card"} key={activityKey(trade)}>
                <div>
                  <strong>{trade.side} {trade.outcome}</strong>
                  <span>{trade.title}</span>
                </div>
                <div className="trade-meta">
                  <span>{formatNumber(trade.size)} shares</span>
                  <span>@ {formatPercent(trade.price)}</span>
                  <span>{relativeTime(trade.timestamp * 1000)}</span>
                </div>
              </article>
            ))}
          </div>
        </aside>
      </section>
    </main>
  );
}

function PositionTable({
  groups,
  prices,
  expanded,
  onToggle
}: {
  groups: GroupedPosition[];
  prices: Record<string, PriceUpdate>;
  expanded: Set<string>;
  onToggle: (conditionId: string) => void;
}) {
  if (groups.length === 0) return <EmptyState text="No active positions returned for this wallet." />;

  return (
    <div className="table-wrap">
      <table>
        <thead>
          <tr>
            <th>Market</th>
            <th>Dominant</th>
            <th>Shares</th>
            <th>Avg</th>
            <th>Now</th>
            <th>Value</th>
            <th>P/L</th>
            <th>Last trade</th>
          </tr>
        </thead>
        <tbody>
          {groups.map((group) => {
            const mainLeg = group.legs.find((leg) => leg.outcome === group.dominantOutcome) ?? group.legs[0];
            const latestPrice = prices[mainLeg.asset]?.price ?? mainLeg.curPrice;
            const open = expanded.has(group.conditionId);
            return (
              <React.Fragment key={group.conditionId}>
                <tr className={rowClassName(group)} onClick={() => onToggle(group.conditionId)}>
                  <td>
                    <div className="market-cell">
                      <img src={group.icon} alt="" />
                      <div>
                        <strong>{group.title}</strong>
                        <span>{positionSubtitle(group)}</span>
                      </div>
                    </div>
                  </td>
                  <td>{group.dominantOutcome}</td>
                  <td>{formatNumber(group.totalShares)}</td>
                  <td>{formatPercent(weightedAvg(group.legs))}</td>
                  <td>{formatPercent(latestPrice)}</td>
                  <td>{formatCurrency(group.totalCurrentValue)}</td>
                  <td className={group.totalCashPnl >= 0 ? "good" : "bad"}>{formatCurrency(group.totalCashPnl)}</td>
                  <td>{group.lastTradeTimestamp ? relativeTime(group.lastTradeTimestamp * 1000) : "N/A"}</td>
                </tr>
                {open
                  ? group.legs.map((leg) => (
                      <tr className="leg-row" key={leg.asset}>
                        <td>{leg.outcome}</td>
                        <td>{leg.size > 0 ? "Open" : "Flat"}</td>
                        <td>{formatNumber(leg.size)}</td>
                        <td>{formatPercent(leg.avgPrice)}</td>
                        <td>{formatPercent(prices[leg.asset]?.price ?? leg.curPrice)}</td>
                        <td>{formatCurrency(leg.currentValue)}</td>
                        <td className={leg.cashPnl >= 0 ? "good" : "bad"}>{formatCurrency(leg.cashPnl)}</td>
                        <td>{leg.asset.slice(0, 8)}...</td>
                      </tr>
                    ))
                  : null}
              </React.Fragment>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function CandidateFeed({
  snapshot,
  selectedWallet,
  onSelect
}: {
  snapshot: ScannerSnapshot | null;
  selectedWallet: string | null;
  onSelect: (candidate: CandidateFeedItem) => void;
}) {
  const candidates = snapshot?.candidates ?? [];
  const latency = snapshot?.latency;
  const headerText = latency
    ? `${latency.activeMarketType} active / ${latency.medianLatencySeconds}s median`
    : "Starting scanner";

  return (
    <section className="scanner-panel candidate-feed">
      <header className="panel-header">
        <h2><RadioTower size={16} /> Candidate feed</h2>
        <span>{headerText}</span>
      </header>
      <div className="candidate-list">
        {candidates.length === 0 ? <EmptyState text={snapshot?.message ?? "Starting scanner."} /> : null}
        {candidates.map((candidate) => (
          <button
            className={candidate.wallet === selectedWallet ? "candidate-row active" : "candidate-row"}
            key={`${candidate.wallet}:${candidate.signal.market.conditionId}:${candidate.signal.candidateTradeId}`}
            onClick={() => onSelect(candidate)}
          >
            <div>
              <strong>{walletLabel(candidate.wallet)}</strong>
              <span>{candidate.signal.market.title}</span>
            </div>
            <div className="candidate-badges">
              <Badge>{candidate.marketType}</Badge>
              <Badge>{candidate.source}</Badge>
              <Badge>{candidate.recommendation.replace("_", " ")}</Badge>
              {candidate.strictPass ? <Badge icon={<ShieldCheck size={13} />}>strict pass</Badge> : null}
            </div>
            <div className="candidate-stats">
              <span>Score {candidate.score.toFixed(1)}</span>
              <span>{candidate.outcome}</span>
              <span>{candidate.latencySeconds}s lag</span>
            </div>
          </button>
        ))}
      </div>
    </section>
  );
}

function TicketQueue({
  tickets,
  onConfirm,
  onCancel
}: {
  tickets: PreparedTradeTicket[];
  onConfirm: (id: string) => void;
  onCancel: (id: string) => void;
}) {
  const pendingCount = tickets.filter((ticket) => ticket.status === "pending").length;

  return (
    <section className="scanner-panel ticket-queue">
      <header className="panel-header">
        <h2><CheckCircle2 size={16} /> Trade tickets</h2>
        <span>{pendingCount} pending</span>
      </header>
      <div className="ticket-list">
        {tickets.length === 0 ? <EmptyState text="No prepared tickets." /> : null}
        {tickets.map((ticket) => (
          <article className="ticket-card" key={ticket.id}>
            <div>
              <strong>{ticket.kind.toUpperCase()} {ticket.outcome}</strong>
              <span>{ticket.market.title}</span>
            </div>
            <div className="ticket-meta">
              <span>limit {formatPercent(ticket.limitPrice)}</span>
              <span>{formatNumber(ticket.size)} shares</span>
              {ticket.spendUsdc ? <span>{formatCurrency(ticket.spendUsdc)}</span> : null}
              <span>{ticket.status}</span>
            </div>
            <div className="ticket-actions">
              <button onClick={() => onConfirm(ticket.id)} disabled={ticket.status !== "pending"} title="Confirm ticket" aria-label="Confirm ticket">
                <Send size={16} />
              </button>
              <button onClick={() => onCancel(ticket.id)} disabled={ticket.status !== "pending"} title="Cancel ticket" aria-label="Cancel ticket">
                <XCircle size={16} />
              </button>
            </div>
          </article>
        ))}
      </div>
    </section>
  );
}

function ExecutionLog({ entries }: { entries: ScannerSnapshot["executions"] }) {
  return (
    <section className="scanner-panel execution-log">
      <header className="panel-header">
        <h2><Clock3 size={16} /> Execution log</h2>
        <span>{entries.length} events</span>
      </header>
      <div className="execution-list">
        {entries.length === 0 ? <EmptyState text="No executions yet." /> : null}
        {entries.map((entry) => (
          <article className="execution-row" key={entry.id}>
            <strong>{entry.status}</strong>
            <span>{entry.message}</span>
            <span>{relativeTime(entry.createdAt)}</span>
          </article>
        ))}
      </div>
    </section>
  );
}

function Badge({ children, icon }: { children: React.ReactNode; icon?: React.ReactNode }) {
  return <span className="badge">{icon}{children}</span>;
}

function Metric({ icon, label, value, tone }: { icon?: React.ReactNode; label: string; value: string; tone?: "good" | "bad" }) {
  return (
    <article className="metric">
      <div className="metric-label">{icon}{label}</div>
      <strong className={tone}>{value}</strong>
    </article>
  );
}

function EmptyState({ text }: { text: string }) {
  return <div className="empty-state">{text}</div>;
}

function rowClassName(group: GroupedPosition): string {
  return [group.isShortTermCrypto ? "pinned" : "", group.isPending ? "pending" : ""].filter(Boolean).join(" ");
}

function positionSubtitle(group: GroupedPosition): string {
  if (group.isPending) return "Syncing from latest trade";
  if (group.isShortTermCrypto) return "Pinned crypto";
  return group.slug;
}

function loadTargets(): string[] {
  try {
    const stored = JSON.parse(localStorage.getItem(TARGETS_KEY) ?? "[]") as string[];
    const valid = stored.map(normalizeWallet).filter(isValidWallet);
    return Array.from(new Set([...DEFAULT_TRACKED_WALLETS, ...valid]));
  } catch {
    return DEFAULT_TRACKED_WALLETS;
  }
}

function loadSelected(): string {
  const stored = localStorage.getItem(SELECTED_KEY);
  return stored && isValidWallet(stored) ? normalizeWallet(stored) : DEFAULT_WALLET;
}

function activityKey(trade: ActivityTrade): string {
  return `${trade.transactionHash}:${trade.asset}:${trade.side}:${trade.price}:${trade.size}:${trade.timestamp}`;
}

function shortWallet(wallet: string): string {
  return `${wallet.slice(0, 6)}...${wallet.slice(-4)}`;
}

function walletLabel(wallet: string): string {
  if (wallet === DEFAULT_WALLET) return "Bonereaper";
  if (wallet === YWS1_WALLET) return "yws1";
  return shortWallet(wallet);
}

function sumGroups(groups: GroupedPosition[], key: "totalCurrentValue" | "totalCashPnl"): number {
  return groups.reduce((total, group) => total + group[key], 0);
}

function weightedAvg(legs: GroupedPosition["legs"]): number {
  const totalShares = legs.reduce((total, leg) => total + leg.size, 0);
  if (totalShares === 0) return 0;
  return legs.reduce((total, leg) => total + leg.avgPrice * leg.size, 0) / totalShares;
}

function formatCurrency(value: number): string {
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 2 }).format(value);
}

function formatNumber(value: number): string {
  return new Intl.NumberFormat("en-US", { maximumFractionDigits: 2 }).format(value);
}

function formatPercent(value?: number): string {
  if (value === undefined || Number.isNaN(value)) return "N/A";
  return `${Math.round(value * 1000) / 10}%`;
}

function relativeTime(value: number): string {
  const seconds = Math.max(0, Math.round((Date.now() - value) / 1000));
  if (seconds < 2) return "now";
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  return `${hours}h ago`;
}

function playAlert() {
  const AudioContextClass = window.AudioContext || (window as Window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!AudioContextClass) return;

  const context = new AudioContextClass();
  const oscillator = context.createOscillator();
  const gain = context.createGain();

  oscillator.type = "sine";
  oscillator.frequency.value = 720;
  gain.gain.value = 0.035;
  oscillator.connect(gain);
  gain.connect(context.destination);
  oscillator.start();
  oscillator.stop(context.currentTime + 0.12);
}

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
