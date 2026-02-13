import { ExchangeFeed } from "./feeds/exchange-feed";
import { PolymarketFeed } from "./feeds/polymarket-feed";
import { ArbitrageDetector } from "./arbitrage/detector";
import { Trader } from "./execution/trader";
import { RiskManager } from "./utils/risk";
import { logger } from "./utils/logger";
import {
  getCurrentFiveMinWindow,
  secondsRemainingInWindow,
  formatTimestamp,
} from "./utils/time";
import {
  BotConfig,
  PolymarketMarket,
  ArbitrageOpportunity,
  ArbitrageExecution,
} from "./types";

/**
 * Main bot orchestrator.
 *
 * Lifecycle per 5-minute window:
 *
 * 1. DISCOVER: Find active BTC 5-min markets on Polymarket
 * 2. REFERENCE: Record the BTC price at the window's open from the exchange
 * 3. MONITOR: Poll exchange + Polymarket prices every ~1 second
 * 4. DETECT: Check if YES_ask + NO_ask < $1.00 (pure arbitrage)
 *    or if exchange price diverges from Polymarket implied price
 * 5. EXECUTE: If opportunity passes risk checks, buy both YES + NO
 * 6. SETTLE: After the 5-min window resolves, one side pays $1.00
 *
 * The profit comes from the guaranteed $1.00 payout minus total cost.
 */
export class PolymarketArbBot {
  private readonly config: BotConfig;
  private readonly exchangeFeed: ExchangeFeed;
  private readonly polymarketFeed: PolymarketFeed;
  private readonly detector: ArbitrageDetector;
  private readonly trader: Trader;
  private readonly riskManager: RiskManager;

  private isRunning = false;
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private activeMarkets: PolymarketMarket[] = [];
  private executions: ArbitrageExecution[] = [];
  private stats = {
    cyclesRun: 0,
    opportunitiesFound: 0,
    tradesExecuted: 0,
    totalProfit: 0,
    startTime: 0,
  };

  constructor(config: BotConfig) {
    this.config = config;
    this.exchangeFeed = new ExchangeFeed();
    this.polymarketFeed = new PolymarketFeed(
      config.polymarketGammaUrl,
      config.polymarketApiUrl
    );
    this.detector = new ArbitrageDetector(
      config.minProfitThresholdCents,
      config.maxPositionSizeUsdc
    );
    this.trader = new Trader(config);
    this.riskManager = new RiskManager({
      maxPositionUsdc: config.maxPositionSizeUsdc,
    });
  }

  /**
   * Start the bot. Initializes all components and begins the main loop.
   */
  async start(): Promise<void> {
    logger.info("=== Polymarket Arbitrage Bot Starting ===");
    logger.info(`Mode: ${this.config.dryRun ? "DRY RUN" : "LIVE TRADING"}`);
    logger.info(`Min profit threshold: ${this.config.minProfitThresholdCents}c`);
    logger.info(`Max position size: $${this.config.maxPositionSizeUsdc}`);
    logger.info(`Poll interval: ${this.config.pollIntervalMs}ms`);

    this.isRunning = true;
    this.stats.startTime = Date.now();

    // Initialize components
    await this.exchangeFeed.start();
    await this.trader.initialize();

    // Wait a moment for exchange price to arrive
    await this.sleep(2000);

    // Start the main polling loop
    this.runMainLoop();
  }

  /**
   * Stop the bot gracefully.
   */
  async stop(): Promise<void> {
    logger.info("Stopping bot...");
    this.isRunning = false;

    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }

    this.exchangeFeed.stop();

