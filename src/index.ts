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
  // Start dashboard FIRST using PORT from Railway (or DASHBOARD_WS_PORT for local dev)
  // This ensures dashboard is available even if config loading or bot startup fails
  const port = Number(process.env.PORT || process.env.DASHBOARD_WS_PORT || "8765") || 0;
  let dashboard: DashboardServer | null = null;
  
  if (port > 0) {
    dashboard = new DashboardServer(port);
    dashboard.start();
    setDashboardLogBroadcast((entry) => dashboard!.broadcastLog(entry));
    logger.info(`Dashboard server started on port ${port}`);
  }

  // Now try to load config and start bot
  // If this fails, dashboard will still be serving
  let config: ReturnType<typeof loadConfig> | null = null;
  let bot: PolymarketArbBot | null = null;
  let sessionFile: string | undefined = undefined;
  let periodicSave: ReturnType<typeof setInterval> | null = null;

  try {
    config = loadConfig();
    sessionFile = config.sessionFile ?? "data/session.json";
    const loadedSession = loadSession(sessionFile);
    if (loadedSession) {
      logger.info(
        `Restored session: lifetime PnL $${loadedSession.totalProfit.toFixed(4)}, total trades ${loadedSession.totalTradesExecuted}`
      );
    }

    bot = new PolymarketArbBot(config, dashboard, loadedSession);

    // Handle graceful shutdown
    const shutdown = async (signal: string) => {
      logger.info(`Received ${signal}, shutting down...`);
      setDashboardLogBroadcast(null);
      dashboard?.stop();
      if (bot) {
        const snapshot = bot.getSessionSnapshot();
        if (sessionFile) {
          saveSession(sessionFile, snapshot);
        }
        await bot.stop();
      }
      process.exit(0);
    };

    const PERIODIC_SAVE_MS = 5 * 60 * 1000; // 5 minutes
    periodicSave = setInterval(() => {
      if (bot && sessionFile) {
        try {
          saveSession(sessionFile, bot.getSessionSnapshot());
        } catch (e) {
          logger.warn("Periodic session save failed", { error: String(e) });
        }
      }
    }, PERIODIC_SAVE_MS);

    const shutdownWithCleanup = async (signal: string) => {
      if (periodicSave) clearInterval(periodicSave);
      await shutdown(signal);
    };
    process.on("SIGINT", () => shutdownWithCleanup("SIGINT"));
    process.on("SIGTERM", () => shutdownWithCleanup("SIGTERM"));

    try {
      await bot.start();
    } catch (error) {
      logger.error("Bot failed to start", { error: String(error) });
      // If dashboard is serving, keep process alive so dashboard stays up (e.g. on Railway)
      if (!dashboard) {
        process.exit(1);
      }
    }
  } catch (error) {
    logger.error("Failed to load config or create bot", { error: String(error) });
    // If dashboard is serving, keep process alive so dashboard stays up (e.g. on Railway)
    if (!dashboard) {
      process.exit(1);
    }
    // Otherwise, keep process alive so dashboard continues serving
  }
}

main();
