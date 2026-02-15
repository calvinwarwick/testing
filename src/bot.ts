import { ExchangeFeed } from "./feeds/exchange-feed";
import { PolymarketFeed } from "./feeds/polymarket-feed";
import { ArbitrageDetector } from "./arbitrage/detector";
import { Trader } from "./execution/trader";
import { RiskManager } from "./utils/risk";
import {
  logger,
  loadTradeRecords,
  getTradeRecords,
  getTradeRecordById,
  getUnsettledTradeRecords,
  updateTradeSettlement,
  loadHistoricalMarkets,
  recordHistoricalMarket,
  loadPersistentLogs,
  getPersistentLogs,
  getHistoricalMarkets,
} from "./utils/logger";
import {
  getCurrentFiveMinWindow,
  secondsRemainingInWindow,
} from "./utils/time";
import {
  calculateReservedCapital,
  decideDemoCapitalSizing,
} from "./utils/demo-capital";
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
const MAX_EXCHANGE_PRICE_AGE_MS = 10000;
const EXECUTION_END_BUFFER_SEC = 3;

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
  /** BTC price at first cycle after window end, per execution key (so settlement uses correct resolution price) */
  private settlementEndPriceByKey = new Map<string, number>();
  /** Latest prices per market slug for unrealized PnL and stop-loss (updated each cycle) */
  private lastMarketPricesBySlug = new Map<
    string,
    {
      yesBestAsk: number;
      noBestAsk: number;
      yesBestBid: number;
      noBestBid: number;
      yesMid: number;
      noMid: number;
      yesBestAskSize?: number;
      noBestAskSize?: number;
    }
  >();
  /** Track BTC price at the actual start of each market window (keyed by market.startTime) */
  private windowStartPrices = new Map<number, number>();
  private recentResolvedMarkets: NonNullable<DashboardState["historicalMarkets"]> =
    [];
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
      config.btc5mEventSlug,
      config.forceRealData ?? false
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
    logger.info("Strategy: directional edge");
    if (this.config.pureArbOnly) {
      logger.warn("PURE_ARB_ONLY=true is ignored in directional-edge runtime");
    }
    logger.info(`Min profit threshold: ${this.config.minProfitThresholdCents}c`);
    logger.info(`Max position size: $${this.config.maxPositionSizeUsdc}`);
    logger.info(`Max open positions: ${this.config.maxOpenPositions ?? 999}`);
    logger.info(`Poll interval: ${this.config.pollIntervalMs}ms`);
    logger.info(
      `Data mode config: FORCE_REAL_DATA=${this.config.forceRealData ? "true" : "false"} | SIMULATE_MARKETS=${process.env.SIMULATE_MARKETS ?? "unset"}`
    );

    this.isRunning = true;
    this.stats.startTime = Date.now();
    if (this.firstRunAt === undefined) {
      this.firstRunAt = Date.now();
    }

    // Initialize components
    await this.exchangeFeed.start();
    await this.trader.initialize();

    // Load persistent data
    loadTradeRecords();
    loadHistoricalMarkets();
    loadPersistentLogs();
    this.syncLifetimeProfitFromTradeLog();
    this.restoreRuntimeStateFromTradeRecords();

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

  private getExecutionKey(execution: ArbitrageExecution): string {
    return `${execution.opportunity.market.slug}-${execution.opportunity.detectedAt}`;
  }

  private getExecutionTradeId(execution: ArbitrageExecution): string | undefined {
    const isUp = execution.opportunity.exchangeSignal === "UP";
    return isUp ? execution.yesTrade.orderId : execution.noTrade.orderId;
  }

  /**
   * Recompute realized lifetime profit/wins from persisted trade log.
   * This avoids drift from in-memory counters after restarts.
   */
  private syncLifetimeProfitFromTradeLog(): void {
    const settled = getTradeRecords().filter(
      (t) => t.settled && typeof t.profit === "number"
    );
    this.lifetimeTotalProfit = settled.reduce((sum, t) => sum + (t.profit ?? 0), 0);
    this.lifetimeProfitableTrades = settled.filter((t) => (t.profit ?? 0) > 0).length;
  }

  private getInMemoryTradeIds(): Set<string> {
    const ids = new Set<string>();
    for (const execution of this.executions) {
      const id = this.getExecutionTradeId(execution);
      if (id) ids.add(id);
    }
    return ids;
  }

  /**
   * Rebuild in-memory execution/risk tracking from persisted directional trades.
   * This keeps restart behavior deterministic for open-position limits/capital checks.
   */
  private restoreRuntimeStateFromTradeRecords(): void {
    const nowSec = Math.floor(Date.now() / 1000);
    const trades = getTradeRecords();

    const restored: ArbitrageExecution[] = [];
    for (const t of trades) {
      const key = `${t.marketSlug}-${t.timestamp}`;
      if (t.settled) {
        this.releasedPositionKeys.add(key);
        continue;
      }
      if (t.type !== "directional") continue;
      if (t.marketWindowEnd <= nowSec) continue;

      const sideIsUp = t.side === "UP";
      const tradeResult = {
        success: true as const,
        orderId: t.id,
        side: sideIsUp ? ("YES" as const) : ("NO" as const),
        price: t.entryPrice,
        size: t.size,
        filledSize: t.size,
        timestamp: t.timestamp,
      };
      const oppositeResult = {
        success: false as const,
        side: sideIsUp ? ("NO" as const) : ("YES" as const),
        price: 0,
        size: 0,
        timestamp: t.timestamp,
      };
      restored.push({
        opportunity: {
          market: {
            conditionId: "",
            slug: t.marketSlug,
            question: "",
            yesTokenId: "",
            noTokenId: "",
            startTime: t.marketWindowStart,
            endTime: t.marketWindowEnd,
            active: true,
          },
          totalCost: t.cost,
          profitPerShare: 0,
          profitPercent: 0,
          yesPrice: sideIsUp ? t.entryPrice : 0,
          noPrice: sideIsUp ? 0 : t.entryPrice,
          suggestedSize: t.size,
          totalExpectedProfit: 0,
          exchangePrice: {
            exchange: "restored",
            symbol: "BTCUSDT",
            price: t.btcPriceAtEntry,
            timestamp: t.timestamp,
          },
          exchangeSignal: t.side,
          windowStartBtcPrice: t.btcPriceAtEntry,
          detectedAt: t.timestamp,
        },
        yesTrade: sideIsUp ? tradeResult : oppositeResult,
        noTrade: sideIsUp ? oppositeResult : tradeResult,
        actualTotalCost: t.cost,
        actualProfit: t.profit ?? 0,
        fullyExecuted: true,
        settled: false,
      });
    }

    this.executions = restored;
    const unsettledDirectionalCount = getUnsettledTradeRecords(nowSec).filter(
      (t) => t.type === "directional"
    ).length;
    this.riskManager.restoreOpenPositions(unsettledDirectionalCount);
    if (restored.length > 0 || unsettledDirectionalCount > 0) {
      logger.info(
        `Restored runtime state: ${restored.length} directional execution(s), open positions=${unsettledDirectionalCount}`
      );
    }
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
    const { startTime: currentWindowStart } = getCurrentFiveMinWindow();
    const candidates = markets.filter((m) => m.active && m.endTime > nowSec);
    const currentMarket =
      candidates.find((m) => m.startTime <= nowSec && nowSec < m.endTime) ??
      candidates.find((m) => m.startTime === currentWindowStart) ??
      null;
    this.activeMarkets = currentMarket ? [currentMarket] : [];

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
      } else {
        logger.debug(
          `Window reference unavailable for ${new Date(
            startTime * 1000
          ).toISOString()} (not captured near boundary yet)`
        );
      }
    }

    // Clean up old window start prices (older than 10 minutes)
    const cutoff = nowSec - 600;
    for (const [startTime] of this.windowStartPrices) {
      if (startTime < cutoff) {
        this.windowStartPrices.delete(startTime);
      }
    }

    // Refresh historical panel source from recently resolved Polymarket markets.
    try {
      const recentResolved = await this.polymarketFeed.getRecentResolvedBtcMarkets(10);
      if (recentResolved.length > 0) {
        this.recentResolvedMarkets = recentResolved;
      }
    } catch (error) {
      logger.debug("Failed to refresh recently resolved markets", {
        error: String(error),
      });
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
    const priceAgeMs = Date.now() - exchangePrice.timestamp;
    if (priceAgeMs > MAX_EXCHANGE_PRICE_AGE_MS) {
      logger.warn(
        `Exchange price is stale (${priceAgeMs}ms old), skipping cycle`
      );
      return;
    }
    if (!this.config.dryRun && this.polymarketFeed.isSimulating()) {
      logger.warn("LIVE MODE: simulation data active, refusing to place trades");
      this.broadcastDashboardState(exchangePrice);
      return;
    }
    this.syncLifetimeProfitFromTradeLog();

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
      if (market.endTime <= nowSec) {
        // Markets can remain in activeMarkets briefly between discovery refreshes.
        // Never fetch/trade on an already ended 5-min window.
        continue;
      }
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
        yesBestBid: prices.yesBestBid,
        noBestBid: prices.noBestBid,
        yesMid: prices.yesMid,
        noMid: prices.noMid,
        yesBestAskSize: prices.yesBestAskSize,
        noBestAskSize: prices.noBestAskSize,
      });
      await this.tryStopLossExits(market.slug, exchangePrice.price);

      // --- Directional edge only ---
      // Skip markets where we don't have the actual window start price.
      if (actualWindowStartPrice == null) {
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
        // Override with the actual window start price for correct settlement.
        directionalOpp.windowStartBtcPrice = actualWindowStartPrice;
        await this.handleOpportunity(directionalOpp);
      }
    }

    this.releasePositionsForEndedMarkets(exchangePrice?.price ?? null);
    this.broadcastDashboardState(exchangePrice);
  }

  /**
   * For a given market, check open directional positions and exit at 5% stop-loss if unrealized
   * loss (selling at current bid) would be >= 5% of cost. Marks trade as Stopped and records the loss.
   */
  private async tryStopLossExits(
    marketSlug: string,
    btcPriceAtExit: number
  ): Promise<void> {
    const nowSec = Math.floor(Date.now() / 1000);
    const prices = this.lastMarketPricesBySlug.get(marketSlug);
    if (!prices) return;

    const stopLossPercent = 0.05;
    for (const execution of this.executions) {
      if (!execution.fullyExecuted) continue;
      const { market, detectedAt, exchangeSignal } = execution.opportunity;
      if (market.slug !== marketSlug || market.endTime <= nowSec) continue;
      const key = `${market.slug}-${detectedAt}`;
      if (this.releasedPositionKeys.has(key) || execution.settled) continue;
      if (execution.opportunity.totalCost < 1.0) continue; // only directional
      const existingTradeId = this.getExecutionTradeId(execution);
      if (existingTradeId && getTradeRecordById(existingTradeId)?.settled) {
        execution.settled = true;
        this.releasedPositionKeys.add(key);
        this.settlementEndPriceByKey.delete(key);
        continue;
      }

      const weBetUp = exchangeSignal === "UP";
      const filledSize = weBetUp
        ? (execution.yesTrade.filledSize ?? 0)
        : (execution.noTrade.filledSize ?? 0);
      if (filledSize <= 0) continue;

      const sellPrice = weBetUp ? prices.yesBestBid : prices.noBestBid;
      const unrealizedProfit = sellPrice * filledSize - execution.actualTotalCost;
      const maxLoss = stopLossPercent * execution.actualTotalCost;
      if (unrealizedProfit > -maxLoss) continue; // not at stop-loss

      const tokenId = weBetUp
        ? execution.opportunity.market.yesTokenId
        : execution.opportunity.market.noTokenId;
      if (!tokenId) continue;
      const side = weBetUp ? "YES" : "NO";
      logger.info(
        `Stop-loss exit: ${market.slug} | ${side} ${filledSize} @ bid $${sellPrice.toFixed(3)} | unrealized PnL=$${unrealizedProfit.toFixed(4)}`
      );
      const sellResult = await this.trader.placeLimitSell(tokenId, sellPrice, filledSize, side);
      const filled = sellResult.filledSize ?? filledSize;
      const actualProfit = sellResult.success
        ? sellPrice * filled - execution.actualTotalCost
        : -maxLoss; // sell failed: record capped loss and show as Stopped
      execution.actualProfit = actualProfit;
      execution.lossCapped = true; // show as Stopped in UI (exited at stop-loss)
      execution.settled = true;
      this.lifetimeTotalProfit += execution.actualProfit;
      if (execution.actualProfit > 0) this.lifetimeProfitableTrades++;
      this.riskManager.recordSettlement(execution.actualProfit);
      this.releasedPositionKeys.add(key);
      this.settlementEndPriceByKey.delete(key);
      const tradeId = weBetUp
        ? execution.yesTrade.orderId
        : execution.noTrade.orderId;
      if (tradeId) {
        updateTradeSettlement(tradeId, execution.actualProfit, btcPriceAtExit);
      }
      if (sellResult.success) {
        logger.info(`Stopped at 5%: PnL=$${execution.actualProfit.toFixed(4)}`);
      } else {
        logger.warn(`Stop-loss sell failed; recording capped loss $${execution.actualProfit.toFixed(4)}`);
      }
      break; // one exit per market per cycle
    }
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
      if (market.endTime > nowSec) continue;
      const key = `${market.slug}-${detectedAt}`;
      if (this.releasedPositionKeys.has(key) || execution.settled) continue;
      const tradeId = this.getExecutionTradeId(execution);
      if (tradeId && getTradeRecordById(tradeId)?.settled) {
        execution.settled = true;
        this.releasedPositionKeys.add(key);
        this.settlementEndPriceByKey.delete(key);
        continue;
      }

      // Lock in the BTC price the first time we see the window has ended (with a price).
      // Using a later cycle's price would wrongly flip UP/DOWN if BTC moved after the window closed.
      if (btcPriceAtEnd != null && !this.settlementEndPriceByKey.has(key)) {
        this.settlementEndPriceByKey.set(key, btcPriceAtEnd);
      }
      const priceAtEnd = this.settlementEndPriceByKey.get(key) ?? btcPriceAtEnd ?? null;

      const isDirectional = execution.opportunity.totalCost >= 1.0;
      let didResolve = false;
      if (isDirectional && priceAtEnd != null && typeof windowStartBtcPrice === "number") {
        const weBetUp = exchangeSignal === "UP";
        const yesWon = priceAtEnd > windowStartBtcPrice;
        const ourSideWon = (weBetUp && yesWon) || (!weBetUp && priceAtEnd < windowStartBtcPrice);
        const filledSize = weBetUp
          ? (execution.yesTrade.filledSize ?? 0)
          : (execution.noTrade.filledSize ?? 0);
        const actualProfit = ourSideWon
          ? filledSize * 1.0 - execution.actualTotalCost
          : -execution.actualTotalCost;
        execution.actualProfit = actualProfit;
        execution.settled = true;
        this.lifetimeTotalProfit += actualProfit;
        if (actualProfit > 0) this.lifetimeProfitableTrades++;
        this.riskManager.recordSettlement(actualProfit);
        didResolve = true;

        // Update trade record with settlement info
        if (tradeId) {
          updateTradeSettlement(tradeId, actualProfit, priceAtEnd);
        }

        // Record historical market
        recordHistoricalMarket({
          windowStart: market.startTime,
          windowEnd: market.endTime,
          btcPriceAtStart: windowStartBtcPrice,
          btcPriceAtEnd: priceAtEnd,
          outcome: yesWon ? "UP" : "DOWN",
          recordedAt: Date.now(),
        });

        logger.info(
          `Settlement: ${market.slug} | Bet ${exchangeSignal} | BTC start=$${windowStartBtcPrice.toFixed(2)} end=$${priceAtEnd.toFixed(2)} | ` +
            `${ourSideWon ? "WON" : "LOST"} | PnL=$${actualProfit.toFixed(4)}`
        );
      } else if (isDirectional && priceAtEnd == null) {
        logger.debug(`Settlement deferred for ${market.slug}: no BTC price yet`);
        continue;
      } else if (isDirectional && typeof windowStartBtcPrice !== "number") {
        logger.warn(`Settlement skipped for ${market.slug}: missing window start price, resolving as $0`);
        execution.actualProfit = 0;
        execution.settled = true;
        this.riskManager.recordSettlement(0);
        if (tradeId) {
          updateTradeSettlement(
            tradeId,
            0,
            priceAtEnd ?? execution.opportunity.exchangePrice.price
          );
        }
        didResolve = true;
      }

      if (!isDirectional || didResolve) {
        if (!isDirectional) {
          this.riskManager.releasePosition();
        }
        this.releasedPositionKeys.add(key);
        this.settlementEndPriceByKey.delete(key);
      }
    }
  }

  private broadcastDashboardState(exchangePrice: { price: number; timestamp: number } | null): void {
    if (!this.dashboard) return;
    this.syncLifetimeProfitFromTradeLog();
    const { startTime, endTime } = getCurrentFiveMinWindow();
    const risk = this.riskManager.getState();
    const recentExecutions = this.executions.slice(-MAX_EXECUTIONS_FOR_DASHBOARD);
    const cexPrices: Record<string, number> = {};
    this.exchangeFeed.getPricesByExchange().forEach((price, name) => {
      cexPrices[name] = price;
    });
    const nowSec = Math.floor(Date.now() / 1000);
    // Prefer the market actively covering "now", then by matching endTime, then any market with cached prices.
    const currentWindowMarket =
      this.activeMarkets.find((m) => m.startTime <= nowSec && nowSec < m.endTime) ??
      this.activeMarkets.find((m) => m.endTime === endTime) ??
      this.activeMarkets.find((m) => this.lastMarketPricesBySlug.has(m.slug));
    const marketPrices = currentWindowMarket
      ? this.lastMarketPricesBySlug.get(currentWindowMarket.slug)
      : undefined;
    const currentMarketPrices =
      marketPrices != null
        ? { up: marketPrices.yesBestAsk, down: marketPrices.noBestAsk }
        : undefined;
    const marketVolume =
      currentWindowMarket?.volumeUsd ??
      currentWindowMarket?.liquidityUsd ??
      (marketPrices != null &&
      marketPrices.yesBestAskSize != null &&
      marketPrices.noBestAskSize != null
        ? marketPrices.yesBestAsk * marketPrices.yesBestAskSize +
          marketPrices.noBestAsk * marketPrices.noBestAskSize
        : undefined);

    const liveExecutions: DashboardState["executions"] = recentExecutions.map((e) => {
      const opp = e.opportunity;
      const side: "UP" | "DOWN" =
        opp.exchangeSignal === "DOWN" ? "DOWN" : "UP";
      const entryPrice = side === "UP" ? opp.yesPrice : opp.noPrice;
      const entryStr = `${Math.round(entryPrice * 100)}¢`;
      const isDirectional = opp.totalCost >= 1.0;
      const releasedKey = `${opp.market.slug}-${opp.detectedAt}`;
      const settled = isDirectional
        ? this.releasedPositionKeys.has(releasedKey) || e.settled === true
        : e.fullyExecuted;
      const filledSize = side === "UP" ? (e.yesTrade.filledSize ?? 0) : (e.noTrade.filledSize ?? 0);
      const prices = this.lastMarketPricesBySlug.get(opp.market.slug);
      let unrealizedProfit: number | null = null;
      if (!settled && prices && filledSize > 0) {
        const currentPrice = side === "UP" ? prices.yesBestBid : prices.noBestBid;
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
        lossCapped: e.lossCapped,
      };
    });
    const persistedExecutions: DashboardState["executions"] = getTradeRecords()
      .slice(-MAX_EXECUTIONS_FOR_DASHBOARD)
      .map((t) => ({
        marketSlug: t.marketSlug,
        actualProfit: t.profit ?? 0,
        fullyExecuted: true,
        settled: t.settled,
        timestamp: t.settledAt ?? t.timestamp,
        side: t.side,
        entry: `${Math.round(t.entryPrice * 100)}¢`,
        size: t.size,
        marketWindowStart: t.marketWindowStart,
        marketWindowEnd: t.marketWindowEnd,
        unrealizedProfit: null,
        lossCapped: false,
      }));
    const seen = new Set<string>();
    const mergedExecutions: DashboardState["executions"] = [
      ...liveExecutions,
      ...persistedExecutions,
    ]
      .filter((e) => {
        const key = `${e.marketSlug}-${e.marketWindowEnd}-${e.timestamp}-${e.side}-${e.entry}-${e.size}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      })
      .sort((a, b) => a.timestamp - b.timestamp)
      .slice(-MAX_EXECUTIONS_FOR_DASHBOARD);
    const recentLogs = getPersistentLogs(1000).map((l) => ({
      level: l.level,
      message: l.message,
      timestamp: l.timestamp,
      meta: l.meta ? JSON.stringify(l.meta) : undefined,
    }));

    this.dashboard.broadcastState({
      btcPrice: exchangePrice?.price ?? null,
      btcTimestamp: exchangePrice?.timestamp ?? 0,
      cexPrices,
      currentMarketPrices,
      marketVolume,
      dataMode: this.polymarketFeed.getDataMode(),
      modeReason: this.polymarketFeed.getModeReason(),
      forceRealData: this.config.forceRealData ?? false,
      activeMarketsCount: this.activeMarkets.length,
      activeMarketSlugs: this.activeMarkets.map((m) => m.slug),
      windowStartTime: startTime,
      windowEndTime: endTime,
      windowRemainingSec: secondsRemainingInWindow(),
      windowStartBtcPrice: this.windowStartPrices.get(startTime) ?? undefined,
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
        profitableTrades: this.lifetimeProfitableTrades,
      },
      demoBalance: this.config.dryRun
        ? {
            startingUsd: this.config.demoStartingBalance ?? 1000,
            currentUsd: (this.config.demoStartingBalance ?? 1000) + this.lifetimeTotalProfit,
          }
        : undefined,
      mode: this.config.dryRun ? "dry_run" : "live",
      executions: mergedExecutions,
      recentLogs,
      historicalMarkets:
        this.recentResolvedMarkets.length > 0
          ? this.recentResolvedMarkets
          : getHistoricalMarkets(100),
    });
  }

  /**
   * Handle a detected opportunity: risk check, then execute.
   */
  private async handleOpportunity(
    opportunity: ArbitrageOpportunity
  ): Promise<void> {
    this.syncLifetimeProfitFromTradeLog();
    const nowSec = Math.floor(Date.now() / 1000);
    if (opportunity.market.endTime <= nowSec) {
      logger.debug(
        `Skip trade: market already ended (${opportunity.market.slug})`
      );
      return;
    }
    const minSecLeft = this.config.minSecondsRemainingInWindow ?? 120;
    const marketSecondsRemaining = opportunity.market.endTime - nowSec;
    if (marketSecondsRemaining < minSecLeft) {
      logger.info(
        `Skip directional: only ${marketSecondsRemaining}s left in market window (min ${minSecLeft}s)`
      );
      return;
    }

    let toExecute = opportunity;
    if (this.config.dryRun && (this.config.demoStartingBalance ?? 1000) > 0) {
      const persistedTrades = getTradeRecords();
      const decision = decideDemoCapitalSizing({
        startingBalanceUsd: this.config.demoStartingBalance ?? 1000,
        lifetimeProfitUsd: this.lifetimeTotalProfit,
        reservedCapitalUsd: calculateReservedCapital(
          this.executions,
          this.releasedPositionKeys,
          persistedTrades,
          this.getInMemoryTradeIds()
        ),
        totalCostPerShareUsd: opportunity.totalCost,
        suggestedSize: opportunity.suggestedSize,
      });
      if (!decision.allowed) {
        logger.info(
          `Skip trade: demo capital check failed (${decision.reason}) ` +
            `balance=$${decision.currentBalanceUsd.toFixed(2)} ` +
            `reserved=$${decision.reservedCapitalUsd.toFixed(2)} ` +
            `available=$${decision.availableBalanceUsd.toFixed(2)} ` +
            `attempted=$${decision.attemptedNotionalUsd.toFixed(2)}`
        );
        return;
      }

      if (
        decision.finalSuggestedSize != null &&
        decision.finalSuggestedSize !== opportunity.suggestedSize
      ) {
        toExecute = {
          ...opportunity,
          suggestedSize: decision.finalSuggestedSize,
          totalExpectedProfit:
            opportunity.profitPerShare * decision.finalSuggestedSize,
        };
        logger.info(
          `Capped size by demo cash limits: attempted=$${decision.attemptedNotionalUsd.toFixed(2)} ` +
            `final=$${(opportunity.totalCost * decision.finalSuggestedSize).toFixed(2)} ` +
            `maxAllowed=$${decision.maxAllowedNotionalUsd.toFixed(2)} ` +
            `balance=$${decision.currentBalanceUsd.toFixed(2)} ` +
            `reserved=$${decision.reservedCapitalUsd.toFixed(2)} ` +
            `available=$${decision.availableBalanceUsd.toFixed(2)}`
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
      `Executing directional on ${toExecute.market.slug}: ` +
        `Expected profit: $${toExecute.totalExpectedProfit.toFixed(4)}`
    );

    const preExecuteNowSec = Math.floor(Date.now() / 1000);
    const remainingBeforeExecution = toExecute.market.endTime - preExecuteNowSec;
    if (remainingBeforeExecution <= EXECUTION_END_BUFFER_SEC) {
      logger.info(
        `Skip trade: ${toExecute.market.slug} too close to end (${remainingBeforeExecution}s <= ${EXECUTION_END_BUFFER_SEC}s execution buffer)`
      );
      return;
    }

    const execution = await this.trader.executeDirectional(toExecute);
    execution.settled = false;
    this.executions.push(execution);
    this.riskManager.recordExecution(execution);

    if (execution.fullyExecuted) {
      this.lifetimeTradesExecuted++;
      this.stats.directionalTradesExecuted++;
      logger.info(
        `Directional trade executed on ${opportunity.market.slug}; PnL will be realized at settlement`
      );
    }
  }

  /**
   * Build current session snapshot for persistence (merge lifetime + risk state).
   */
  getSessionSnapshot(): PersistedSession {
    this.syncLifetimeProfitFromTradeLog();
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
