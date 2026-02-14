import { ExchangeFeed } from "./feeds/exchange-feed";
import { PolymarketFeed } from "./feeds/polymarket-feed";
import { ArbitrageDetector } from "./arbitrage/detector";
import { Trader } from "./execution/trader";
import { RiskManager } from "./utils/risk";
import { logger } from "./utils/logger";
import {
  getCurrentFiveMinWindow,
  secondsRemainingInWindow,
} from "./utils/time";
import {
  BotConfig,
  PolymarketMarket,
  ArbitrageOpportunity,
  ArbitrageExecution,
  PersistedSession,
} from "./types";
import type { DashboardServer, DashboardState } from "./dashboard-server";

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
const MAX_EXECUTIONS_FOR_DASHBOARD = 50;

export class PolymarketArbBot {
  private readonly config: BotConfig;
  private readonly exchangeFeed: ExchangeFeed;
  private readonly polymarketFeed: PolymarketFeed;
  private readonly detector: ArbitrageDetector;
  private readonly trader: Trader;
  private readonly riskManager: RiskManager;
  private readonly dashboard: DashboardServer | null;

  private isRunning = false;
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private activeMarkets: PolymarketMarket[] = [];
  private executions: ArbitrageExecution[] = [];
  private releasedPositionKeys = new Set<string>();
  /** Latest prices per market slug for unrealized PnL (updated each cycle) */
  private lastMarketPricesBySlug = new Map<string, { yesBestAsk: number; noBestAsk: number }>();
  /** Track BTC price at the actual start of each market window (keyed by market.startTime) */
  private windowStartPrices = new Map<number, number>();
  private stats = {
    cyclesRun: 0,
    opportunitiesFound: 0,
    tradesExecuted: 0,
    directionalTradesExecuted: 0,
    totalProfit: 0,
    startTime: 0,
  };
  /** Lifetime totals from persisted session + this run (for saving). */
  private lifetimeTotalProfit: number = 0;
  private lifetimeTradesExecuted: number = 0;
  private lifetimeProfitableTrades: number = 0;
  private firstRunAt: number | undefined = undefined;

  constructor(
    config: BotConfig,
    dashboard: DashboardServer | null = null,
    initialSession: PersistedSession | null = null
  ) {
    this.config = config;
    this.dashboard = dashboard ?? null;
    this.exchangeFeed = new ExchangeFeed();
    this.polymarketFeed = new PolymarketFeed(
      config.polymarketGammaUrl,
      config.polymarketApiUrl,
      config.btc5mEventSlug
    );
    this.detector = new ArbitrageDetector(
      config.minProfitThresholdCents,
      config.maxPositionSizeUsdc
    );
    this.trader = new Trader(config);
    this.riskManager = new RiskManager({
      maxPositionUsdc: config.maxPositionSizeUsdc,
      maxOpenPositions: config.maxOpenPositions,
      minTimeBetweenTradesMs: config.minTimeBetweenTradesMs,
      maxProfitPercentBeforeSuspicious: config.maxProfitPercentBeforeSuspicious,
    });

    if (initialSession) {
      this.lifetimeTotalProfit = initialSession.totalProfit;
      this.lifetimeTradesExecuted = initialSession.totalTradesExecuted;
      this.lifetimeProfitableTrades = initialSession.profitableTrades ?? 0;
      this.firstRunAt = initialSession.firstRunAt;
      this.riskManager.restoreState({
        dailyPnL: initialSession.dailyPnL,
        dailyResetTime: initialSession.dailyResetTime,
      });
    }
  }

