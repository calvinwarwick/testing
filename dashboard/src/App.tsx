import { useState, useEffect, useRef } from "react";
import {
  LineChart,
  Line,
  XAxis,
  YAxis,
  ResponsiveContainer,
  AreaChart,
  Area,
} from "recharts";
import { useBotConnection, formatWindowRange } from "./useBotConnection";
import {
  cumulativePnl,
  btcSeries,
  cexFeeds,
} from "./data";

const CEX_ORDER = ["binance", "coinbase", "okx", "bybit", "kraken", "bitfinex"];

function formatOrderTime(timestamp: number): string {
  const d = new Date(timestamp);
  return d.toLocaleTimeString("en-US", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });
}

function formatUsd(n: number): string {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 0,
    maximumFractionDigits: 0,
  })
    .format(n)
    .replace("$", "$ ");
}

function formatUsdSmall(n: number): string {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(n);
}

function formatSize(n: number): string {
  return n.toLocaleString("en-US").replace(/,/g, " ");
}

function formatCexPrice(n: number): string {
  return new Intl.NumberFormat("en-US", {
    style: "decimal",
    minimumFractionDigits: 0,
    maximumFractionDigits: 0,
  }).format(n);
}

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1).toLowerCase();
}

/** Order size in $ from entry string (e.g. "60¢") and share count */
function orderValueDollars(entry: string, size: number): number {
  const cents = parseFloat(String(entry).replace(/[^\d.]/g, "")) || 0;
  return (cents / 100) * size;
}

function logLevelColor(level: string): string {
  switch (level) {
    case "error":
      return "text-negative";
    case "warn":
      return "text-open";
    case "info":
      return "text-positive";
    default:
      return "text-muted";
  }
}

/** 5-second countdown timer (seconds.milliseconds) for delay between price check and execution */
function useFiveSecondTimer() {
  const [display, setDisplay] = useState("5.00");
  const startRef = useRef(Date.now());

  useEffect(() => {
    const tick = () => {
      const elapsed = (Date.now() - startRef.current) / 1000;
      const remaining = 5 - (elapsed % 5);
      const sec = Math.floor(remaining);
      const ms = Math.floor((remaining - sec) * 100);
      setDisplay(`${sec}.${ms.toString().padStart(2, "0")}`);
    };
    tick();
    const id = setInterval(tick, 50);
    return () => clearInterval(id);
  }, []);

  return display;
}

/** Current time in Eastern Time, updates every second */
function useTimeET() {
  const [time, setTime] = useState("");
  useEffect(() => {
    const fmt = () =>
      new Date().toLocaleTimeString("en-US", {
        hour: "numeric",
        minute: "2-digit",
        second: "2-digit",
        hour12: true,
        timeZone: "America/New_York",
      });
    setTime(fmt());
    const id = setInterval(() => setTime(fmt()), 1000);
    return () => clearInterval(id);
  }, []);
  return time;
}

const PAGE_SIZE = 10;

type PositionsTab = "open" | "closed";

