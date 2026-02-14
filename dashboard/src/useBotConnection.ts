import { useState, useEffect, useRef, useCallback } from "react";

const WS_PORT = "8765";
const WS_URL =
  import.meta.env.VITE_WS_URL ||
  (typeof window !== "undefined"
    ? `ws://${window.location.hostname}:${WS_PORT}`
    : `ws://localhost:${WS_PORT}`);
const MAX_LOGS = 1000;
const FIVE_MIN_MS = 5 * 60 * 1000;
const MAX_BTC_POINTS_5M = 60; // ~1 point per 5s over 5m

function parseLogTimestampMs(ts: string): number {
  // Stored as "YYYY-MM-DD HH:mm:ss.SSS"; normalize for Date parsing.
  const normalized = ts.includes("T") ? ts : ts.replace(" ", "T");
  const ms = Date.parse(normalized);
  return Number.isFinite(ms) ? ms : 0;
}

function sortLogsChronological(entries: LogEntry[]): LogEntry[] {
  return [...entries].sort(
    (a, b) => parseLogTimestampMs(a.timestamp) - parseLogTimestampMs(b.timestamp)
  );
}

export interface HistoricalMarket {
  windowStart: number;
  windowEnd: number;
  btcPriceAtStart: number;
  btcPriceAtEnd: number;
  outcome: "UP" | "DOWN";
  recordedAt: number;
}

export interface BotState {
  btcPrice: number | null;
  btcTimestamp: number;
  cexPrices: Record<string, number>;
  /** Current 5-min market UP (YES) and DOWN (NO) best ask prices (0–1) */
  currentMarketPrices?: { up: number; down: number };
  /** Current market data source mode. */
  dataMode?: "live" | "simulation";
  /** Reason behind current data mode. */
  modeReason?: string;
  /** Whether FORCE_REAL_DATA is enabled in config. */
  forceRealData?: boolean;
  /** Market volume (USD) for current window, when available */
  marketVolume?: number;
  activeMarketsCount: number;
  activeMarketSlugs: string[];
  windowStartTime: number;
  windowEndTime: number;
  windowRemainingSec: number;
  /** BTC price at current window start (when available) */
  windowStartBtcPrice?: number;
  risk: {
    dailyPnL: number;
    openPositions: number;
    tradesLastMinute: number;
  };
  stats: {
    cyclesRun: number;
    opportunitiesFound: number;
    tradesExecuted: number;
    totalProfit: number;
    startTime: number;
    /** Lifetime count of trades that ended with profit > 0 (for win rate %) */
    profitableTrades?: number;
  };
  demoBalance?: { startingUsd: number; currentUsd: number };
  mode: "dry_run" | "live";
  /** Recent persisted logs to hydrate initial dashboard view. */
  recentLogs?: LogEntry[];
  executions: Array<{
    marketSlug: string;
    actualProfit: number;
    fullyExecuted: boolean;
    settled: boolean;
    timestamp: number;
    side: "UP" | "DOWN";
    entry: string;
    size: number;
    marketWindowStart: number;
    marketWindowEnd: number;
    unrealizedProfit: number | null;
    lossCapped?: boolean;
  }>;
  /** Historical markets from persistent storage */
  historicalMarkets?: HistoricalMarket[];
}

export interface LogEntry {
  level: string;
  message: string;
  timestamp: string;
  meta?: string;
}

export function useBotConnection() {
  const [connected, setConnected] = useState(false);
  const [state, setState] = useState<BotState | null>(null);
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [pnlHistory, setPnlHistory] = useState<{ t: number; v: number }[]>([]);
  const [btcHistory, setBtcHistory] = useState<{ t: number; v: number }[]>([]);
  const wsRef = useRef<WebSocket | null>(null);
  const reconnectTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const reconnectAttempts = useRef(0);

  const connect = useCallback(() => {
    if (wsRef.current?.readyState === WebSocket.OPEN) return;
    setError(null);
    const ws = new WebSocket(WS_URL);
    wsRef.current = ws;

    ws.onopen = () => {
      setConnected(true);
      reconnectAttempts.current = 0;
    };

    ws.onmessage = (event) => {
      try {
        const msg = JSON.parse(event.data as string);
        if (msg.type === "state") {
          const s = msg.payload as BotState;
          setState(s);
          if (Array.isArray(s.recentLogs) && s.recentLogs.length > 0) {
            setLogs((prev) =>
              prev.length > 0
                ? prev
                : sortLogsChronological(s.recentLogs!).slice(-MAX_LOGS)
            );
          }
          if (s.stats.totalProfit !== undefined) {
            setPnlHistory((prev) => {
              const next = [...prev, { t: Date.now(), v: s.stats.totalProfit }];
              return next; // keep all time for PNL chart
            });
          }
          if (s.btcPrice != null) {
            setBtcHistory((prev) => {
              const now = Date.now();
              const next = [...prev, { t: now, v: s.btcPrice! }];
              const cutoff = now - FIVE_MIN_MS;
              const filtered = next.filter((pt) => pt.t >= cutoff);
              return filtered.length > MAX_BTC_POINTS_5M ? filtered.slice(-MAX_BTC_POINTS_5M) : filtered;
            });
          }
        } else if (msg.type === "log") {
          setLogs((prev) => {
            const next = sortLogsChronological([
              ...prev,
              msg.payload as LogEntry,
            ]);
            return next.length > MAX_LOGS
              ? next.slice(next.length - MAX_LOGS)
              : next;
          });
        }
      } catch (_) {}
    };

    ws.onclose = () => {
      setConnected(false);
      wsRef.current = null;
      const delay = Math.min(1000 * 2 ** reconnectAttempts.current, 30000);
      reconnectAttempts.current += 1;
      reconnectTimeoutRef.current = setTimeout(connect, delay);
    };

    ws.onerror = () => {
      setError("Connection error");
    };
  }, []);

  useEffect(() => {
    connect();
    return () => {
      if (reconnectTimeoutRef.current) clearTimeout(reconnectTimeoutRef.current);
      wsRef.current?.close();
      wsRef.current = null;
    };
  }, [connect]);

  return { connected, state, logs, error, pnlHistory, btcHistory };
}

/** Format Unix seconds to "12:40AM-12:45AM ET" style */
export function formatWindowRange(startSec: number, endSec: number): string {
  const start = new Date(startSec * 1000);
  const end = new Date(endSec * 1000);
  const fmt = (d: Date) =>
    d.toLocaleTimeString("en-US", {
      hour: "numeric",
      minute: "2-digit",
      hour12: true,
      timeZone: "America/New_York",
    });
  return `${fmt(start)}-${fmt(end)} ET`;
}

/** Format seconds remaining as "M:SS" */
export function formatRemaining(sec: number): string {
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return `${m}:${s.toString().padStart(2, "0")}`;
}
