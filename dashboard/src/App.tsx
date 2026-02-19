import { useState, useEffect, useRef } from "react";
import {
  LineChart,
  Line,
  XAxis,
  YAxis,
  ResponsiveContainer,
} from "recharts";
import { useBotConnection, formatWindowRange, formatWindowEndTime, formatRemaining } from "./useBotConnection";
import {
  cumulativePnl,
  btcSeries,
  cexFeeds,
} from "./data";

const CEX_ORDER = ["binance", "coinbase", "okx", "bybit", "kraken", "bitfinex"];

function formatUsd(n: number): string {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 0,
    maximumFractionDigits: 0,
  }).format(n);
}

function formatUsdSmall(n: number): string {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(n);
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

function normalizeUnixSec(n: number | undefined): number | null {
  if (n == null || !Number.isFinite(n)) return null;
  // Accept either seconds or milliseconds.
  return n > 1_000_000_000_000 ? Math.floor(n / 1000) : Math.floor(n);
}

function normalizedWindowRange(
  marketSlug: string,
  startRaw: number | undefined,
  endRaw: number | undefined
): { start: number; end: number } | null {
  const FIVE_MIN = 300;
  const snapToFiveMin = (sec: number): number => Math.floor(sec / FIVE_MIN) * FIVE_MIN;
  const start = normalizeUnixSec(startRaw);
  const end = normalizeUnixSec(endRaw);
  if (start != null && end != null) {
    const orderedStart = Math.min(start, end);
    const orderedEnd = Math.max(start, end);
    // For BTC 5m windows, treat anything close to 5 minutes as valid,
    // but always snap to exact 5-minute boundaries for display.
    const span = orderedEnd - orderedStart;
    if (span >= 240 && span <= 360) {
      const snappedStart = snapToFiveMin(orderedStart);
      return { start: snappedStart, end: snappedStart + FIVE_MIN };
    }
  }
  const m = marketSlug.match(/^btc-updown-5m-(\d{9,})$/);
  if (!m) return null;
  const slugTs = Number(m[1]);
  if (!Number.isFinite(slugTs)) return null;
  const snappedStart = snapToFiveMin(slugTs);
  return { start: snappedStart, end: snappedStart + FIVE_MIN };
}

/** Derive log category from level + message for colouring */
function getLogCategory(entry: { level: string; message: string }): string {
  const { level, message } = entry;
  const m = message.toLowerCase();
  if (level === "error") return "error";
  if (level === "warn") return "warn";
  if (
    m.includes("settlement") ||
    m.includes("won") ||
    m.includes("lost") ||
    m.includes("stopped") ||
    m.includes("resolved") ||
    m.includes("take-profit") ||
    m.includes("pnl=")
  )
    return "settlement";
  if (
    m.includes("arb") ||
    m.includes("directional") ||
    m.includes("order placed") ||
    m.includes("executing") ||
    m.includes("executed") ||
    m.includes("buy ") ||
    m.includes("sell ")
  )
    return "trade";
  if (
    m.includes("risk") ||
    m.includes("blocked") ||
    m.includes("stop loss") ||
    m.includes("stop-loss")
  )
    return "risk";
  if (level === "debug") return "debug";
  return "info";
}

function logCategoryClass(category: string): string {
  return `log-cat-${category}`;
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

/** Format bot start time (ms) as "Xd Xh Xm" run duration; updates every second via parent re-render */
function formatBotRunTime(startTimeMs: number | undefined): string {
  if (startTimeMs == null || !Number.isFinite(startTimeMs)) return "—";
  const elapsedMs = Date.now() - startTimeMs;
  if (elapsedMs < 0) return "—";
  const totalSec = Math.floor(elapsedMs / 1000);
  const totalMin = Math.floor(totalSec / 60);
  const totalHr = Math.floor(totalMin / 60);
  const days = Math.floor(totalHr / 24);
  const hours = totalHr % 24;
  const minutes = totalMin % 60;
  const parts: string[] = [];
  if (days > 0) parts.push(`${days}d`);
  if (hours > 0) parts.push(`${hours}h`);
  parts.push(`${minutes}m`);
  return parts.join(" ");
}

type ExecutionLike = { settled: boolean; actualProfit: number; side: "UP" | "DOWN"; timestamp: number; entry?: string; size?: number };

/** In-depth stats derived from settled trades (chronological order for streaks) */
function getTradingStats(list: ExecutionLike[]) {
  const settled = list.filter((e) => e.settled);
  const wins = settled.filter((e) => e.actualProfit > 0);
  const losses = settled.filter((e) => e.actualProfit < 0);
  const totalPnl = settled.reduce((s, e) => s + e.actualProfit, 0);
  const grossProfit = wins.reduce((s, e) => s + e.actualProfit, 0);
  const grossLoss = losses.reduce((s, e) => s + e.actualProfit, 0); // negative
  const tradingVolume = settled.reduce((s, e) => {
    if (e.entry != null && e.size != null) return s + orderValueDollars(e.entry, e.size);
    return s;
  }, 0);
  const expectancy = settled.length > 0 ? totalPnl / settled.length : 0;
  // Win rate = wins / (wins + losses) - only count profitable vs losing trades
  const totalWinLossTrades = wins.length + losses.length;
  const winRatePct = totalWinLossTrades > 0 ? (wins.length / totalWinLossTrades) * 100 : 0;

  const bySide = { UP: { count: 0, wins: 0, losses: 0, pnl: 0 }, DOWN: { count: 0, wins: 0, losses: 0, pnl: 0 } };
  settled.forEach((e) => {
    bySide[e.side].count++;
    bySide[e.side].pnl += e.actualProfit;
    if (e.actualProfit > 0) bySide[e.side].wins++;
    else bySide[e.side].losses++;
  });

  const byTime = [...settled].sort((a, b) => a.timestamp - b.timestamp);
  let maxWinStreak = 0;
  let maxLossStreak = 0;
  let curWin = 0;
  let curLoss = 0;
  byTime.forEach((e) => {
    if (e.actualProfit > 0) {
      curWin++;
      curLoss = 0;
      maxWinStreak = Math.max(maxWinStreak, curWin);
    } else {
      curLoss++;
      curWin = 0;
      maxLossStreak = Math.max(maxLossStreak, curLoss);
    }
  });

  // Current streak: from most recent trade backwards
  let currentStreak = 0;
  let currentStreakType: "win" | "loss" | null = null;
  for (let i = byTime.length - 1; i >= 0; i--) {
    const isWin = byTime[i].actualProfit > 0;
    if (currentStreakType === null) {
      currentStreakType = isWin ? "win" : "loss";
      currentStreak = 1;
    } else if ((currentStreakType === "win" && isWin) || (currentStreakType === "loss" && !isWin)) {
      currentStreak++;
    } else break;
  }

  return {
    settled,
    wins,
    losses,
    totalWins: wins.length,
    totalLosses: losses.length,
    totalPnl,
    grossProfit,
    grossLoss,
    tradingVolume,
    expectancy,
    winRatePct,
    bySide,
    maxWinStreak,
    maxLossStreak,
    currentStreak,
    currentStreakType,
    maxWin: wins.length > 0 ? Math.max(...wins.map((e) => e.actualProfit)) : null,
    maxLoss: losses.length > 0 ? Math.min(...losses.map((e) => e.actualProfit)) : null,
    avgWin: wins.length > 0 ? grossProfit / wins.length : null,
    avgLoss: losses.length > 0 ? grossLoss / losses.length : null,
  };
}

const DEFAULT_PAGE_SIZE = 10;
const POSITION_ROW_PX = 60;
const POSITION_FOOTER_PX = 46;
const POSITION_SAFETY_PX = 8;
const FIVE_MIN_MS = 5 * 60 * 1000;

type PositionsTab = "open" | "pending" | "closed";

const LOG_CATEGORIES = ["all", "trade", "settlement", "risk", "error", "warn", "info", "debug"] as const;
type LogCategory = typeof LOG_CATEGORIES[number];

function getChartDomain(points: Array<{ t: number }>): [number, number] | undefined {
  if (points.length === 0) return undefined;
  const first = points[0].t;
  const last = points[points.length - 1].t;
  if (last > first) return [first, last];
  const delta = first > 1_000_000_000 ? 1000 : 1;
  return [first, first + delta];
}

const LOAD_TIMEOUT_MS = 8000;

export default function App() {
  const { connected, state, logs, error, pnlHistory, btcHistory } =
    useBotConnection();
  const [hasLoaded, setHasLoaded] = useState(false);
  const loadTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (state != null) {
      if (loadTimeoutRef.current != null) {
        clearTimeout(loadTimeoutRef.current);
        loadTimeoutRef.current = null;
      }
      setHasLoaded(true);
      return;
    }
    if (loadTimeoutRef.current != null) return;
    loadTimeoutRef.current = setTimeout(() => {
      loadTimeoutRef.current = null;
      setHasLoaded(true);
    }, LOAD_TIMEOUT_MS);
    return () => {
      if (loadTimeoutRef.current != null) {
        clearTimeout(loadTimeoutRef.current);
        loadTimeoutRef.current = null;
      }
    };
  }, [state]);

  const [positionsTab, setPositionsTab] = useState<PositionsTab>("open");
  const [positionsPage, setPositionsPage] = useState(0);
  const [positionsRowsPerPage, setPositionsRowsPerPage] = useState(
    DEFAULT_PAGE_SIZE
  );
  const [logsFollowBottom, setLogsFollowBottom] = useState(true);
  const [logFilter, setLogFilter] = useState<LogCategory>("all");
  const logsContainerRef = useRef<HTMLDivElement>(null);
  const positionsContainerRef = useRef<HTMLDivElement>(null);
  const returnToBottomTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const prevBtcPriceRef = useRef<number | null>(null);
  const [btcDirection, setBtcDirection] = useState<"up" | "down" | "flat">("flat");
  const timeET = useTimeET();
  const btcPrice = state?.btcPrice ?? 0;
  const totalProfit = state?.stats?.totalProfit ?? 0;
  const dailyPnL = state?.risk?.dailyPnL ?? 0;
  const tradesExecuted = state?.stats?.tradesExecuted ?? 0;
  const demoBalance = state?.demoBalance;
  const dataMode = state?.dataMode ?? "live";
  const modeReason = state?.modeReason;
  const hasLiveMarketData = dataMode === "live";
  const executions = state?.executions ?? [];
  const openTradesValue =
    executions
      .filter((e) => e.fullyExecuted && !e.settled && !e.pendingSettlement)
      .reduce((sum, e) => sum + orderValueDollars(e.entry, e.size), 0) ?? 0;
  const tradesWon = state?.stats?.profitableTrades ?? executions.filter((e) => e.settled && e.actualProfit > 0).length;
  const avgTrade =
    state?.stats && state.stats.tradesExecuted > 0
      ? state.stats.totalProfit / state.stats.tradesExecuted
      : 0;
  const pctGained =
    demoBalance != null && demoBalance.startingUsd > 0
      ? (totalProfit / demoBalance.startingUsd) * 100
      : null;
  const hasEdgeInputs =
    state?.windowStartBtcPrice != null &&
    state?.btcPrice != null &&
    state?.currentMarketPrices != null;
  const cexProbability = hasEdgeInputs
    ? Math.min(
        0.8,
        0.5 +
          (Math.abs(
            ((state.btcPrice - state.windowStartBtcPrice) / state.windowStartBtcPrice) *
              100
          ) *
            0.4)
      ) * 100
    : null;
  const exchangeSignal =
    hasEdgeInputs && state.btcPrice !== state.windowStartBtcPrice
      ? state.btcPrice > state.windowStartBtcPrice
        ? "UP"
        : "DOWN"
      : null;
  const polymarketProbability =
    hasEdgeInputs && exchangeSignal != null
      ? (exchangeSignal === "UP"
          ? state.currentMarketPrices!.up
          : state.currentMarketPrices!.down) * 100
      : null;
  const edgePercent =
    cexProbability != null && polymarketProbability != null
      ? cexProbability - polymarketProbability
      : null;
  const sigma =
    hasEdgeInputs && state.windowStartBtcPrice > 0
      ? Math.abs(
          ((state.btcPrice - state.windowStartBtcPrice) / state.windowStartBtcPrice) *
            100
        ) / 0.15
      : null;
  const liveTargetAsk =
    hasEdgeInputs && exchangeSignal != null
      ? (exchangeSignal === "UP" ? state.currentMarketPrices!.up : state.currentMarketPrices!.down)
      : null;
  const liveKelly =
    cexProbability != null && liveTargetAsk != null && liveTargetAsk < 1
      ? Math.max(0, (cexProbability / 100 - liveTargetAsk) / (1 - liveTargetAsk))
      : null;
  const fiveMinAgo = Date.now() - FIVE_MIN_MS;
  const pnlChartData =
    pnlHistory.length > 0 ? pnlHistory : cumulativePnl.series;
  const btcChartData =
    btcHistory.length > 0
      ? btcHistory.filter((pt) => pt.t >= fiveMinAgo)
      : btcSeries;
  const pnlChartSeries = [...pnlChartData].sort((a, b) => a.t - b.t);
  const btcChartSeries = [...btcChartData].sort((a, b) => a.t - b.t);
  const pnlXDomain = getChartDomain(pnlChartSeries);
  const btcXDomain = getChartDomain(btcChartSeries);
  const liveWindowRemainingSec =
    state?.windowEndTime != null
      ? Math.max(0, state.windowEndTime - Math.floor(Date.now() / 1000))
      : Math.max(0, state?.windowRemainingSec ?? 0);

  useEffect(() => {
    if (state?.btcPrice == null) return;
    const prev = prevBtcPriceRef.current;
    if (prev != null) {
      if (state.btcPrice > prev) setBtcDirection("up");
      else if (state.btcPrice < prev) setBtcDirection("down");
      else setBtcDirection("flat");
    }
    prevBtcPriceRef.current = state.btcPrice;
  }, [state?.btcPrice]);

  // Auto-scroll logs to bottom when following; after 30s of no scroll interaction, return to bottom
  useEffect(() => {
    if (logsFollowBottom && logsContainerRef.current) {
      logsContainerRef.current.scrollTop = logsContainerRef.current.scrollHeight;
    }
  }, [logs, logsFollowBottom]);

  useEffect(() => {
    return () => {
      if (returnToBottomTimeoutRef.current) clearTimeout(returnToBottomTimeoutRef.current);
    };
  }, []);

  useEffect(() => {
    const el = positionsContainerRef.current;
    if (!el) return;
    const computeRows = () => {
      const next = Math.max(
        1,
        Math.floor(
          (el.clientHeight - POSITION_FOOTER_PX - POSITION_SAFETY_PX) /
            POSITION_ROW_PX
        )
      );
      setPositionsRowsPerPage((prev) => (prev === next ? prev : next));
    };
    computeRows();
    if (typeof ResizeObserver !== "undefined") {
      const observer = new ResizeObserver(() => computeRows());
      observer.observe(el);
      return () => observer.disconnect();
    }
    window.addEventListener("resize", computeRows);
    return () => window.removeEventListener("resize", computeRows);
  }, []);

  const handleLogsScroll = () => {
    const el = logsContainerRef.current;
    if (!el) return;
    if (returnToBottomTimeoutRef.current) {
      clearTimeout(returnToBottomTimeoutRef.current);
      returnToBottomTimeoutRef.current = null;
    }
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 20;
    setLogsFollowBottom(atBottom);
    returnToBottomTimeoutRef.current = setTimeout(() => {
      returnToBottomTimeoutRef.current = null;
      setLogsFollowBottom(true);
      if (logsContainerRef.current) {
        logsContainerRef.current.scrollTop = logsContainerRef.current.scrollHeight;
      }
    }, 30_000);
  };

  return (
    <div className="h-screen w-screen overflow-hidden bg-bg-dark text-white flex flex-col relative">
      {!hasLoaded && (
        <div
          className="fixed inset-0 z-50 flex flex-col items-center justify-center gap-4 bg-bg-dark"
          aria-live="polite"
          aria-busy="true"
        >
          <span className="waiting-spinner shrink-0" aria-hidden />
          <span className="text-muted text-sm">Loading dashboard…</span>
        </div>
      )}
      <div
        className={`flex flex-col h-full w-full transition-opacity duration-500 ease-out ${
          hasLoaded ? "opacity-100" : "opacity-0 pointer-events-none"
        }`}
      >
      {/* Header - match image: green dot, BTC price, PNL/TODAY green, WIN/TRADES white, OPEN orange, NEXT WINDOW + MARKET right */}
      <header className="flex items-center justify-between px-6 py-3 border-b border-edge bg-bg-panel shrink-0">
        <div className="flex items-center gap-2">
          <span
            className={`w-2 h-2 rounded-full shrink-0 ${connected ? "bg-positive animate-live-dot" : "bg-negative"}`}
            title={connected ? "Connected to bot" : "Disconnected"}
          />
          <span className="font-mono font-medium text-primary">
            BTC {btcPrice ? formatUsdSmall(btcPrice) : "—"}
          </span>
          <span
            className={`text-[10px] px-1.5 py-0.5 rounded border uppercase tracking-wider ${
              dataMode === "simulation"
                ? "border-negative text-negative"
                : "border-positive text-positive"
            }`}
            title={modeReason ?? undefined}
          >
            {dataMode === "simulation" ? "Simulation" : "Live data"}
          </span>
          {!connected && (
            <span className="text-muted text-sm">(no bot)</span>
          )}
        </div>
        <div className="flex items-start [&>*]:border-l [&>*]:border-edge [&>*]:px-4 [&>*:first-child]:border-0 [&>*:first-child]:pl-0">
          {demoBalance != null && (
            <div className="flex flex-col gap-0.5 items-center">
              <span className="text-muted text-[10px] uppercase tracking-wider text-center">Balance</span>
              <span className="font-mono font-medium text-primary text-sm" title={`Starting: $${demoBalance.startingUsd.toLocaleString()}`}>
                {formatUsd(demoBalance.currentUsd)}
              </span>
            </div>
          )}
          <div className="flex flex-col gap-0.5 items-center">
            <span className="text-muted text-[10px] uppercase tracking-wider text-center">Pnl</span>
            <span
              className={`font-mono font-medium text-sm ${totalProfit >= 0 ? "text-positive" : "text-negative"}`}
            >
              {totalProfit >= 0 ? "+" : ""}
              {formatUsd(totalProfit)}
            </span>
          </div>
          <div className="flex flex-col gap-0.5 items-center">
            <span className="text-muted text-[10px] uppercase tracking-wider text-center">Today</span>
            <span
              className={`font-mono font-medium text-sm ${dailyPnL >= 0 ? "text-positive" : "text-negative"}`}
            >
              {dailyPnL >= 0 ? "+" : ""}
              {formatUsd(dailyPnL)}
            </span>
          </div>
          <div className="flex flex-col gap-0.5 items-center">
            <span className="text-muted text-[10px] uppercase tracking-wider text-center">Win rate</span>
            <span className="font-mono text-primary text-sm">
              {tradesExecuted > 0 ? `${((tradesWon / tradesExecuted) * 100).toFixed(1)}%` : "—"}
            </span>
          </div>
          <div className="flex flex-col gap-0.5 items-center">
            <span className="text-muted text-[10px] uppercase tracking-wider text-center">Trades</span>
            <span className="font-mono text-primary text-sm">
              {tradesExecuted.toLocaleString()}
            </span>
          </div>
          <div className="flex flex-col gap-0.5 items-center">
            <span className="text-muted text-[10px] uppercase tracking-wider text-center">Open</span>
            <span className="text-primary font-mono font-medium text-sm">
              {formatUsd(openTradesValue)}
            </span>
          </div>
          <div className="flex flex-col gap-0.5 items-center">
            <span className="text-muted text-[10px] uppercase tracking-wider text-center">Avg / trade</span>
            <span
              className={`font-mono font-medium text-sm ${avgTrade >= 0 ? "text-positive" : "text-negative"}`}
            >
              {avgTrade >= 0 ? "+" : ""}${avgTrade.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
            </span>
          </div>
          <div className="flex flex-col gap-0.5 items-center">
            <span className="text-muted text-[10px] uppercase tracking-wider text-center">Uptime</span>
            <span className="font-mono text-primary text-sm">
              {formatBotRunTime(state?.stats?.startTime)}
            </span>
          </div>
        </div>
        <div className="flex flex-col gap-0.5 items-center">
          <span className="text-muted text-sm font-mono">{timeET ? `${timeET} ET` : "—"}</span>
        </div>
      </header>

      {error && (
        <div className="bg-negative/20 text-negative px-4 py-2 text-sm text-center">
          {error} — reconnecting…
        </div>
      )}

      {/* Main content */}
      <main className="flex-1 flex min-h-0 overflow-hidden">
        <div className="flex-1 min-w-0 overflow-auto grid grid-cols-12 gap-0 auto-rows-auto">
        {/* Left: Cumulative PNL – all time */}
        <section className="col-span-4 bg-bg-panel border-r border-b border-edge py-2 flex flex-col min-h-0">
          <h2 className="text-edge text-xs uppercase tracking-wider mb-1 px-4">
            CUMULATIVE PNL (ALL TIME)
          </h2>
          <div className="font-mono text-3xl font-medium text-primary mb-0.5 px-4">
            {formatUsd(totalProfit)}
          </div>
          <div
            className={`px-4 text-sm font-mono mb-1 ${dailyPnL >= 0 ? "text-positive" : "text-negative"}`}
          >
            {dailyPnL >= 0 ? "+" : ""}
            {formatUsd(dailyPnL)} today
          </div>
          <div
            className={`px-4 text-sm font-mono mb-3 ${pctGained != null ? (pctGained >= 0 ? "text-positive" : "text-negative") : "text-muted"}`}
          >
            {pctGained != null
              ? `${pctGained >= 0 ? "+" : ""}${pctGained.toFixed(1)}%`
              : "—"}
          </div>
          <div className="flex-1 min-h-[140px] px-4">
            <ResponsiveContainer width="100%" height="100%">
              <LineChart
                data={pnlChartSeries}
                margin={{ top: 4, right: 4, left: 4, bottom: 4 }}
              >
                <Line
                  type="monotone"
                  dataKey="v"
                  stroke="#ffffff"
                  strokeWidth={1.5}
                  dot={false}
                />
                <XAxis dataKey="t" hide type="number" domain={pnlXDomain} />
                <YAxis hide domain={["dataMin", "dataMax"]} />
              </LineChart>
            </ResponsiveContainer>
          </div>
        </section>

        {/* Middle: BTC/USD – last 5 min live */}
        <section className="col-span-4 bg-bg-panel border-r border-b border-edge py-2 flex flex-col min-h-0">
          <h2 className="text-edge text-xs uppercase tracking-wider mb-1 px-4">
            BTC/USD (5M LIVE)
          </h2>
          <div
            className={`px-4 font-mono text-3xl font-medium mb-2 inline-flex items-center ${
              btcDirection === "up"
                ? "text-positive"
                : btcDirection === "down"
                  ? "text-negative"
                  : "text-primary"
            }`}
          >
            {btcPrice ? (
              <>
                {formatUsdSmall(btcPrice)}
                <span className="ml-2 text-2xl leading-none self-center">
                  {btcDirection === "up"
                    ? "▲"
                    : btcDirection === "down"
                      ? "▼"
                      : "•"}
                </span>
              </>
            ) : "—"}
          </div>
          <div className="flex-1 min-h-[140px] px-4">
            <ResponsiveContainer width="100%" height="100%">
              <LineChart
                data={btcChartSeries}
                margin={{ top: 4, right: 4, left: 4, bottom: 4 }}
              >
                <Line
                  type="monotone"
                  dataKey="v"
                  stroke="#ffffff"
                  strokeWidth={1.5}
                  dot={false}
                />
                <XAxis
                  dataKey="t"
                  hide
                  domain={btcXDomain}
                  type="number"
                />
                <YAxis hide domain={["dataMin", "dataMax"]} />
              </LineChart>
            </ResponsiveContainer>
          </div>
        </section>

        {/* Last 10 resolved 5min BTC markets (UP/DOWN) - from Polymarket */}
        <section className="col-span-4 bg-bg-panel border-b border-edge py-2 flex flex-col min-h-0">
          <h2 className="text-edge text-xs uppercase tracking-wider mb-2 px-4">
            HISTORICAL MARKETS
          </h2>
          <div className="flex-1 overflow-y-auto min-h-0">
            {(() => {
              const markets = state?.historicalMarkets ?? [];
              const last8 = [...markets]
                .sort((a, b) => b.windowEnd - a.windowEnd)
                .slice(0, 8);
              if (last8.length === 0) {
                return (
                  <div className="py-4 text-center text-muted text-sm px-4">
                    Waiting for resolved markets feed...
                  </div>
                );
              }
              return (
                <ul className="space-y-0">
                  {last8.map((m) => (
                    <li
                      key={m.windowEnd}
                      className="border-b border-edge last:border-0"
                    >
                      <div className="flex items-center justify-between py-2.5 px-4">
                        <span
                          className="font-mono tabular-nums text-sm font-medium"
                          style={{ color: "#a1a1aa" }}
                        >
                          {formatWindowEndTime(m.windowEnd)}
                        </span>
                        <span
                          className={`font-mono text-sm font-medium shrink-0 ${
                            m.outcome === "UP" ? "text-positive" : "text-negative"
                          }`}
                        >
                          {m.outcome === "UP" ? "▲" : "▼"}
                        </span>
                      </div>
                    </li>
                  ))}
                </ul>
              );
            })()}
          </div>
        </section>

        {/* CEX Feeds */}
        <section className="col-span-2 bg-bg-panel border-r border-b border-edge py-2 flex flex-col min-h-0">
          <h2 className="text-edge text-xs uppercase tracking-wider mb-2 px-4">
            CEX FEEDS
          </h2>
          <div className="font-mono text-sm text-primary space-y-0">
            {(state?.cexPrices && Object.keys(state.cexPrices).length > 0
              ? CEX_ORDER.filter((name) => state!.cexPrices[name] != null).map((name) => ({
                  name,
                  price: state!.cexPrices[name],
                }))
              : cexFeeds
            ).map((c) => (
              <div
                key={c.name}
                className="border-b border-edge last:border-0"
              >
                <div className="flex items-center justify-between gap-4 py-1.5 px-4">
                  <span className="text-muted shrink-0">{capitalize(c.name)}</span>
                  <span className="tabular-nums text-primary font-medium truncate">
                    ${formatCexPrice(typeof c.price === "number" ? c.price : 0)}
                  </span>
                </div>
              </div>
            ))}
          </div>
        </section>

        {/* EDGE calculations */}
        <section className="col-span-2 bg-bg-panel border-r border-b border-edge py-2 flex flex-col min-h-0">
          <h2 className="text-edge text-xs uppercase tracking-wider mb-2 px-4">
            EDGE
          </h2>
          <div className="font-mono text-sm text-primary space-y-0">
            <div className="border-b border-edge">
              <div className="flex items-center justify-between gap-4 py-1.5 px-4">
                <span className="text-muted shrink-0">cex</span>
                <span className="tabular-nums text-primary font-medium">
                  {cexProbability != null ? `${cexProbability.toFixed(1)}%` : "—"}
                </span>
              </div>
            </div>
            <div className="border-b border-edge">
              <div className="flex items-center justify-between gap-4 py-1.5 px-4">
                <span className="text-muted shrink-0">pm</span>
                <span className="tabular-nums text-primary font-medium">
                  {polymarketProbability != null
                    ? `${polymarketProbability.toFixed(1)}%`
                    : "—"}
                </span>
              </div>
            </div>
            <div className="border-b border-edge">
              <div className="flex items-center justify-between gap-4 py-1.5 px-4">
                <span className="text-muted shrink-0">edge</span>
                <span
                  className={`tabular-nums font-medium ${
                    edgePercent == null
                      ? "text-primary"
                      : edgePercent >= 0
                        ? "text-positive"
                        : "text-negative"
                  }`}
                >
                  {edgePercent != null
                    ? `${edgePercent >= 0 ? "+" : ""}${edgePercent.toFixed(1)}%`
                    : "—"}
                </span>
              </div>
            </div>
            <div className="border-b border-edge">
              <div className="flex items-center justify-between gap-4 py-1.5 px-4">
                <span className="text-muted shrink-0">σ</span>
                <span className="tabular-nums text-primary font-medium">
                  {sigma != null ? sigma.toFixed(1) : "—"}
                </span>
              </div>
            </div>
            <div>
              <div className="flex items-center justify-between gap-4 py-1.5 px-4">
                <span className="text-muted shrink-0">Kelly</span>
                <span className="tabular-nums text-primary font-medium">
                  {liveKelly != null ? `${(liveKelly * 100).toFixed(1)}%` : "—"}
                </span>
              </div>
            </div>
          </div>
        </section>

        {/* Current market window: start price, window info, UP/DOWN */}
        <section className="col-span-4 bg-bg-panel border-r border-b border-edge py-2 flex flex-col min-h-0">
          <h2 className="text-edge text-xs uppercase tracking-wider mb-2 px-4">
            CURRENT WINDOW
          </h2>
          <div className="font-mono text-sm text-primary space-y-0">
            {!hasLiveMarketData ? (
              <div className="py-2 text-muted text-sm space-y-1 px-4">
                <p className="font-medium text-negative">Live market data unavailable.</p>
                <p className="text-xs">
                  Bot is currently using simulation mode
                  {state?.forceRealData ? " despite FORCE_REAL_DATA=true." : "."}
                </p>
              </div>
            ) : state?.windowStartTime != null && state?.windowEndTime != null ? (
              <>
                <div className="border-b border-edge">
                  <div className="flex items-center justify-between gap-4 py-1.5 px-4">
                    <span className="text-muted shrink-0">Starting price</span>
                    <span className="tabular-nums text-primary font-medium">
                      {state.windowStartBtcPrice != null
                        ? formatUsdSmall(state.windowStartBtcPrice)
                        : "—"}
                    </span>
                  </div>
                </div>
                <div className="border-b border-edge">
                  <div className="flex items-center justify-between gap-4 py-1.5 px-4">
                    <span className="text-muted shrink-0">Window</span>
                    <span className="tabular-nums text-primary">
                      {formatWindowRange(state.windowStartTime, state.windowEndTime)}
                    </span>
                  </div>
                </div>
                <div className="border-b border-edge">
                  <div className="flex items-center justify-between gap-4 py-1.5 px-4">
                    <span className="text-muted shrink-0">Time left</span>
                    <span className="tabular-nums text-primary">
                      {formatRemaining(liveWindowRemainingSec)}
                    </span>
                  </div>
                </div>
                <div className="border-b border-edge">
                  <div className="flex items-center justify-between gap-4 py-1.5 px-4">
                    <span className="text-muted shrink-0">Market volume</span>
                    <span className="tabular-nums text-primary font-medium">
                      {state.marketVolume != null ? formatUsd(state.marketVolume) : "—"}
                    </span>
                  </div>
                </div>
                {state.currentMarketPrices != null && (
                  <>
                    <div className="border-b border-edge">
                      <div className="flex items-center justify-between gap-4 py-1.5 px-4">
                        <span className="text-muted shrink-0">UP</span>
                        <span className="tabular-nums text-positive font-medium">
                          ${state.currentMarketPrices.up.toFixed(2)}
                        </span>
                      </div>
                    </div>
                    <div className="border-b border-edge last:border-0">
                      <div className="flex items-center justify-between gap-4 py-1.5 px-4">
                        <span className="text-muted shrink-0">DOWN</span>
                        <span className="tabular-nums text-negative font-medium">
                          ${state.currentMarketPrices.down.toFixed(2)}
                        </span>
                      </div>
                    </div>
                  </>
                )}
                {state.currentMarketPrices == null && (
                  <div className="py-1.5 text-muted text-xs px-4">
                    No order book yet for this window.
                  </div>
                )}
              </>
            ) : (
              <div className="py-2 text-muted text-sm space-y-1 px-4">
                <p className="font-medium text-primary">No active window.</p>
                <p className="text-xs">
                  Connect the bot (npm run dev, DASHBOARD_WS_PORT=8765) and ensure it has discovered active 5‑min BTC markets.
                </p>
              </div>
            )}
          </div>
        </section>

        {/* Trading stats (spans 2 rows) */}
        {(() => {
          const list = state?.tradeHistory ?? state?.executions ?? [];
          const s = getTradingStats(list);
          const hasSettled = s.settled.length > 0;
          return (
            <section className="col-span-4 row-span-2 bg-bg-panel border-b border-edge py-2 flex flex-col min-h-0">
              <h2 className="text-edge text-xs uppercase tracking-wider mb-2 px-4">
                TRADING STATS
              </h2>
              <div className="font-mono text-sm text-primary space-y-0 overflow-y-auto min-h-0 flex-1">
                {!hasSettled ? (
                  <div className="py-4 text-center text-muted text-sm px-4">No settled trades yet.</div>
                ) : (
                  <>
                    <div className="border-b border-edge">
                      <div className="flex items-center justify-between gap-4 py-1.5 px-4">
                        <span className="text-muted shrink-0">Wins</span>
                        <span className="tabular-nums text-primary font-medium">{s.totalWins}</span>
                      </div>
                    </div>
                    <div className="border-b border-edge">
                      <div className="flex items-center justify-between gap-4 py-1.5 px-4">
                        <span className="text-muted shrink-0">Losses</span>
                        <span className="tabular-nums text-primary font-medium">{s.totalLosses}</span>
                      </div>
                    </div>
                    <div className="border-b border-edge">
                      <div className="flex items-center justify-between gap-4 py-1.5 px-4">
                        <span className="text-muted shrink-0">Max win</span>
                        <span className="tabular-nums text-primary font-medium">{s.maxWin != null ? `+${formatUsdSmall(s.maxWin)}` : "—"}</span>
                      </div>
                    </div>
                    <div className="border-b border-edge">
                      <div className="flex items-center justify-between gap-4 py-1.5 px-4">
                        <span className="text-muted shrink-0">Max loss</span>
                        <span className="tabular-nums text-primary font-medium">{s.maxLoss != null ? formatUsdSmall(s.maxLoss) : "—"}</span>
                      </div>
                    </div>
                    <div className="border-b border-edge">
                      <div className="flex items-center justify-between gap-4 py-1.5 px-4">
                        <span className="text-muted shrink-0">Avg win</span>
                        <span className="tabular-nums text-primary font-medium">{s.avgWin != null ? `+${formatUsdSmall(s.avgWin)}` : "—"}</span>
                      </div>
                    </div>
                    <div className="border-b border-edge">
                      <div className="flex items-center justify-between gap-4 py-1.5 px-4">
                        <span className="text-muted shrink-0">Avg loss</span>
                        <span className="tabular-nums text-primary font-medium">{s.avgLoss != null ? formatUsdSmall(s.avgLoss) : "—"}</span>
                      </div>
                    </div>
                    <div className="border-b border-edge">
                      <div className="flex items-center justify-between gap-4 py-1.5 px-4">
                        <span className="text-muted shrink-0">Total PnL</span>
                        <span className="tabular-nums text-primary font-medium">{s.totalPnl >= 0 ? "+" : ""}{formatUsdSmall(s.totalPnl)}</span>
                      </div>
                    </div>
                    <div className="border-b border-edge">
                      <div className="flex items-center justify-between gap-4 py-1.5 px-4">
                        <span className="text-muted shrink-0">Trading volume</span>
                        <span className="tabular-nums text-primary font-medium">{formatUsd(s.tradingVolume)}</span>
                      </div>
                    </div>
                    <div className="border-b border-edge">
                      <div className="flex items-center justify-between gap-4 py-1.5 px-4">
                        <span className="text-muted shrink-0">Expectancy</span>
                        <span className="tabular-nums text-primary font-medium">{s.expectancy >= 0 ? "+" : ""}{formatUsdSmall(s.expectancy)} / trade</span>
                      </div>
                    </div>
                    <div className="border-b border-edge">
                      <div className="flex items-center justify-between gap-4 py-1.5 px-4">
                        <span className="text-muted shrink-0">Current streak</span>
                        <span className="tabular-nums text-primary font-medium">
                          {s.settled.length === 0 ? "—" : `${s.currentStreak} ${s.currentStreakType === "win" ? "wins" : "losses"}`}
                        </span>
                      </div>
                    </div>
                    <div className="border-b border-edge">
                      <div className="flex items-center justify-between gap-4 py-1.5 px-4">
                        <span className="text-muted shrink-0">Best streak</span>
                        <span className="tabular-nums text-primary font-medium">{s.maxWinStreak} wins</span>
                      </div>
                    </div>
                    <div className="border-b border-edge">
                      <div className="flex items-center justify-between gap-4 py-1.5 px-4">
                        <span className="text-muted shrink-0">Worst streak</span>
                        <span className="tabular-nums text-primary font-medium">{s.maxLossStreak} losses</span>
                      </div>
                    </div>
                    <div className="border-b border-edge">
                      <div className="flex items-center justify-between gap-4 py-1.5 px-4">
                        <span className="text-muted shrink-0">UP PnL</span>
                        <span className="tabular-nums text-primary font-medium">{s.bySide.UP.pnl >= 0 ? "+" : ""}{formatUsdSmall(s.bySide.UP.pnl)} ({s.bySide.UP.wins}/{s.bySide.UP.count})</span>
                      </div>
                    </div>
                    <div>
                      <div className="flex items-center justify-between gap-4 py-1.5 px-4">
                        <span className="text-muted shrink-0">DOWN PnL</span>
                        <span className="tabular-nums text-primary font-medium">{s.bySide.DOWN.pnl >= 0 ? "+" : ""}{formatUsdSmall(s.bySide.DOWN.pnl)} ({s.bySide.DOWN.wins}/{s.bySide.DOWN.count})</span>
                      </div>
                    </div>
                  </>
                )}
              </div>
            </section>
          );
        })()}

        {/* Logs (left 2/3 of row; combined section fills right 1/3 via row-span) */}
        <section className="col-span-8 bg-bg-panel flex flex-col min-h-0 h-[280px] shrink-0 border-b border-edge">
          <div className="flex items-center justify-between px-4 py-2 pb-1">
            <h2 className="text-edge text-xs uppercase tracking-wider">
              LIVE LOGS ({logs.length}/1000) {!connected && "(disconnected)"}
            </h2>
            <div className="flex gap-1">
              {LOG_CATEGORIES.map((cat) => (
                <button
                  key={cat}
                  type="button"
                  onClick={() => setLogFilter(cat)}
                  className={`px-2 py-0.5 text-[10px] font-medium rounded uppercase ${
                    logFilter === cat
                      ? "bg-subtle text-primary"
                      : "text-muted hover:text-primary"
                  }`}
                >
                  {cat}
                </button>
              ))}
            </div>
          </div>
          <div
            ref={logsContainerRef}
            onScroll={handleLogsScroll}
            className="flex-1 overflow-y-auto p-2 pt-1 font-mono text-xs min-h-[120px] bg-bg-dark/40"
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
            {logs
              .filter((entry) => {
                if (logFilter === "all") return true;
                return getLogCategory(entry) === logFilter;
              })
              .map((entry, i) => {
                const category = getLogCategory(entry);
                const colorClass = logCategoryClass(category);
                return (
                  <div
                    key={`${entry.timestamp}-${i}`}
                    className={`py-0.5 flex flex-wrap items-baseline gap-x-2 gap-y-0.5 ${colorClass}`}
                  >
                    <span className="text-muted shrink-0 text-[11px]">
                      {entry.timestamp.length >= 23
                        ? entry.timestamp.slice(11, 23)
                        : entry.timestamp}
                    </span>
                    <span className={`shrink-0 text-[10px] font-semibold uppercase tracking-wider opacity-90`}>
                      [{category}]
                    </span>
                    <span className="flex-1 min-w-0">
                      {entry.message}
                      {entry.meta && (
                        <span className="text-muted ml-1">{entry.meta}</span>
                      )}
                    </span>
                  </div>
                );
              })}
          </div>
        </section>

        </div>

        {/* Right: Positions - full height */}
        <section className="w-[min(420px,40vw)] shrink-0 border-l border-edge bg-bg-panel flex flex-col min-h-0">
          <div className="flex items-center justify-between px-4 py-2 border-b border-edge">
            <h2 className="text-edge text-xs uppercase tracking-wider">
              POSITIONS
            </h2>
            <div className="flex rounded border border-edge overflow-hidden">
              <button
                type="button"
                onClick={() => { setPositionsTab("open"); setPositionsPage(0); }}
                className={`px-3 py-1.5 text-xs font-medium ${positionsTab === "open" ? "bg-subtle text-primary" : "text-muted hover:text-primary"}`}
              >
                Open
              </button>
              <button
                type="button"
                onClick={() => { setPositionsTab("pending"); setPositionsPage(0); }}
                className={`px-3 py-1.5 text-xs font-medium ${positionsTab === "pending" ? "bg-subtle text-primary" : "text-muted hover:text-primary"}`}
              >
                Pending
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
          <div
            ref={positionsContainerRef}
            className="flex-1 flex flex-col min-h-0"
          >
            {(() => {
              const nowSec = Math.floor(Date.now() / 1000);
              const isExpired = (e: (typeof executions)[number]): boolean => {
                const window = normalizedWindowRange(
                  e.marketSlug,
                  e.marketWindowStart,
                  e.marketWindowEnd
                );
                return window != null ? window.end <= nowSec : true;
              };
              const openList = executions.filter(
                (e) => e.fullyExecuted && !e.settled && !e.pendingSettlement && !isExpired(e)
              );
              const pendingList = executions.filter(
                (e) => e.fullyExecuted && e.pendingSettlement === true && !e.settled
              );
              // Closed tab: use full trade history when available, else current run's closed executions
              const closedFromHistory =
                positionsTab === "closed" && state?.tradeHistory?.length
                  ? state.tradeHistory.filter((e) => e.settled)
                  : null;
              const closedList =
                closedFromHistory ??
                executions.filter((e) => e.settled || isExpired(e));
              const list = positionsTab === "open" ? openList : positionsTab === "pending" ? pendingList : closedList;
              const displayList =
                positionsTab === "closed" && closedFromHistory
                  ? closedFromHistory
                  : [...list].reverse();
              const totalPages = Math.max(
                1,
                Math.ceil(displayList.length / positionsRowsPerPage)
              );
              const page = Math.min(positionsPage, totalPages - 1);
              const pageList = displayList.slice(
                page * positionsRowsPerPage,
                page * positionsRowsPerPage + positionsRowsPerPage
              );
              if (displayList.length === 0) {
                return (
                  <div className="text-muted text-sm p-4 flex justify-center items-center">
                    {positionsTab === "open" ? (
                      <div className="flex items-center gap-2">
                        <span className="waiting-spinner shrink-0" />
                        <span>Waiting for positions</span>
                      </div>
                    ) : positionsTab === "pending" ? (
                      "No pending settlements."
                    ) : (
                      "No closed positions yet."
                    )}
                  </div>
                );
              }
              return (
                <>
                  <div className="flex-1 overflow-hidden min-h-0">
                    {pageList.map((e, i) => {
                      const orderValue = orderValueDollars(e.entry, e.size);
                      const entryCents = parseFloat(String(e.entry).replace(/[^\d.]/g, "")) || 0;
                      const entryUsd = entryCents / 100;
                      const isOpen = positionsTab === "open";
                      const isPending = positionsTab === "pending";
                      const displayProfit = isOpen && e.unrealizedProfit != null ? e.unrealizedProfit : e.actualProfit;
                      const showLive = isOpen && e.unrealizedProfit != null;
                      const normalizedWindow = normalizedWindowRange(
                        e.marketSlug,
                        e.marketWindowStart,
                        e.marketWindowEnd
                      );
                      const marketLabel =
                        normalizedWindow != null
                          ? formatWindowRange(normalizedWindow.start, normalizedWindow.end)
                          : e.marketSlug.replace(/^btc-updown-5m-/, "");
                      return (
                        <div
                          key={(e as { id?: string }).id ?? `${e.marketSlug}-${e.timestamp}-${e.side}-${i}`}
                          className="border-b border-edge last:border-0"
                          style={{
                            borderLeft: `3px solid ${e.side === "UP" ? "#22c55e" : "#ef4444"}`,
                          }}
                        >
                        <div className="flex items-center justify-between py-2.5 px-4"
                        >
                          <div className="flex flex-col gap-0.5 min-w-0 flex-1">
                            <div className="flex items-center gap-2 flex-wrap">
                              <span className="text-muted text-xs shrink-0">Bet</span>
                              <span
                                className={`shrink-0 text-sm font-medium ${e.side === "UP" ? "text-positive" : "text-negative"}`}
                              >
                                {e.side === "UP" ? "▲ UP" : "▼ DOWN"}
                              </span>
                              <span className="text-muted text-xs">·</span>
                              <span className="text-primary text-sm font-mono truncate" title={e.marketSlug}>
                                {marketLabel}
                              </span>
                            </div>
                            <div className="flex items-center gap-2 text-muted text-xs font-mono">
                              <span>{formatUsdSmall(orderValue)} @ {formatUsdSmall(entryUsd)}</span>
                              <span className="text-gray-600">|</span>
                              <span className={e.lossCapped ? "text-negative" : (e.profitTaken || e.settled) ? "text-positive" : e.pendingSettlement ? "text-muted" : ""}>
                                {e.lossCapped
                                  ? "Stopped X"
                                  : e.profitTaken
                                    ? "Profit \u2713"
                                    : e.settled
                                      ? "Resolved \u2713"
                                      : e.pendingSettlement
                                        ? "Pending"
                                        : e.fullyExecuted
                                          ? "Open"
                                          : "partial"}
                              </span>
                            </div>
                          </div>
                          <div className="flex flex-col items-end shrink-0 ml-2">
                            {e.pendingSettlement ? (
                              <span className="waiting-spinner shrink-0" title="Settlement pending" />
                            ) : (
                              <span
                                className={`font-mono text-sm font-medium ${displayProfit >= 0 ? "text-positive" : "text-negative"}`}
                                title={
                                  showLive
                                    ? "Live (mark-to-market)"
                                    : e.profitTaken
                                      ? "Trailing take-profit (profit locked in before window end)"
                                      : e.lossCapped
                                        ? "Stopped at 5% loss (position exited early; full loss if held to resolution)"
                                        : undefined
                                }
                              >
                                {displayProfit >= 0 ? "+" : ""}
                                {formatUsdSmall(displayProfit)}
                              </span>
                            )}
                          </div>
                        </div>
                        </div>
                      );
                    })}
                  </div>
                  <div className="flex items-center justify-between px-4 py-2 border-t border-edge shrink-0">
                    <span className="text-muted text-xs">
                      Page {page + 1} of {totalPages} ({displayList.length} total)
                    </span>
                    <div className="flex gap-1">
                      <button
                        type="button"
                        onClick={() => setPositionsPage((p) => Math.max(0, p - 1))}
                        disabled={page === 0}
                        className="px-2 py-1 text-xs font-medium rounded border border-edge text-primary disabled:opacity-50 disabled:cursor-not-allowed hover:bg-subtle"
                      >
                        Prev
                      </button>
                      <button
                        type="button"
                        onClick={() => setPositionsPage((p) => Math.min(totalPages - 1, p + 1))}
                        disabled={page >= totalPages - 1}
                        className="px-2 py-1 text-xs font-medium rounded border border-edge text-primary disabled:opacity-50 disabled:cursor-not-allowed hover:bg-subtle"
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
      </main>
      </div>
    </div>
  );
}