export default function App() {
  const { connected, state, logs, error, pnlHistory, btcHistory } =
    useBotConnection();
  const [positionsTab, setPositionsTab] = useState<PositionsTab>("open");
  const [positionsPage, setPositionsPage] = useState(0);
  const [orderFeedPage, setOrderFeedPage] = useState(0);
  const fiveSecondDisplay = useFiveSecondTimer();
  const timeET = useTimeET();
  const btcPrice = state?.btcPrice ?? 0;
  const totalProfit = state?.stats?.totalProfit ?? 0;
  const dailyPnL = state?.risk?.dailyPnL ?? 0;
  const tradesExecuted = state?.stats?.tradesExecuted ?? 0;
  const demoBalance = state?.demoBalance;
  const executions = state?.executions ?? [];
  const openTradesValue =
    executions
      .filter((e) => e.fullyExecuted && !e.settled)
      .reduce((sum, e) => sum + orderValueDollars(e.entry, e.size), 0) ?? 0;
  const tradesWon = executions.filter((e) => e.settled && e.actualProfit > 0).length;
  const marketLabel =
    state?.windowStartTime != null && state?.windowEndTime != null
      ? formatWindowRange(state.windowStartTime, state.windowEndTime)
      : "—";
  const pnlChartData =
    pnlHistory.length > 0
      ? pnlHistory
      : cumulativePnl.series;
  const btcChartData =
    btcHistory.length > 0
      ? btcHistory
      : btcSeries;

  return (
    <div className="min-h-screen bg-bg-dark text-white flex flex-col">
      {/* Header - match image: green dot, BTC price, PNL/TODAY green, WIN/TRADES white, OPEN orange, NEXT WINDOW + MARKET right */}
      <header className="flex items-center justify-between px-6 py-3 border-b border-subtle bg-bg-panel shrink-0">
        <div className="flex items-center gap-2">
          <span
            className={`w-2 h-2 rounded-full shrink-0 ${connected ? "bg-positive" : "bg-negative"}`}
            title={connected ? "Connected to bot" : "Disconnected"}
          />
          <span className="font-mono font-medium text-primary">
            BTC {btcPrice ? formatUsdSmall(btcPrice) : "—"}
          </span>
          {timeET && (
            <span className="text-muted text-sm font-mono">{timeET} ET</span>
          )}
          {!connected && (
            <span className="text-muted text-sm">(no bot)</span>
          )}
        </div>
        <div className="flex items-center gap-0 [&>*]:border-l [&>*]:border-subtle [&>*]:pl-4 [&>*:first-child]:border-0 [&>*:first-child]:pl-0">
          {demoBalance != null && (
            <div className="flex items-baseline gap-1">
              <span className="text-muted text-sm">BALANCE</span>
              <span className="font-mono font-medium text-primary" title={`Starting: $${demoBalance.startingUsd.toLocaleString()}`}>
                {formatUsd(demoBalance.currentUsd)}
              </span>
            </div>
          )}
          <div className="flex items-baseline gap-1">
            <span className="text-muted text-sm">PNL</span>
            <span
              className={`font-mono font-medium ${totalProfit >= 0 ? "text-positive" : "text-negative"}`}
            >
              {totalProfit >= 0 ? "+" : ""}
              {formatUsd(totalProfit)}
            </span>
          </div>
          <div className="flex items-baseline gap-1">
            <span className="text-muted text-sm">TODAY</span>
            <span
              className={`font-mono font-medium ${dailyPnL >= 0 ? "text-positive" : "text-negative"}`}
            >
              {dailyPnL >= 0 ? "+" : ""}
              {formatUsd(dailyPnL)}
            </span>
          </div>
          <div className="flex items-baseline gap-1">
            <span className="text-muted text-sm">WIN</span>
            <span className="font-mono text-primary">{tradesWon.toLocaleString().replace(/,/g, " ")}</span>
          </div>
          <div className="flex items-baseline gap-1">
            <span className="text-muted text-sm">TRADES</span>
            <span className="font-mono text-primary">
              {tradesExecuted.toLocaleString().replace(/,/g, " ")}
            </span>
          </div>
          <div className="flex items-baseline gap-1">
            <span className="text-muted text-sm">OPEN</span>
            <span className="text-open font-mono font-medium">
              {formatUsd(openTradesValue)}
            </span>
          </div>
        </div>
        <div className="text-right">
          <div className="text-muted text-xs uppercase tracking-wider">
            NEXT CHECK
          </div>
          <div className="font-mono text-lg text-primary tabular-nums">
            {fiveSecondDisplay}
            <span className="text-muted text-sm font-normal ml-0.5">s</span>
          </div>
          <div className="text-muted text-xs uppercase tracking-wider mt-0.5">
            MARKET
          </div>
          <div className="font-mono text-sm text-primary">{marketLabel}</div>
        </div>
      </header>

      {error && (
        <div className="bg-negative/20 text-negative px-4 py-2 text-sm text-center">
          {error} — reconnecting…
        </div>
      )}

      {/* Main content */}
      <main className="flex-1 grid grid-cols-12 gap-0 min-h-0 overflow-auto">
        {/* Left: Cumulative PNL */}
        <section className="col-span-4 bg-bg-panel border border-subtle p-2 flex flex-col min-h-0">
          <h2 className="text-muted text-xs uppercase tracking-wider mb-1">
            CUMULATIVE PNL
          </h2>
          <div className="font-mono text-3xl font-medium text-primary mb-0.5">
            {formatUsd(totalProfit)}
          </div>
          <div
            className={`text-sm font-mono mb-1 ${dailyPnL >= 0 ? "text-positive" : "text-negative"}`}
          >
            {dailyPnL >= 0 ? "+" : ""}
            {formatUsd(dailyPnL)} today
          </div>
          <div className="text-muted text-sm font-mono mb-3">+0%</div>
          <div className="flex-1 min-h-[140px]">
            <ResponsiveContainer width="100%" height="100%">
              <AreaChart
                data={pnlChartData}
                margin={{ top: 4, right: 4, left: 4, bottom: 4 }}
              >
                <defs>
                  <linearGradient id="pnlGrad" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor="#ffffff" stopOpacity={0.15} />
                    <stop offset="100%" stopColor="#ffffff" stopOpacity={0} />
                  </linearGradient>
                </defs>
                <Area
                  type="monotone"
                  dataKey="v"
                  stroke="#ffffff"
                  strokeWidth={1.5}
                  fill="url(#pnlGrad)"
                />
                <XAxis dataKey="t" hide />
                <YAxis hide domain={["dataMin", "dataMax"]} />
              </AreaChart>
            </ResponsiveContainer>
          </div>
        </section>

        {/* Middle: BTC/USD */}
        <section className="col-span-4 bg-bg-panel border border-subtle p-2 flex flex-col min-h-0">
          <h2 className="text-muted text-xs uppercase tracking-wider mb-1">
            BTC/USD AGGREGATED
          </h2>
          <div className="font-mono text-3xl font-medium text-primary mb-2 text-center">
            {btcPrice ? formatUsdSmall(btcPrice) : "—"}
          </div>
          <div className="flex-1 min-h-[140px]">
            <ResponsiveContainer width="100%" height="100%">
              <LineChart
                data={btcChartData}
                margin={{ top: 4, right: 4, left: 4, bottom: 4 }}
              >
                <Line
                  type="monotone"
                  dataKey="v"
                  stroke="#ffffff"
                  strokeWidth={1.5}
                  dot={false}
                />
                <XAxis dataKey="t" hide />
                <YAxis hide domain={["dataMin", "dataMax"]} />
              </LineChart>
            </ResponsiveContainer>
          </div>
        </section>

        {/* Right: Positions */}
        <section className="col-span-4 bg-bg-panel border border-subtle p-2 flex flex-col min-h-0">
          <div className="flex items-center justify-between mb-3">
            <h2 className="text-muted text-xs uppercase tracking-wider">
              POSITIONS
            </h2>
            <div className="flex rounded border border-subtle overflow-hidden">
              <button
                type="button"
                onClick={() => { setPositionsTab("open"); setPositionsPage(0); }}
                className={`px-3 py-1.5 text-xs font-medium ${positionsTab === "open" ? "bg-subtle text-primary" : "text-muted hover:text-primary"}`}
              >
                Open
              </button>
              <button
                type="button"
                onClick={() => { setPositionsTab("closed"); setPositionsPage(0); }}
                className={`px-3 py-1.5 text-xs font-medium ${positionsTab === "closed" ? "bg-subtle text-primary" : "text-muted hover:text-primary"}`}
              >
                Closed
              </button>
            </div>
          </div>
          <div className="flex-1 overflow-y-auto space-y-0 flex flex-col min-h-0">
            {(() => {
              const nowSec = Math.floor(Date.now() / 1000);
              const openList = executions.filter(
                (e) => e.fullyExecuted && !e.settled && e.marketWindowEnd > nowSec
              );
              const closedList = executions.filter((e) => e.settled);
              const list = positionsTab === "open" ? openList : closedList;
              const displayList = [...list].reverse();
              const totalPages = Math.max(1, Math.ceil(displayList.length / PAGE_SIZE));
              const page = Math.min(positionsPage, totalPages - 1);
              const pageList = displayList.slice(page * PAGE_SIZE, page * PAGE_SIZE + PAGE_SIZE);
              if (displayList.length === 0) {
                return (
                  <div className="text-muted text-sm py-4">
                    {positionsTab === "open"
                      ? "No open positions."
                      : "No closed positions yet."}
                  </div>
                );
              }
              return (
                <>
                  {pageList.map((e, i) => {
                const orderValue = orderValueDollars(e.entry, e.size);
                const isOpen = positionsTab === "open";
                const displayProfit = isOpen && e.unrealizedProfit != null ? e.unrealizedProfit : e.actualProfit;
                const showLive = isOpen && e.unrealizedProfit != null;
                return (
                  <div
                    key={`${e.timestamp}-${page * PAGE_SIZE + i}`}
                    className="flex items-center justify-between py-2.5 pl-3 border-b border-subtle last:border-0"
                    style={{
                      borderLeft: `3px solid ${displayProfit >= 0 ? "#22c55e" : "#ef4444"}`,
                    }}
                  >
                    <div className="flex items-center gap-3 min-w-0 flex-1">
                      <span
                        className={`shrink-0 text-sm font-medium ${displayProfit >= 0 ? "text-positive" : "text-negative"}`}
                      >
                        {displayProfit >= 0 ? "▲" : "▼"}{" "}
                        {displayProfit >= 0 ? "UP" : "DOWN"}
                      </span>
                      <span className="text-primary text-sm font-mono truncate min-w-0" title={e.marketSlug}>
                        {e.marketSlug.replace(/^btc-updown-5m-/, "")}
                      </span>
                      <span className="text-muted text-sm font-mono shrink-0" title="Entry price">
                        @ {e.entry}
                      </span>
                      <span className="text-muted text-sm font-mono shrink-0" title="Order size">
                        ${orderValue.toFixed(2)}
                      </span>
                      <span
                        className={`text-sm font-mono shrink-0 ${e.settled ? "text-positive" : "text-muted"}`}
                      >
                        {e.settled ? "resolved ✓" : e.fullyExecuted ? "open" : "partial"}
                      </span>
                    </div>
                    <span
                      className={`font-mono text-sm font-medium shrink-0 ml-2 ${displayProfit >= 0 ? "text-positive" : "text-negative"}`}
                      title={showLive ? "Live (mark-to-market)" : undefined}
                    >
                      {showLive && <span className="text-muted font-normal mr-0.5">Live </span>}
                      {displayProfit >= 0 ? "+" : ""}${displayProfit.toFixed(2)}
                    </span>
                  </div>
                );
              })}
                  <div className="flex items-center justify-between mt-2 pt-2 border-t border-subtle shrink-0">
                    <span className="text-muted text-xs">
                      Page {page + 1} of {totalPages} ({displayList.length} total)
                    </span>
                    <div className="flex gap-1">
                      <button
                        type="button"
                        onClick={() => setPositionsPage((p) => Math.max(0, p - 1))}
                        disabled={page === 0}
                        className="px-2 py-1 text-xs font-medium rounded border border-subtle text-primary disabled:opacity-50 disabled:cursor-not-allowed hover:bg-subtle"
                      >
                        Prev
                      </button>
                      <button
                        type="button"
                        onClick={() => setPositionsPage((p) => Math.min(totalPages - 1, p + 1))}
                        disabled={page >= totalPages - 1}
                        className="px-2 py-1 text-xs font-medium rounded border border-subtle text-primary disabled:opacity-50 disabled:cursor-not-allowed hover:bg-subtle"
                      >
                        Next
                      </button>
                    </div>
                  </div>
                </>
              );
            })()}
          </div>
        </section>

        {/* Bottom left: Metrics - AVG/TRADE, MAX DD, OPEN POS, DD LIMIT */}
        <section className="col-span-3 bg-bg-panel border border-subtle">
          <div className="grid grid-cols-2 text-sm divide-x divide-y divide-subtle [&>*]:px-3 [&>*]:py-2">
            {demoBalance != null && (
              <div>
                <div className="text-muted text-xs uppercase tracking-wider">BALANCE</div>
                <div className="font-mono font-medium text-primary" title={`Starting: $${demoBalance.startingUsd.toLocaleString()}`}>
                  {formatUsd(demoBalance.currentUsd)}
                </div>
              </div>
            )}
            <div>
              <div className="text-muted text-xs uppercase tracking-wider">AVG / TRADE</div>
              <div className="text-positive font-mono font-medium">
                $
                {state?.stats && state.stats.tradesExecuted > 0
                  ? (
                      state.stats.totalProfit / state.stats.tradesExecuted
                    ).toFixed(2)
                  : "0.00"}
              </div>
            </div>
            <div>
              <div className="text-muted text-xs uppercase tracking-wider">MAX DD</div>
              <div className="text-negative font-mono font-medium">—</div>
            </div>
            <div>
              <div className="text-muted text-xs uppercase tracking-wider">OPEN POS</div>
              <div className="text-open font-mono font-medium">
                {formatUsd(openTradesValue)}
              </div>
            </div>
            <div>
              <div className="text-muted text-xs uppercase tracking-wider">DD LIMIT</div>
              <div className="text-negative font-mono font-medium">-5.0%</div>
            </div>
          </div>
        </section>

        {/* Bottom middle: Order Feed */}
        <section className="col-span-4 bg-bg-panel border border-subtle p-2 flex flex-col min-h-0">
          <h2 className="text-muted text-xs uppercase tracking-wider mb-3">
            ORDER FEED
          </h2>
          <div className="overflow-x-auto flex-1 min-h-0 flex flex-col">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-muted text-xs uppercase tracking-wider text-left border-b border-subtle">
                  <th className="pb-2 pr-2 w-0" />
                  <th className="pb-2 pr-4">TIME</th>
                  <th className="pb-2 pr-4">MARKET</th>
                  <th className="pb-2 pr-4">SIDE</th>
                  <th className="pb-2 pr-4">ENTRY</th>
                  <th className="pb-2">SIZE</th>
                </tr>
              </thead>
              <tbody>
                {(() => {
                  const sorted = state?.executions?.length
                    ? [...state.executions].sort((a, b) => b.timestamp - a.timestamp)
                    : [];
                  const totalPages = Math.max(1, Math.ceil(sorted.length / PAGE_SIZE));
                  const page = Math.min(orderFeedPage, totalPages - 1);
                  const pageList = sorted.slice(page * PAGE_SIZE, page * PAGE_SIZE + PAGE_SIZE);
                  return (
                    <>
                      {pageList.map((o, i) => (
                        <tr
                          key={`${o.timestamp}-${page * PAGE_SIZE + i}`}
                          className="border-b border-subtle last:border-0"
                        >
                          <td className="py-2 pr-2 w-0 align-middle">
                            <div
                              className="w-1 min-h-6 rounded-sm"
                              style={{
                                backgroundColor:
                                  (o.side ?? "UP") === "UP" ? "#22c55e" : "#ef4444",
                              }}
                            />
                          </td>
                          <td className="py-2 pr-4 font-mono text-primary">
                            {formatOrderTime(o.timestamp)}
                          </td>
                          <td className="py-2 pr-4 font-mono text-primary truncate max-w-[120px]" title={o.marketSlug}>
                            {o.marketSlug.replace(/^btc-updown-5m-/, "")}
                          </td>
                          <td
                            className={`py-2 pr-4 font-mono font-medium ${(o.side ?? "UP") === "UP" ? "text-positive" : "text-negative"}`}
                          >
                            {o.side ?? "UP"}
                          </td>
                          <td className="py-2 pr-4 font-mono text-primary">{o.entry ?? "—"}</td>
                          <td className="py-2 font-mono text-primary">
                            {formatSize(typeof o.size === "number" ? o.size : 0)}
                          </td>
                        </tr>
                      ))}
                      {sorted.length === 0 && (
                        <tr>
                          <td colSpan={6} className="py-6 text-center text-muted text-sm">
                            No orders yet. Run the bot to see live order feed.
                          </td>
                        </tr>
                      )}
                    </>
                  );
                })()}
              </tbody>
            </table>
            {state?.executions && state.executions.length > 0 && (() => {
              const sorted = [...state.executions].sort((a, b) => b.timestamp - a.timestamp);
              const totalPages = Math.max(1, Math.ceil(sorted.length / PAGE_SIZE));
              const page = Math.min(orderFeedPage, totalPages - 1);
              return (
                <div className="flex items-center justify-between mt-2 pt-2 border-t border-subtle shrink-0">
                  <span className="text-muted text-xs">
                    Page {page + 1} of {totalPages} ({sorted.length} total)
                  </span>
                  <div className="flex gap-1">
                    <button
                      type="button"
                      onClick={() => setOrderFeedPage((p) => Math.max(0, p - 1))}
                      disabled={page === 0}
                      className="px-2 py-1 text-xs font-medium rounded border border-subtle text-primary disabled:opacity-50 disabled:cursor-not-allowed hover:bg-subtle"
                    >
                      Prev
                    </button>
                    <button
                      type="button"
                      onClick={() => setOrderFeedPage((p) => Math.min(totalPages - 1, p + 1))}
                      disabled={page >= totalPages - 1}
                      className="px-2 py-1 text-xs font-medium rounded border border-subtle text-primary disabled:opacity-50 disabled:cursor-not-allowed hover:bg-subtle"
                    >
                      Next
                    </button>
                  </div>
                </div>
              );
            })()}
          </div>
        </section>

        {/* CEX Feeds */}
        <section className="col-span-5 bg-bg-panel border border-subtle p-2 flex flex-col min-h-0">
          <h2 className="text-muted text-xs uppercase tracking-wider mb-3">
            CEX FEEDS
          </h2>
          <div className="font-mono text-sm text-primary space-y-1">
            {(state?.cexPrices && Object.keys(state.cexPrices).length > 0
              ? CEX_ORDER.filter((name) => state!.cexPrices[name] != null).map((name) => ({
                  name,
                  price: state!.cexPrices[name],
                }))
              : cexFeeds
            ).map((c) => (
              <div
                key={c.name}
                className="flex items-center justify-between gap-4 py-1.5 border-b border-subtle/50 last:border-0"
              >
                <span className="text-muted shrink-0">{capitalize(c.name)}</span>
                <span className="tabular-nums text-primary font-medium truncate">
                  ${formatCexPrice(typeof c.price === "number" ? c.price : 0)}
                </span>
              </div>
            ))}
          </div>
        </section>

        {/* Logs - full width */}
        <section className="col-span-12 bg-bg-panel border border-subtle flex flex-col min-h-0">
          <h2 className="text-muted text-xs uppercase tracking-wider p-2 pb-1">
            LIVE LOGS {!connected && "(disconnected — start the bot to see logs)"}
          </h2>
          <div
            className="flex-1 overflow-y-auto p-2 pt-1 font-mono text-xs min-h-[200px] max-h-[320px] bg-bg-dark/40"
            style={{ fontFamily: "JetBrains Mono, monospace" }}
          >
            {logs.length === 0 && connected && (
              <div className="text-muted">Waiting for log output…</div>
            )}
            {logs.length === 0 && !connected && (
              <div className="text-muted">
                Connect the bot (npm run dev) with DASHBOARD_WS_PORT=8765 to
                stream logs here.
              </div>
            )}
            {logs.map((entry, i) => (
              <div
                key={`${entry.timestamp}-${i}`}
                className={`py-0.5 ${logLevelColor(entry.level)}`}
              >
                <span className="text-muted mr-2 shrink-0">
                  {entry.timestamp.length >= 23
                    ? entry.timestamp.slice(11, 23)
                    : entry.timestamp}
                </span>
                <span className="font-semibold mr-2">[{entry.level}]</span>
                {entry.message}
                {entry.meta && (
                  <span className="text-muted ml-1">{entry.meta}</span>
                )}
              </div>
            ))}
          </div>
        </section>
      </main>
    </div>
  );
}
