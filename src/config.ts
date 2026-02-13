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
  return {
    polymarketApiUrl: optionalEnv(
      "POLYMARKET_API_URL",
      "https://clob.polymarket.com"
    ),
    polymarketGammaUrl: optionalEnv(
      "POLYMARKET_GAMMA_URL",
      "https://gamma-api.polymarket.com"
    ),
    polygonPrivateKey: requireEnv("POLYGON_PRIVATE_KEY"),
    polygonRpcUrl: optionalEnv("POLYGON_RPC_URL", "https://polygon-rpc.com"),
    binanceApiKey: optionalEnv("BINANCE_API_KEY", ""),
    binanceApiSecret: optionalEnv("BINANCE_API_SECRET", ""),
    minProfitThresholdCents: Number(
      optionalEnv("MIN_PROFIT_THRESHOLD_CENTS", "2")
    ),
    maxPositionSizeUsdc: Number(optionalEnv("MAX_POSITION_SIZE_USDC", "100")),
    pollIntervalMs: Number(optionalEnv("POLL_INTERVAL_MS", "1000")),
    dryRun: optionalEnv("DRY_RUN", "true") === "true",
  };
}
