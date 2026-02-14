import { useState, useEffect, useRef, useCallback } from "react";

const WS_PORT = "8765";
const WS_URL =
  import.meta.env.VITE_WS_URL ||
  (typeof window !== "undefined"
    ? `ws://${window.location.hostname}:${WS_PORT}`
    : `ws://localhost:${WS_PORT}`);
const MAX_LOGS = 500;
const MAX_CHART_POINTS = 120;

export interface BotState {
  btcPrice: number | null;
  btcTimestamp: number;
  cexPrices: Record<string, number>;
  activeMarketsCount: number;
  activeMarketSlugs: string[];
  windowStartTime: number;
  windowEndTime: number;
  windowRemainingSec: number;
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
  };
  demoBalance?: { startingUsd: number; currentUsd: number };
  mode: "dry_run" | "live";
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
  }>;
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
  const tickRef = useRef(0);

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
          tickRef.current += 1;
          const t = tickRef.current;
          if (s.stats.totalProfit !== undefined) {
            setPnlHistory((prev) => {
              const next = [...prev, { t, v: s.stats.totalProfit }];
              return next.length > MAX_CHART_POINTS ? next.slice(-MAX_CHART_POINTS) : next;
            });
          }
          if (s.btcPrice != null) {
            setBtcHistory((prev) => {
              const next = [...prev, { t, v: s.btcPrice! }];
              return next.length > MAX_CHART_POINTS ? next.slice(-MAX_CHART_POINTS) : next;
            });
          }
        } else if (msg.type === "log") {
          setLogs((prev) => {
            const next = [...prev, msg.payload as LogEntry];
            return next.length > MAX_LOGS ? next.slice(-MAX_LOGS) : next;
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
