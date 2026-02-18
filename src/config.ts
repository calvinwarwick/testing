import dotenv from "dotenv";
import { BotConfig } from "./types";

dotenv.config();

function requireEnv(key: string): string {
  const value = process.env[key];
  if (!value) {
    throw new Error(`Missing required environment variable: ${key}`);
  }
  return value;
}

function optionalEnv(key: string, defaultValue: string): string {
  return process.env[key] || defaultValue;
}

export function loadConfig(): BotConfig {
  const dryRun = optionalEnv("DRY_RUN", "true") === "true";
  const config: BotConfig = {
    polymarketApiUrl: optionalEnv(
      "POLYMARKET_API_URL",
      "https://clob.polymarket.com"
    ),
    polymarketGammaUrl: optionalEnv(
      "POLYMARKET_GAMMA_URL",
      "https://gamma-api.polymarket.com"
    ),
    polygonPrivateKey: dryRun
      ? optionalEnv("POLYGON_PRIVATE_KEY", "0x0000000000000000000000000000000000000000000000000000000000000001")
      : requireEnv("POLYGON_PRIVATE_KEY"),
    polygonRpcUrl: optionalEnv("POLYGON_RPC_URL", "https://polygon-rpc.com"),
    binanceApiKey: optionalEnv("BINANCE_API_KEY", ""),
    binanceApiSecret: optionalEnv("BINANCE_API_SECRET", ""),
    maxPositionSizeUsdc: Number(optionalEnv("MAX_POSITION_SIZE_USDC", "100")),
    pollIntervalMs: Number(optionalEnv("POLL_INTERVAL_MS", "1000")),
    dryRun,
    btc5mEventSlug: optionalEnv("POLYMARKET_BTC_5M_EVENT_SLUG", "") || undefined,
    dashboardWsPort: Number(process.env.PORT ?? optionalEnv("DASHBOARD_WS_PORT", "8765")) || 0,
    maxOpenPositions: Math.max(1, Number(optionalEnv("MAX_OPEN_POSITIONS", "50")) || 50),
    sessionFile: optionalEnv("SESSION_FILE", "data/session.json") || undefined,
    minTimeBetweenTradesMs: Math.max(
      0,
      Number(optionalEnv("MIN_TIME_BETWEEN_TRADES_MS", "2000")) || 2000
    ),
    maxTradesPerMinute: Math.max(1, Number(optionalEnv("MAX_TRADES_PER_MINUTE", "50")) || 50),
    directionalOnly: optionalEnv("DIRECTIONAL_ONLY", "true") === "true",
    minEdgePercent: Math.max(1, Math.min(50, Number(optionalEnv("MIN_EDGE_PERCENT", "8")) || 8)),
    exchangeSignalThresholdPercent: Math.max(0.01, Math.min(1, Number(optionalEnv("EXCHANGE_SIGNAL_THRESHOLD_PERCENT", "0.03")) || 0.03)),
    minExchangeMovePercent: Math.max(0.03, Math.min(1, Number(optionalEnv("MIN_EXCHANGE_MOVE_PERCENT", "0.05")) || 0.05)),
    minSecondsRemainingInWindow: Math.max(10, Math.min(240, Number(optionalEnv("MIN_SECONDS_REMAINING_IN_WINDOW", "10")) || 10)),
    demoStartingBalance: Math.max(100, Number(optionalEnv("DEMO_STARTING_BALANCE", "1000")) || 1000),
    forceRealData: optionalEnv("FORCE_REAL_DATA", "false") === "true",
    chainlinkDsApiKey: optionalEnv("CHAINLINK_DS_API_KEY", "") || undefined,
    chainlinkDsApiSecret: optionalEnv("CHAINLINK_DS_API_SECRET", "") || undefined,
    chainlinkBtcUsdFeedId: optionalEnv("CHAINLINK_BTC_USD_FEED_ID", "") || undefined,
    kellyMultiplier: Math.max(0.05, Math.min(1.0, Number(optionalEnv("KELLY_MULTIPLIER", "0.25")) || 0.25)),
    stopLossPercent: Math.max(0, Math.min(1, Number(optionalEnv("STOP_LOSS_PERCENT", "0.10")) || 0.10)),
  };
  return config;
}