  /**
   * Start the bot. Initializes all components and begins the main loop.
   */
  async start(): Promise<void> {
    logger.info("=== Polymarket Bot Starting ===");
    logger.info(`Mode: ${this.config.dryRun ? "DRY RUN (demo)" : "LIVE TRADING"}`);
    logger.info(`Strategy: ${this.config.directionalOnly ? "directional only" : this.config.pureArbOnly ? "pure arbitrage only" : "arb + directional"}`);
    logger.info(`Min profit threshold: ${this.config.minProfitThresholdCents}c`);
    logger.info(`Max position size: $${this.config.maxPositionSizeUsdc}`);
    logger.info(`Max open positions: ${this.config.maxOpenPositions ?? 999}`);
    logger.info(`Poll interval: ${this.config.pollIntervalMs}ms`);

    this.isRunning = true;
    this.stats.startTime = Date.now();
    if (this.firstRunAt === undefined) {
      this.firstRunAt = Date.now();
    }

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
    this.broadcastDashboardState(this.exchangeFeed.getLatestPrice());

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
   * Only tracks markets whose window has not ended (avoids 404s from CLOB for resolved markets).
   * Captures BTC price at window boundaries for accurate settlement.
   */
  private async discoverMarkets(): Promise<void> {
    const markets = await this.polymarketFeed.findActiveCryptoMarkets("BTC");
    const nowSec = Math.floor(Date.now() / 1000);
    this.activeMarkets = markets.filter(
      (m) => m.active && m.endTime > nowSec
    );

    if (this.activeMarkets.length === 0) {
      logger.warn("No active BTC 5-min markets found on Polymarket");
    } else {
      logger.info(
        `Tracking ${this.activeMarkets.length} active market(s): ${this.activeMarkets.map((m) => m.slug).join(", ")}`
      );
    }

    // Capture BTC price at each market's start time (if we're within a few seconds of the start)
    const exchangePrice = this.exchangeFeed.getLatestPrice();
    if (exchangePrice) {
      for (const market of this.activeMarkets) {
        // If we're within 60 seconds after the market start and don't have the price, capture it
        if (!this.windowStartPrices.has(market.startTime) && nowSec >= market.startTime && nowSec < market.startTime + 60) {
          this.windowStartPrices.set(market.startTime, exchangePrice.price);
          logger.info(`Captured window start price: $${exchangePrice.price.toFixed(2)} for window ${market.slug} (${nowSec - market.startTime}s after start)`);
        }
      }

      // Set the global reference for the current window ONLY IF we captured it at window start
      // This prevents the reference from "chasing" the current price
      const { startTime } = getCurrentFiveMinWindow();
      const capturedStartPrice = this.windowStartPrices.get(startTime);
      if (capturedStartPrice !== undefined) {
        this.detector.setWindowReference(capturedStartPrice, startTime);
      } else if (!this.windowStartPrices.has(startTime)) {
        // If we haven't captured this window's start yet, capture it now
        this.windowStartPrices.set(startTime, exchangePrice.price);
        this.detector.setWindowReference(exchangePrice.price, startTime);
        logger.info(`Captured current window start: $${exchangePrice.price.toFixed(2)} at ${new Date(startTime * 1000).toISOString()}`);
      }
    }

    // Clean up old window start prices (older than 10 minutes)
    const cutoff = nowSec - 600;
    for (const [startTime] of this.windowStartPrices) {
      if (startTime < cutoff) {
        this.windowStartPrices.delete(startTime);
      }
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

    // Capture window start prices for any markets that just started (within first 60 seconds)
    const nowSec = Math.floor(Date.now() / 1000);
    for (const market of this.activeMarkets) {
      if (!this.windowStartPrices.has(market.startTime) && nowSec >= market.startTime && nowSec < market.startTime + 60) {
        this.windowStartPrices.set(market.startTime, exchangePrice.price);
        logger.info(`Captured window start: $${exchangePrice.price.toFixed(2)} for ${market.slug} (${nowSec - market.startTime}s after start)`);
      }
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

    // Check each active market for opportunities (and cache prices for unrealized PnL)
    for (const market of this.activeMarkets) {
      // For simulation mode, pass BTC prices to generate realistic lagging prices
      const actualWindowStartPrice = this.windowStartPrices.get(market.startTime);
      const prices = await this.polymarketFeed.getMarketPrices(
        market,
        exchangePrice.price,
        actualWindowStartPrice
      );
      if (!prices) continue;
      this.lastMarketPricesBySlug.set(market.slug, {
        yesBestAsk: prices.yesBestAsk,
        noBestAsk: prices.noBestAsk,
      });

      if (this.config.directionalOnly) {
        // --- Directional only: exchange price diverges from Polymarket ---
        // Skip markets where we don't have the actual window start price
        if (!actualWindowStartPrice) {
          logger.debug(`Skipping ${market.slug}: no window start price captured`);
          continue;
        }

        const minEdge = this.config.minEdgePercent ?? 10;
        const signalThreshold = this.config.exchangeSignalThresholdPercent ?? 0.03;
        const minMove = this.config.minExchangeMovePercent ?? 0.15;
        const directionalOpp = this.detector.detectDirectionalOpportunity(
          prices,
          exchangePrice,
          minEdge,
          signalThreshold,
          minMove
        );
        if (directionalOpp) {
          // Override with the actual window start price for correct settlement
          directionalOpp.windowStartBtcPrice = actualWindowStartPrice;
          await this.handleOpportunity(directionalOpp);
        }
      } else {
        // --- Pure arbitrage: YES_ask + NO_ask < $1.00 ---
        const arbOpportunity = this.detector.detectArbitrage(
          prices,
          exchangePrice
        );
        if (arbOpportunity) {
          await this.handleOpportunity(arbOpportunity);
          continue;
        }
        // --- Directional (unless pure-arb-only) ---
        if (!this.config.pureArbOnly) {
          const minEdge = this.config.minEdgePercent ?? 10;
          const signalThreshold = this.config.exchangeSignalThresholdPercent ?? 0.03;
          const minMove = this.config.minExchangeMovePercent ?? 0.15;
          const directionalOpp = this.detector.detectDirectionalOpportunity(
            prices,
            exchangePrice,
            minEdge,
            signalThreshold,
            minMove
          );
          if (directionalOpp) {
            await this.handleOpportunity(directionalOpp);
          }
        }
      }
    }

    this.releasePositionsForEndedMarkets(exchangePrice?.price ?? null);
    this.broadcastDashboardState(exchangePrice);
  }

  /**
   * Release open positions when their 5-min market window has ended.
   * For directional trades, resolve PnL using BTC at window end vs window start.
   */
  private releasePositionsForEndedMarkets(btcPriceAtEnd: number | null): void {
    const nowSec = Math.floor(Date.now() / 1000);
    for (const execution of this.executions) {
      if (!execution.fullyExecuted) continue;
      const { market, detectedAt, exchangeSignal, windowStartBtcPrice } = execution.opportunity;
      if (market.endTime >= nowSec) continue;
      const key = `${market.slug}-${detectedAt}`;
      if (this.releasedPositionKeys.has(key)) continue;

      const isDirectional = execution.opportunity.totalCost >= 1.0;
      let didResolve = false;
      if (isDirectional && btcPriceAtEnd != null && typeof windowStartBtcPrice === "number") {
        const weBetUp = exchangeSignal === "UP";
        const yesWon = btcPriceAtEnd > windowStartBtcPrice;
        const ourSideWon = (weBetUp && yesWon) || (!weBetUp && btcPriceAtEnd < windowStartBtcPrice);
        const filledSize = weBetUp
          ? (execution.yesTrade.filledSize ?? 0)
          : (execution.noTrade.filledSize ?? 0);
        let actualProfit = ourSideWon ? filledSize * 1.0 - execution.actualTotalCost : -execution.actualTotalCost;
        const stopLossPercent = 0.02;
        const maxLoss = stopLossPercent * execution.actualTotalCost;
        if (actualProfit < 0 && actualProfit < -maxLoss) {
          actualProfit = -maxLoss;
          logger.info(`Stop loss applied: loss capped at ${stopLossPercent * 100}% of position`);
        }
        execution.actualProfit = actualProfit;
        this.lifetimeTotalProfit += actualProfit;
        if (actualProfit > 0) this.lifetimeProfitableTrades++;
        this.riskManager.recordSettlement(actualProfit);
        didResolve = true;
        logger.info(
          `Settlement: ${market.slug} | Bet ${exchangeSignal} | BTC start=$${windowStartBtcPrice.toFixed(2)} end=$${btcPriceAtEnd.toFixed(2)} | ` +
            `${ourSideWon ? "WON" : "LOST"} | PnL=$${actualProfit.toFixed(4)}`
        );
      } else if (isDirectional && btcPriceAtEnd == null) {
        logger.debug(`Settlement deferred for ${market.slug}: no BTC price yet`);
        continue;
      } else if (isDirectional && typeof windowStartBtcPrice !== "number") {
        logger.warn(`Settlement skipped for ${market.slug}: missing window start price, resolving as $0`);
        execution.actualProfit = 0;
        didResolve = true;
      }

      if (!isDirectional || didResolve) {
        this.riskManager.releasePosition();
        this.releasedPositionKeys.add(key);
      }
    }
  }

  private broadcastDashboardState(exchangePrice: { price: number; timestamp: number } | null): void {
    if (!this.dashboard) return;
    const { startTime, endTime } = getCurrentFiveMinWindow();
    const risk = this.riskManager.getState();
    const recentExecutions = this.executions.slice(-MAX_EXECUTIONS_FOR_DASHBOARD);
    const cexPrices: Record<string, number> = {};
    this.exchangeFeed.getPricesByExchange().forEach((price, name) => {
      cexPrices[name] = price;
    });
    this.dashboard.broadcastState({
      btcPrice: exchangePrice?.price ?? null,
      btcTimestamp: exchangePrice?.timestamp ?? 0,
      cexPrices,
      activeMarketsCount: this.activeMarkets.length,
      activeMarketSlugs: this.activeMarkets.map((m) => m.slug),
      windowStartTime: startTime,
      windowEndTime: endTime,
      windowRemainingSec: secondsRemainingInWindow(),
      risk: {
        dailyPnL: risk.dailyPnL,
        openPositions: risk.openPositions,
        tradesLastMinute: risk.tradesLastMinute,
      },
      stats: {
        cyclesRun: this.stats.cyclesRun,
        opportunitiesFound: this.stats.opportunitiesFound,
        tradesExecuted: this.lifetimeTradesExecuted,
        totalProfit: this.lifetimeTotalProfit,
        startTime: this.stats.startTime,
      },
      demoBalance: this.config.dryRun
        ? {
            startingUsd: this.config.demoStartingBalance ?? 1000,
            currentUsd: (this.config.demoStartingBalance ?? 1000) + this.lifetimeTotalProfit,
          }
        : undefined,
      mode: this.config.dryRun ? "dry_run" : "live",
      executions: recentExecutions.map((e) => {
        const opp = e.opportunity;
        const side = opp.exchangeSignal === "DOWN" ? "DOWN" : "UP";
        const entryPrice = side === "UP" ? opp.yesPrice : opp.noPrice;
        const entryStr = `${Math.round(entryPrice * 100)}¢`;
        const isDirectional = opp.totalCost >= 1.0;
        const settled = isDirectional ? e.actualProfit !== 0 : e.fullyExecuted;
        const filledSize = side === "UP" ? (e.yesTrade.filledSize ?? 0) : (e.noTrade.filledSize ?? 0);
        const prices = this.lastMarketPricesBySlug.get(opp.market.slug);
        let unrealizedProfit: number | null = null;
        if (!settled && prices && filledSize > 0) {
          const currentPrice = side === "UP" ? prices.yesBestAsk : prices.noBestAsk;
          unrealizedProfit = (currentPrice - entryPrice) * filledSize;
        }
        return {
          marketSlug: opp.market.slug,
          actualProfit: e.actualProfit,
          fullyExecuted: e.fullyExecuted,
          settled,
          timestamp: opp.detectedAt,
          side,
          entry: entryStr,
          size: opp.suggestedSize,
          marketWindowStart: opp.market.startTime,
          marketWindowEnd: opp.market.endTime,
          unrealizedProfit,
        };
      }),
    });
  }

  /**
   * Handle a detected opportunity: risk check, then execute.
   */
  private async handleOpportunity(
    opportunity: ArbitrageOpportunity
  ): Promise<void> {
    const isDirectional = opportunity.totalCost >= 1.0;
    const minSecLeft = this.config.minSecondsRemainingInWindow ?? 120;
    if (isDirectional && secondsRemainingInWindow() < minSecLeft) {
      logger.debug(
        `Skip directional: only ${secondsRemainingInWindow()}s left in window (min ${minSecLeft}s)`
      );
      return;
    }

    let toExecute = opportunity;
    if (this.config.dryRun && (this.config.demoStartingBalance ?? 1000) > 0) {
      const starting = this.config.demoStartingBalance ?? 1000;
      const currentBalance = Math.max(0, starting + this.lifetimeTotalProfit);
      const maxPerTradeUsd = 0.05 * currentBalance;
      const tradeSizeUsd = opportunity.totalCost * opportunity.suggestedSize;
      if (tradeSizeUsd > maxPerTradeUsd) {
        const cappedSize = Math.max(1, Math.floor(maxPerTradeUsd / opportunity.totalCost));
        if (cappedSize < 1) {
          logger.debug(`Skip trade: 5% of balance would be < 1 share (balance=$${currentBalance.toFixed(2)})`);
          return;
        }
        toExecute = {
          ...opportunity,
          suggestedSize: cappedSize,
          totalExpectedProfit: opportunity.profitPerShare * cappedSize,
        };
        logger.info(
          `Capped size to 5% of balance: $${(opportunity.totalCost * cappedSize).toFixed(2)} (balance=$${currentBalance.toFixed(2)})`
        );
      }
    }

    this.stats.opportunitiesFound++;

    // Risk check
    const riskCheck = this.riskManager.checkTrade(toExecute);
    if (!riskCheck.allowed) {
      logger.warn(`Trade blocked by risk: ${riskCheck.reason}`);
      return;
    }

    logger.info(
      `Executing ${isDirectional ? "directional" : "arbitrage"} on ${toExecute.market.slug}: ` +
        `Expected profit: $${toExecute.totalExpectedProfit.toFixed(4)}`
    );

    const execution = isDirectional
      ? await this.trader.executeDirectional(toExecute)
      : await this.trader.executeArbitrage(toExecute);
    this.executions.push(execution);
    this.riskManager.recordExecution(execution);

    if (execution.fullyExecuted) {
      const isGuaranteedProfit = opportunity.totalCost < 1.0;
      this.lifetimeTradesExecuted++;
      if (isGuaranteedProfit) {
        this.stats.tradesExecuted++;
        this.stats.totalProfit += execution.actualProfit;
        this.lifetimeTotalProfit += execution.actualProfit;
        if (execution.actualProfit > 0) {
          this.lifetimeProfitableTrades++;
        }
      } else {
        this.stats.directionalTradesExecuted++;
        logger.info(
          `Directional trade executed on ${opportunity.market.slug}; PnL will be realized at settlement`
        );
      }
    }
  }

  /**
   * Build current session snapshot for persistence (merge lifetime + risk state).
   */
  getSessionSnapshot(): PersistedSession {
    const risk = this.riskManager.getState();
    return {
      totalProfit: this.lifetimeTotalProfit,
      totalTradesExecuted: this.lifetimeTradesExecuted,
      profitableTrades: this.lifetimeProfitableTrades,
      firstRunAt: this.firstRunAt,
      dailyPnL: risk.dailyPnL,
      dailyResetTime: risk.dailyResetTime,
    };
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
    logger.info(`Trades executed: ${this.stats.tradesExecuted} (guaranteed) | Directional: ${this.stats.directionalTradesExecuted}`);
    logger.info(`Total profit: $${this.stats.totalProfit.toFixed(4)}`);
    logger.info(
      `Profit/hour: $${((this.stats.totalProfit / runtime) * 3600).toFixed(4)}`
    );
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
