import http from "http";
import { WebSocketServer, WebSocket } from "ws";

/** Historical market record */
export interface HistoricalMarketRecord {
  windowStart: number;
  windowEnd: number;
  btcPriceAtStart: number;
  btcPriceAtEnd: number;
  outcome: "UP" | "DOWN";
  recordedAt: number;
}

/** State broadcast to the dashboard (serializable). */
export interface DashboardState {
  btcPrice: number | null;
  btcTimestamp: number;
  /** Per-exchange BTC prices (binance, coinbase, okx, bybit, kraken, bitfinex) */
  cexPrices: Record<string, number>;
  /** Per-exchange BTC prices at window start (binance, coinbase, okx, bybit, kraken, bitfinex) */
  cexWindowStartPrices?: Record<string, number>;
  /** Current 5-min market YES (UP) and NO (DOWN) best ask prices (0–1) */
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
  /** Demo mode: starting balance and current balance (starting + totalProfit) */
  demoBalance?: { startingUsd: number; currentUsd: number };
  mode: "dry_run" | "live";
  /** Recent persisted logs (sent with state to hydrate dashboard on startup). */
  recentLogs?: DashboardLogEntry[];
  executions: Array<{
    marketSlug: string;
    actualProfit: number;
    fullyExecuted: boolean;
    settled: boolean;
    pendingSettlement?: boolean;
    timestamp: number;
    side: "UP" | "DOWN";
    entry: string;
    size: number;
    marketWindowStart: number;
    marketWindowEnd: number;
    /** Live mark-to-market PnL for open positions (null when settled or no price) */
    unrealizedProfit: number | null;
    /** True when a loss was capped by stop-loss (so P/L is not the full loss) */
    lossCapped?: boolean;
    /** Optional stable id (e.g. from persisted trade record) for list keys */
    id?: string;
    /** Kelly Criterion fraction used for sizing */
    kellyFraction?: number;
    /** Estimated win probability at entry */
    estimatedWinProbability?: number;
    /** True when position was exited by trailing take-profit */
    profitTaken?: boolean;
  }>;
  /** Full history of all trades from persisted log (newest first), for Closed tab */
  tradeHistory?: DashboardState["executions"];
  /** Historical markets (last 100) */
  historicalMarkets?: HistoricalMarketRecord[];
}

export interface DashboardLogEntry {
  level: string;
  message: string;
  timestamp: string;
  meta?: string;
}

export class DashboardServer {
  private httpServer: http.Server | null = null;
  private wss: WebSocketServer | null = null;
  private clients: Set<WebSocket> = new Set();
  private lastState: DashboardState | null = null;

  constructor(private port: number) {}

  start(): void {
    if (this.port <= 0) return;
    try {
      const server = http.createServer((req, res) => {
        res.writeHead(200, { "Content-Type": "text/plain" });
        res.end("ok");
      });
      this.wss = new WebSocketServer({ noServer: true });
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
      server.on("upgrade", (req, socket, head) => {
        this.wss!.handleUpgrade(req, socket, head, (ws) => {
          this.wss!.emit("connection", ws, req);
        });
      });
      server.listen(this.port, () => {
        console.log(`Dashboard server listening on port ${this.port} (HTTP + WebSocket)`);
      });
      this.httpServer = server;
      this.httpServer.on("error", (err) => {
        console.warn(`Dashboard server error: ${err}`);
        this.stop();
      });
    } catch (err) {
      console.warn(`Dashboard server failed to start on port ${this.port}: ${err}`);
      return;
    }
  }

  stop(): void {
    this.clients.forEach((c) => c.close());
    this.clients.clear();
    if (this.wss) {
      this.wss.close();
      this.wss = null;
    }
    if (this.httpServer) {
      this.httpServer.close();
      this.httpServer = null;
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
