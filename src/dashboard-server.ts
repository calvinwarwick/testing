import http from "http";
import { WebSocketServer, WebSocket } from "ws";
import * as fs from "fs";
import * as path from "path";

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
  private dashboardDistPath: string;

  constructor(private port: number) {
    // Path to built dashboard static files
    // When running from dist/index.js, __dirname is dist/, so ../dashboard/dist goes up one level to project root
    this.dashboardDistPath = path.resolve(__dirname, "../dashboard/dist");
  }

  private serveStaticFile(req: http.IncomingMessage, res: http.ServerResponse): void {
    let filePath = req.url || "/";

    // Default to index.html for root or non-file requests
    if (filePath === "/" || !filePath.includes(".")) {
      filePath = "/index.html";
    }

    // Remove query string
    const cleanPath = filePath.split("?")[0];
    const fullPath = path.join(this.dashboardDistPath, cleanPath);

    // Security: prevent directory traversal
    if (!fullPath.startsWith(this.dashboardDistPath)) {
      res.writeHead(403, { "Content-Type": "text/plain" });
      res.end("Forbidden");
      return;
    }

    // Check if file exists
    if (!fs.existsSync(fullPath) || !fs.statSync(fullPath).isFile()) {
      // Fallback to index.html for SPA routing
      const indexPath = path.join(this.dashboardDistPath, "index.html");
      if (fs.existsSync(indexPath)) {
        try {
          const content = fs.readFileSync(indexPath);
          res.writeHead(200, { "Content-Type": "text/html" });
          res.end(content);
        } catch (err) {
          console.warn(`Failed to read index.html: ${err}`);
          res.writeHead(500, { "Content-Type": "text/plain" });
          res.end("Internal Server Error");
        }
      } else {
        res.writeHead(404, { "Content-Type": "text/plain" });
        res.end("Not Found");
      }
      return;
    }

    // Determine content type
    const ext = path.extname(fullPath).toLowerCase();
    const contentTypes: Record<string, string> = {
      ".html": "text/html",
      ".js": "application/javascript",
      ".css": "text/css",
      ".json": "application/json",
      ".png": "image/png",
      ".jpg": "image/jpeg",
      ".jpeg": "image/jpeg",
      ".gif": "image/gif",
      ".svg": "image/svg+xml",
      ".ico": "image/x-icon",
      ".woff": "font/woff",
      ".woff2": "font/woff2",
      ".ttf": "font/ttf",
      ".eot": "application/vnd.ms-fontobject",
    };

    const contentType = contentTypes[ext] || "application/octet-stream";
    try {
      const content = fs.readFileSync(fullPath);
      res.writeHead(200, { "Content-Type": contentType });
      res.end(content);
    } catch (err) {
      console.warn(`Failed to read file ${fullPath}: ${err}`);
      res.writeHead(500, { "Content-Type": "text/plain" });
      res.end("Internal Server Error");
    }
  }

  start(): void {
    if (this.port <= 0) return;
    try {
      // Verify dashboard dist path exists
      const distExists = fs.existsSync(this.dashboardDistPath);
      if (!distExists) {
        console.warn(`Dashboard dist directory not found at: ${this.dashboardDistPath}`);
        console.warn("Dashboard will not be served. Run 'npm run build:dashboard' to build it.");
      } else {
        console.log(`Dashboard dist directory found at: ${this.dashboardDistPath}`);
      }

      const server = http.createServer((req, res) => {
        // WebSocket upgrades are handled by server.on("upgrade") event handler
        // The HTTP request handler should only handle regular HTTP requests
        // Note: WebSocket upgrade requests trigger the "upgrade" event, not this handler
        
        // Check if dashboard dist directory exists
        if (distExists) {
          this.serveStaticFile(req, res);
        } else {
          // Fallback if dashboard not built
          res.writeHead(200, { "Content-Type": "text/plain" });
          res.end("Dashboard not built. Run 'npm run build:dashboard' first.");
        }
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
