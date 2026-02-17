import { loadConfig } from "./config";
import { PolymarketArbBot } from "./bot";
import { logger, setDashboardLogBroadcast } from "./utils/logger";
import { DashboardServer } from "./dashboard-server";
import { loadSession, saveSession } from "./session-store";

/**
 * Entry point for the Polymarket 5-minute BTC directional bot.
 *
 * Strategy summary:
 *   - Monitor BTC price on CEX (real-time) and Polymarket 5-min up/down markets
 *   - When CEX signals a direction (vs window start) and Polymarket hasn't fully
 *     priced it in (edge above threshold), take a directional bet (YES or NO)
 *
 * Usage:
 *   DRY_RUN=true npm run dev     # Paper trading (logs only, no real orders)
 *   DRY_RUN=false npm run dev    # Live trading (requires funded wallet)
 */
async function main(): Promise<void> {
  try {
    const config = loadConfig();
    const sessionFile = config.sessionFile ?? "data/session.json";
    const loadedSession = loadSession(sessionFile);
    if (loadedSession) {
      logger.info(
        `Restored session: lifetime PnL $${loadedSession.totalProfit.toFixed(4)}, total trades ${loadedSession.totalTradesExecuted}`
      );
    }

    const dashboard =
      config.dashboardWsPort && config.dashboardWsPort > 0
        ? new DashboardServer(config.dashboardWsPort)
        : null;

    if (dashboard) {
      dashboard.start();
      setDashboardLogBroadcast((entry) => dashboard.broadcastLog(entry));
    }

    const bot = new PolymarketArbBot(config, dashboard, loadedSession);

    // Handle graceful shutdown
    const shutdown = async (signal: string) => {
      logger.info(`Received ${signal}, shutting down...`);
      setDashboardLogBroadcast(null);
      dashboard?.stop();
      const snapshot = bot.getSessionSnapshot();
      saveSession(sessionFile, snapshot);
      await bot.stop();
      process.exit(0);
    };

    const PERIODIC_SAVE_MS = 5 * 60 * 1000; // 5 minutes
    const periodicSave = setInterval(() => {
      try {
        saveSession(sessionFile, bot.getSessionSnapshot());
      } catch (e) {
        logger.warn("Periodic session save failed", { error: String(e) });
      }
    }, PERIODIC_SAVE_MS);

    const shutdownWithCleanup = async (signal: string) => {
      clearInterval(periodicSave);
      await shutdown(signal);
    };
    process.on("SIGINT", () => shutdownWithCleanup("SIGINT"));
    process.on("SIGTERM", () => shutdownWithCleanup("SIGTERM"));

    await bot.start();
  } catch (error) {
    logger.error("Fatal error", { error: String(error) });
    process.exit(1);
  }
}

main();
