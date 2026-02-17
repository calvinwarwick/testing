import type { BotConfig } from "./types";
import type { PolymarketArbBot } from "./bot";
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
  logger.info(`Using PORT: ${port}`);
  let dashboard: DashboardServer | null = null;
  let dashboardStarted = false;

  if (port > 0) {
    dashboard = new DashboardServer(port);
    dashboardStarted = await dashboard.start();
    if (dashboardStarted) {
      setDashboardLogBroadcast((entry) => dashboard!.broadcastLog(entry));
      logger.info(`Dashboard server started on port ${port}`);
    } else {
      logger.error(`Dashboard server failed to start on port ${port}`);
      dashboard = null;
    }
  }

  // Load config and bot only after server is listening (defer heavy imports so crashes don't prevent dashboard from starting)
  let config: BotConfig | null = null;
  let bot: PolymarketArbBot | null = null;
  let sessionFile: string | undefined = undefined;
  let periodicSave: ReturnType<typeof setInterval> | null = null;

  try {
    const { loadConfig } = await import("./config");
    config = loadConfig();
    sessionFile = config.sessionFile ?? "data/session.json";
    const loadedSession = loadSession(sessionFile);
    if (loadedSession) {
      logger.info(
        `Restored session: lifetime PnL $${loadedSession.totalProfit.toFixed(4)}, total trades ${loadedSession.totalTradesExecuted}`
      );
    }

    const { PolymarketArbBot: BotClass } = await import("./bot");
    bot = new BotClass(config, dashboard, loadedSession);

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
      if (!dashboardStarted) {
        process.exit(1);
      }
      // Otherwise, keep process alive so dashboard continues serving
    }
  } catch (error) {
    logger.error("Failed to load config or create bot", { error: String(error) });
    // If dashboard is serving, keep process alive so dashboard stays up (e.g. on Railway)
    if (!dashboardStarted) {
      process.exit(1);
    }
    // Otherwise, keep process alive so dashboard continues serving
  }
  
  // Keep process alive if dashboard is running
  // The HTTP server will keep the event loop active, but we add an explicit keep-alive
  // to ensure the process doesn't exit even if there are no active connections
  if (dashboardStarted) {
    logger.info("Dashboard is running - process will stay alive to serve requests");
    // The HTTP server keeps the event loop alive, so we don't need to do anything else
    // But we log this to confirm the process should stay running
  }
}

// Handle unhandled promise rejections
process.on("unhandledRejection", (reason, promise) => {
  logger.error("Unhandled promise rejection", { reason: String(reason), promise: String(promise) });
  // Don't exit if dashboard is running - keep serving
});

process.on("uncaughtException", (error) => {
  logger.error("Uncaught exception", { error: String(error) });
  // Don't exit if dashboard is running - keep serving
});

main().catch((error) => {
  logger.error("Main function failed", { error: String(error) });
  // Don't exit - let the process stay alive if dashboard is serving
  // The HTTP server will keep the event loop alive
});
