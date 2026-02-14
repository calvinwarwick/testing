import winston from "winston";
import Transport from "winston-transport";
import * as fs from "fs";
import * as path from "path";
import type { TradeRecord } from "../types";
import "winston-daily-rotate-file";

const { combine, timestamp, printf, colorize } = winston.format;

// Data directories - use absolute paths based on project root
const PROJECT_ROOT = path.resolve(__dirname, "../..");
const DATA_DIR = path.join(PROJECT_ROOT, "data");
const LOGS_DIR = path.join(PROJECT_ROOT, "logs");

const botFormat = printf(({ level, message, timestamp, ...meta }) => {
  const metaStr = Object.keys(meta).length ? ` ${JSON.stringify(meta)}` : "";
  return `${timestamp} [${level}] ${message}${metaStr}`;
});

export interface DashboardLogEntry {
  level: string;
  message: string;
  timestamp: string;
  meta?: string;
}

let dashboardBroadcast: ((entry: DashboardLogEntry) => void) | null = null;

export function setDashboardLogBroadcast(fn: ((entry: DashboardLogEntry) => void) | null): void {
  dashboardBroadcast = fn;
}

class DashboardTransport extends Transport {
  log(
    info: { level: string; message: string; timestamp?: string; [key: string]: unknown },
    callback: () => void
  ): void {
    if (dashboardBroadcast) {
      const meta = Object.keys(info).filter(
        (k) => !["level", "message", "timestamp"].includes(k)
      );
      dashboardBroadcast({
        level: info.level,
        message: info.message,
        timestamp: (info.timestamp as string) ?? new Date().toISOString(),
        meta:
          meta.length
            ? JSON.stringify(Object.fromEntries(meta.map((k) => [k, info[k]])))
            : undefined,
      });
    }
    setImmediate(() => this.emit("logged", info));
    callback();
  }
}

// Ensure directories exist
function ensureDir(dir: string): void {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}
ensureDir(DATA_DIR);
ensureDir(LOGS_DIR);

// Daily rotating file transport - keeps logs forever
const dailyRotateTransport = new (winston.transports as any).DailyRotateFile({
  filename: `${LOGS_DIR}/bot-%DATE%.log`,
  datePattern: "YYYY-MM-DD",
  maxFiles: null, // Keep forever
  maxSize: null, // No size limit
});

export const logger = winston.createLogger({
  level: process.env.LOG_LEVEL || "info",
  format: combine(timestamp({ format: "YYYY-MM-DD HH:mm:ss.SSS" }), botFormat),
  transports: [
    new winston.transports.Console({
      format: combine(colorize(), timestamp({ format: "HH:mm:ss.SSS" }), botFormat),
    }),
    dailyRotateTransport,
    new winston.transports.File({
      filename: `${LOGS_DIR}/bot-error.log`,
      level: "error",
    }),
    new DashboardTransport(),
  ],
});

// ============== TRADE RECORDING ==============
const TRADES_FILE = `${DATA_DIR}/trades.json`;
let tradeRecords: TradeRecord[] = [];

export function loadTradeRecords(): TradeRecord[] {
  try {
    if (fs.existsSync(TRADES_FILE)) {
      const data = fs.readFileSync(TRADES_FILE, "utf-8");
      tradeRecords = JSON.parse(data);
      logger.info(`Loaded ${tradeRecords.length} trade records from disk`);
    }
  } catch (err) {
    logger.warn(`Failed to load trade records: ${err}`);
    tradeRecords = [];
  }
  return tradeRecords;
}

function saveTradeRecords(): void {
  try {
    fs.writeFileSync(TRADES_FILE, JSON.stringify(tradeRecords, null, 2), "utf-8");
  } catch (err) {
    logger.error(`Failed to save trade records: ${err}`);
  }
}

export function recordTrade(trade: TradeRecord): void {
  tradeRecords.push(trade);
  saveTradeRecords();
  logger.info(`Trade recorded: ${trade.id} ${trade.side} ${trade.type} $${trade.cost.toFixed(2)}`);
}

export function updateTradeSettlement(
  id: string,
  profit: number,
  btcPriceAtSettlement: number
): void {
  const trade = tradeRecords.find((t) => t.id === id);
  if (trade) {
    trade.settled = true;
    trade.settledAt = Date.now();
    trade.profit = profit;
    trade.outcome = profit > 0 ? "win" : "loss";
    trade.btcPriceAtSettlement = btcPriceAtSettlement;
    saveTradeRecords();
    logger.info(`Trade settled: ${id} ${trade.outcome} $${profit.toFixed(2)}`);
  }
}

export function getTradeRecords(): TradeRecord[] {
  return tradeRecords;
}

