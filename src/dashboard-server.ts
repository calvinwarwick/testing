import { WebSocketServer, WebSocket } from "ws";

/** State broadcast to the dashboard (serializable). */
export interface DashboardState {
  btcPrice: number | null;
  btcTimestamp: number;
  /** Per-exchange BTC prices (binance, coinbase, okx, bybit, kraken, bitfinex) */
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
  /** Demo mode: starting balance and current balance (starting + totalProfit) */
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
    /** Live mark-to-market PnL for open positions (null when settled or no price) */
    unrealizedProfit: number | null;
  }>;
}

export interface DashboardLogEntry {
  level: string;
  message: string;
  timestamp: string;
  meta?: string;
}

export class DashboardServer {
  private wss: WebSocketServer | null = null;
  private clients: Set<WebSocket> = new Set();
  private lastState: DashboardState | null = null;

  constructor(private port: number) {}

  start(): void {
    if (this.port <= 0) return;
    try {
      this.wss = new WebSocketServer({ port: this.port });
    } catch (err) {
      console.warn(`Dashboard WebSocket failed to start on port ${this.port}: ${err}`);
      return;
    }
    this.wss.on("error", (err) => {
      console.warn(`Dashboard WebSocket error: ${err}`);
      this.stop();
    });
    this.wss.on("connection", (ws) => {
      this.clients.add(ws);
      if (this.lastState) {
        try {
          ws.send(JSON.stringify({ type: "state", payload: this.lastState }));
        } catch (_) {}
      }
      ws.on("close", () => this.clients.delete(ws));
      ws.on("error", () => this.clients.delete(ws));
    });
    console.log(`Dashboard WebSocket server listening on ws://localhost:${this.port}`);
  }

  stop(): void {
    if (this.wss) {
      this.clients.forEach((c) => c.close());
      this.clients.clear();
      this.wss.close();
      this.wss = null;
    }
  }

  broadcastState(state: DashboardState): void {
    this.lastState = state;
    const msg = JSON.stringify({ type: "state", payload: state });
    this.clients.forEach((ws) => {
      try {
        if (ws.readyState === WebSocket.OPEN) ws.send(msg);
      } catch (_) {}
    });
  }

  broadcastLog(entry: DashboardLogEntry): void {
    const msg = JSON.stringify({ type: "log", payload: entry });
    this.clients.forEach((ws) => {
      try {
        if (ws.readyState === WebSocket.OPEN) ws.send(msg);
      } catch (_) {}
    });
  }
}
