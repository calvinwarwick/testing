import { loadConfig } from "./config";
import { PolymarketArbBot } from "./bot";
import { logger } from "./utils/logger";

/**
 * Entry point for the Polymarket 5-minute crypto arbitrage bot.
 *
 * Strategy summary:
 *   - Monitor BTC price on Binance (real-time via WebSocket)
 *   - Monitor YES/NO prices on Polymarket 5-min crypto markets
 *   - When YES_ask + NO_ask < $1.00, buy both sides for guaranteed profit
 *   - The price delay between exchanges and Polymarket's oracle creates
 *     windows where both sides are temporarily cheap
 *
 * Usage:
 *   DRY_RUN=true npm run dev     # Paper trading (logs only, no real orders)
 *   DRY_RUN=false npm run dev    # Live trading (requires funded wallet)
 */
async function main(): Promise<void> {
  try {
    const config = loadConfig();
    const bot = new PolymarketArbBot(config);

    // Handle graceful shutdown
    const shutdown = async (signal: string) => {
      logger.info(`Received ${signal}, shutting down...`);
      await bot.stop();
      process.exit(0);
    };

    process.on("SIGINT", () => shutdown("SIGINT"));
    process.on("SIGTERM", () => shutdown("SIGTERM"));

    await bot.start();
  } catch (error) {
    logger.error("Fatal error", { error: String(error) });
    process.exit(1);
  }
}

main();