    this.printStats();
    logger.info("=== Bot Stopped ===");
  }

  /**
   * Main loop: discover markets, monitor prices, detect and execute arbs.
   */
  private async runMainLoop(): Promise<void> {
    // Discover markets on startup
    await this.discoverMarkets();

    // Run the polling cycle
    const poll = async () => {
      if (!this.isRunning) return;

      try {
        await this.cycle();
      } catch (error) {
        logger.error("Error in polling cycle", { error: String(error) });
      }

      // Schedule next cycle
      if (this.isRunning) {
        setTimeout(poll, this.config.pollIntervalMs);
      }
    };

    poll();

    // Re-discover markets every 60 seconds (new windows open frequently)
    setInterval(async () => {
      if (this.isRunning) {
        await this.discoverMarkets();
      }
    }, 60000);
  }

  /**
   * Discover active 5-minute BTC markets on Polymarket.
   */
  private async discoverMarkets(): Promise<void> {
    const markets = await this.polymarketFeed.findActiveCryptoMarkets("BTC");
    this.activeMarkets = markets.filter((m) => m.active);

    if (this.activeMarkets.length === 0) {
      logger.warn("No active BTC 5-min markets found on Polymarket");
    } else {
      logger.info(
        `Tracking ${this.activeMarkets.length} active market(s): ${this.activeMarkets.map((m) => m.slug).join(", ")}`
      );
    }

    // Set the reference price for the current window
    const exchangePrice = this.exchangeFeed.getLatestPrice();
    if (exchangePrice) {
      const { startTime } = getCurrentFiveMinWindow();
      this.detector.setWindowReference(exchangePrice.price, startTime);
    }
  }

  /**
   * A single monitoring cycle. Called every pollIntervalMs.
   */
  private async cycle(): Promise<void> {
    this.stats.cyclesRun++;

    const exchangePrice = this.exchangeFeed.getLatestPrice();
    if (!exchangePrice) {
      logger.debug("No exchange price available yet");
      return;
    }

    // Log timing info periodically
    if (this.stats.cyclesRun % 30 === 0) {
      const remaining = secondsRemainingInWindow();
      const risk = this.riskManager.getState();
      logger.info(
        `BTC: $${exchangePrice.price.toFixed(2)} | ` +
          `Window: ${remaining}s remaining | ` +
          `Markets: ${this.activeMarkets.length} | ` +
          `PnL: $${risk.dailyPnL.toFixed(4)} | ` +
          `Open: ${risk.openPositions}`
      );
    }

    // Check each active market for arbitrage opportunities
    for (const market of this.activeMarkets) {
      const prices = await this.polymarketFeed.getMarketPrices(market);
      if (!prices) continue;

      // --- Pure arbitrage: YES_ask + NO_ask < $1.00 ---
      const arbOpportunity = this.detector.detectArbitrage(
        prices,
        exchangePrice
      );
      if (arbOpportunity) {
        await this.handleOpportunity(arbOpportunity);
        continue; // Skip directional check if pure arb exists
      }

      // --- Directional: exchange price diverges from Polymarket ---
      const directionalOpp = this.detector.detectDirectionalOpportunity(
        prices,
        exchangePrice
      );
      if (directionalOpp) {
        await this.handleOpportunity(directionalOpp);
      }
    }
  }

  /**
   * Handle a detected opportunity: risk check, then execute.
   */
  private async handleOpportunity(
    opportunity: ArbitrageOpportunity
  ): Promise<void> {
    this.stats.opportunitiesFound++;

    // Risk check
    const riskCheck = this.riskManager.checkTrade(opportunity);
    if (!riskCheck.allowed) {
      logger.warn(`Trade blocked by risk: ${riskCheck.reason}`);
      return;
    }

    // Execute the arbitrage
    logger.info(
      `Executing opportunity: ${opportunity.market.slug} | ` +
        `Expected profit: $${opportunity.totalExpectedProfit.toFixed(4)}`
    );

    const execution = await this.trader.executeArbitrage(opportunity);
    this.executions.push(execution);
    this.riskManager.recordExecution(execution);

    if (execution.fullyExecuted) {
      this.stats.tradesExecuted++;
      this.stats.totalProfit += execution.actualProfit;
    }
  }

  /**
   * Print session statistics.
   */
  private printStats(): void {
    const runtime = (Date.now() - this.stats.startTime) / 1000;
    logger.info("=== Session Statistics ===");
    logger.info(`Runtime: ${runtime.toFixed(0)}s`);
    logger.info(`Cycles run: ${this.stats.cyclesRun}`);
    logger.info(`Opportunities found: ${this.stats.opportunitiesFound}`);
    logger.info(`Trades executed: ${this.stats.tradesExecuted}`);
    logger.info(`Total profit: $${this.stats.totalProfit.toFixed(4)}`);
    logger.info(
      `Profit/hour: $${((this.stats.totalProfit / runtime) * 3600).toFixed(4)}`
    );
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