export function getTradeStats(): {
  total: number;
  wins: number;
  losses: number;
  pending: number;
  totalProfit: number;
} {
  const settled = tradeRecords.filter((t) => t.settled);
  const wins = settled.filter((t) => t.outcome === "win").length;
  const losses = settled.filter((t) => t.outcome === "loss").length;
  const totalProfit = settled.reduce((sum, t) => sum + (t.profit ?? 0), 0);
  return {
    total: tradeRecords.length,
    wins,
    losses,
    pending: tradeRecords.length - settled.length,
    totalProfit,
  };
}

// ============== HISTORICAL MARKET RECORDING ==============
export interface HistoricalMarket {
  windowStart: number;
  windowEnd: number;
  btcPriceAtStart: number;
  btcPriceAtEnd: number;
  outcome: "UP" | "DOWN";
  recordedAt: number;
}

const MARKETS_FILE = `${DATA_DIR}/historical-markets.json`;
let historicalMarkets: HistoricalMarket[] = [];

export function loadHistoricalMarkets(): HistoricalMarket[] {
  try {
    if (fs.existsSync(MARKETS_FILE)) {
      const data = fs.readFileSync(MARKETS_FILE, "utf-8");
      historicalMarkets = JSON.parse(data);
      logger.info(`Loaded ${historicalMarkets.length} historical market records`);
    }
  } catch (err) {
    logger.warn(`Failed to load historical markets: ${err}`);
    historicalMarkets = [];
  }
  return historicalMarkets;
}

function saveHistoricalMarkets(): void {
  try {
    fs.writeFileSync(MARKETS_FILE, JSON.stringify(historicalMarkets, null, 2), "utf-8");
  } catch (err) {
    logger.error(`Failed to save historical markets: ${err}`);
  }
}

export function recordHistoricalMarket(market: HistoricalMarket): void {
  // Avoid duplicates based on windowEnd
  if (historicalMarkets.some((m) => m.windowEnd === market.windowEnd)) {
    return;
  }
  historicalMarkets.push(market);
  saveHistoricalMarkets();
  logger.info(`Historical market recorded: ${new Date(market.windowEnd * 1000).toISOString()} outcome=${market.outcome}`);
}

export function getHistoricalMarkets(limit?: number): HistoricalMarket[] {
  const sorted = [...historicalMarkets].sort((a, b) => b.windowEnd - a.windowEnd);
  return limit ? sorted.slice(0, limit) : sorted;
}

// ============== PERSISTENT LOG RECORDING ==============
export interface PersistentLogEntry {
  timestamp: string;
  level: string;
  message: string;
  meta?: Record<string, unknown>;
}

const LOGS_JSON_FILE = `${DATA_DIR}/logs.json`;
let persistentLogs: PersistentLogEntry[] = [];
let logsSaveTimer: ReturnType<typeof setTimeout> | null = null;

export function loadPersistentLogs(): PersistentLogEntry[] {
  try {
    if (fs.existsSync(LOGS_JSON_FILE)) {
      const data = fs.readFileSync(LOGS_JSON_FILE, "utf-8");
      persistentLogs = JSON.parse(data);
      logger.info(`Loaded ${persistentLogs.length} persistent log entries`);
    }
  } catch (err) {
    logger.warn(`Failed to load persistent logs: ${err}`);
    persistentLogs = [];
  }
  return persistentLogs;
}

function savePersistentLogs(): void {
  try {
    fs.writeFileSync(LOGS_JSON_FILE, JSON.stringify(persistentLogs, null, 2), "utf-8");
  } catch (err) {
    // Don't use logger here to avoid infinite loop
    console.error(`Failed to save persistent logs: ${err}`);
  }
}

// Debounced save to avoid too many disk writes
function scheduleSaveLogs(): void {
  if (logsSaveTimer) return;
  logsSaveTimer = setTimeout(() => {
    logsSaveTimer = null;
    savePersistentLogs();
  }, 5000); // Save every 5 seconds max
}

export function addPersistentLog(entry: PersistentLogEntry): void {
  persistentLogs.push(entry);
  scheduleSaveLogs();
}

export function getPersistentLogs(limit?: number): PersistentLogEntry[] {
  const sorted = [...persistentLogs].sort(
    (a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime()
  );
  return limit ? sorted.slice(0, limit) : sorted;
}

// Hook into winston to capture all logs persistently
class PersistentLogTransport extends Transport {
  log(
    info: { level: string; message: string; timestamp?: string; [key: string]: unknown },
    callback: () => void
  ): void {
    const meta = Object.keys(info)
      .filter((k) => !["level", "message", "timestamp"].includes(k))
      .reduce((acc, k) => ({ ...acc, [k]: info[k] }), {});

    addPersistentLog({
      timestamp: (info.timestamp as string) ?? new Date().toISOString(),
      level: info.level,
      message: info.message,
      meta: Object.keys(meta).length > 0 ? meta : undefined,
    });

    setImmediate(() => this.emit("logged", info));
    callback();
  }
}

// Add persistent log transport
logger.add(new PersistentLogTransport());
