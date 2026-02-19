import { ExchangeFeed } from "./feeds/exchange-feed";
import { PolymarketFeed } from "./feeds/polymarket-feed";
import {
  initChainlinkFeed,
  getBtcPriceAtTimestamp,
  isChainlinkConfigured,
} from "./feeds/chainlink-feed";
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
  updateHistoricalMarketOutcome,
  getTradeStats,
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
  ExchangePrice,
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
 * 4. DETECT: Directional edge (CEX vs Polymarket)
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
  private progressLogTimer: ReturnType<typeof setInterval> | null = null;
  private activeMarkets: PolymarketMarket[] = [];
  private executions: ArbitrageExecution[] = [];
  private releasedPositionKeys = new Set<string>();
  /** Log "Endgame arb: opening" at most once per market per window (slug-endTime) to avoid repeated logs */
  private endgameLoggedForMarket = new Set<string>();
  /** Log "Endgame skipped" at most once per market per window so user sees why we didn't open */
  private endgameSkippedLoggedForMarket = new Set<string>();
  /** BTC price at first cycle after window end, per execution key (so settlement uses correct resolution price) */
  private settlementEndPriceByKey = new Map<string, number>();
  /** Keys for which the locked settlement price came from Chainlink (not exchange fallback). Used to avoid recording non-oracle outcomes. */
  private settlementPriceFromChainlinkByKey = new Set<string>();
  /** Latest prices per market slug for unrealized PnL (updated each cycle) */
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
  /** Track BTC price at the end of each market window (keyed by windowEnd). Used as next window's start price. */
  private windowEndPrices = new Map<number, number>();
  /** Track per-exchange BTC prices at window start (keyed by market.startTime -> exchange name -> price) */
  private windowStartPricesByExchange = new Map<number, Record<string, number>>();
  /** Track the last window start time we've seen (for detecting boundary transitions) */
  private lastSeenWindowStart = 0;
  /** Executions waiting for Polymarket API confirmation before settlement (keyed by execution key) */
  private pendingSettlements = new Map<string, { marketEndTime: number; lastChecked: number }>();
  /** Throttle Polymarket price-to-beat fetches per slug (slug -> last fetch time ms) */
  private lastPriceToBeatFetchBySlug = new Map<string, number>();
  /** Change detection key for dashboard broadcast (skip when unchanged) */
  private _lastBroadcastKey = "";
  private static readonly PRICE_TO_BEAT_FETCH_INTERVAL_MS = 5_000; // Reduced from 10s to 5s for faster retries
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
  /** Dirty flag: set true when trades change; syncLifetimeProfitFromTradeLog skips if clean */
  private _profitSyncDirty = true;
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
    this.detector = new ArbitrageDetector(config.maxPositionSizeUsdc);
    this.trader = new Trader(config);
    this.riskManager = new RiskManager({
      maxPositionUsdc: config.maxPositionSizeUsdc,
      maxOpenPositions: config.maxOpenPositions,
      maxTradesPerMinute: config.maxTradesPerMinute,
      minTimeBetweenTradesMs: config.minTimeBetweenTradesMs,
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
    logger.info(
      `Bot starting: ${this.config.dryRun ? "DRY RUN" : "LIVE"} | directional | ` +
        `position $${this.config.maxPositionSizeUsdc} max ${this.config.maxOpenPositions ?? 999} open | ` +
        `poll ${this.config.pollIntervalMs}ms`
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
    this.isRunning = false;

    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
    if (this.progressLogTimer) {
      clearInterval(this.progressLogTimer);
      this.progressLogTimer = null;
    }

    this.exchangeFeed.stop();

    this.printStats();
    logger.info("Bot stopped");
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
   * Guarded by a dirty flag so it only re-iterates when trades have changed.
   */
  private syncLifetimeProfitFromTradeLog(): void {
    if (!this._profitSyncDirty) return;
    const settled = getTradeRecords().filter(
      (t) => t.settled && typeof t.profit === "number"
    );
    this.lifetimeTotalProfit = settled.reduce((sum, t) => sum + (t.profit ?? 0), 0);
    // Count only profitable trades (profit > 0) as wins
    this.lifetimeProfitableTrades = settled.filter((t) => (t.profit ?? 0) > 0).length;
    this._profitSyncDirty = false;
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
      // Include expired unsettled trades so they can be settled on next cycle
      // if (t.marketWindowEnd <= nowSec) continue;

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
          windowStartBtcPrice: t.btcPriceAtWindowStart,
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

    // Repopulate window start prices from restored trades so settlement uses canonical price per window
    for (const t of trades) {
      if (t.settled || t.type !== "directional") continue;
      if (t.btcPriceAtWindowStart != null && !this.windowStartPrices.has(t.marketWindowStart)) {
        this.windowStartPrices.set(t.marketWindowStart, t.btcPriceAtWindowStart);
        logger.info(`New window starting price added: $${t.btcPriceAtWindowStart.toFixed(2)} for window ${t.marketWindowStart} (restored from trade record)`);
      }
    }

    this.executions = restored;
    const unsettledDirectionalCount = getUnsettledTradeRecords(nowSec).filter(
      (t) => t.type === "directional"
    ).length;
    this.riskManager.restoreOpenPositions(unsettledDirectionalCount);
    if (restored.length > 0 || unsettledDirectionalCount > 0) {
      logger.debug(`Restored: ${restored.length} execution(s), ${unsettledDirectionalCount} open positions`);
    }
  }

  /**
   * Main loop: discover markets, monitor prices, detect and execute directional trades.
   */
  private async runMainLoop(): Promise<void> {
    if (this.config.chainlinkDsApiKey && this.config.chainlinkDsApiSecret) {
      initChainlinkFeed(
        this.config.chainlinkDsApiKey,
        this.config.chainlinkDsApiSecret,
        this.config.chainlinkBtcUsdFeedId
      );
    }
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

    // Re-discover markets: more often when not using Chainlink so we can catch the 0–45s exchange capture window
    const discoverIntervalMs = isChainlinkConfigured() ? 60000 : 15000;
    setInterval(async () => {
      if (this.isRunning) {
        await this.discoverMarkets();
      }
    }, discoverIntervalMs);

    // Periodic progress log (balance, uptime, trades, win ratio, profit)
    const progressLogIntervalMs = 600_000; // 10 minutes
    this.progressLogTimer = setInterval(() => {
      if (this.isRunning) {
        this.logProgressStatus();
      }
    }, progressLogIntervalMs);
  }

  /**
   * Log a one-line progress summary: uptime, balance (demo), trades, win ratio, profit.
   */
  private logProgressStatus(): void {
    this.syncLifetimeProfitFromTradeLog();
    const uptimeMs = Date.now() - this.stats.startTime;
    const uptimeSec = Math.floor(uptimeMs / 1000);
    const uptimeMin = Math.floor(uptimeSec / 60);
    const uptimeHr = Math.floor(uptimeMin / 60);
    const uptimeStr =
      uptimeHr > 0
        ? `${uptimeHr}h ${uptimeMin % 60}m`
        : `${uptimeMin}m`;

    const trades = this.lifetimeTradesExecuted;
    const wins = this.lifetimeProfitableTrades;
    // Win rate = wins / (wins + losses) - only count profitable vs losing trades
    const stats = getTradeStats();
    const totalWinLossTrades = stats.wins + stats.losses;
    const winRateStr =
      totalWinLossTrades > 0 ? `${((wins / totalWinLossTrades) * 100).toFixed(0)}%` : "—";
    const profit = this.lifetimeTotalProfit;
    const profitStr = profit >= 0 ? `+$${profit.toFixed(2)}` : `$${profit.toFixed(2)}`;

    let balancePart = "";
    if (this.config.dryRun && (this.config.demoStartingBalance ?? 0) > 0) {
      const balance = (this.config.demoStartingBalance ?? 1000) + profit;
      balancePart = ` | balance $${balance.toFixed(2)}`;
    }

    logger.info(
      `[Progress] uptime ${uptimeStr} | trades ${trades} | win rate ${winRateStr} | PnL ${profitStr}${balancePart}`
    );
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
    }

    // Window start price: only from Chainlink (when configured) or Polymarket scraping — never from exchange/previous-window
    const exchangePrice = this.exchangeFeed.getLatestPrice();
    const cexPrices = this.exchangeFeed.getPricesByExchange();
    for (const market of this.activeMarkets) {
      if (this.windowStartPrices.has(market.startTime)) continue;
      if (isChainlinkConfigured()) {
        const chainlinkPrice = await getBtcPriceAtTimestamp(market.startTime);
        if (chainlinkPrice != null) {
          this.windowStartPrices.set(market.startTime, chainlinkPrice);
          const exchangeStartPrices: Record<string, number> = {};
          cexPrices.forEach((price, name) => {
            exchangeStartPrices[name] = price;
          });
          this.windowStartPricesByExchange.set(market.startTime, exchangeStartPrices);
          logger.info(`New window starting price added: $${chainlinkPrice.toFixed(2)} for ${market.slug} (from Chainlink)`);
          logger.debug(`Chainlink window start price: $${chainlinkPrice.toFixed(2)} for ${market.slug}`);
        }
      }
    }
    // When Chainlink is not configured, use only Polymarket event page "price to beat" (throttled)
    if (!isChainlinkConfigured()) {
      const nowMs = Date.now();
      for (const market of this.activeMarkets) {
        if (this.windowStartPrices.has(market.startTime)) continue;
        const lastFetch = this.lastPriceToBeatFetchBySlug.get(market.slug) ?? 0;
        if (nowMs - lastFetch < PolymarketArbBot.PRICE_TO_BEAT_FETCH_INTERVAL_MS) continue;
        this.lastPriceToBeatFetchBySlug.set(market.slug, nowMs);
        try {
          const priceToBeat = await this.polymarketFeed.getPriceToBeatForEventPage(market.slug);
          if (priceToBeat != null && Number.isFinite(priceToBeat)) {
            this.windowStartPrices.set(market.startTime, priceToBeat);
            logger.info(`New window starting price added: $${priceToBeat.toFixed(2)} for ${market.slug} (from Polymarket price to beat)`);
            logger.debug(`Polymarket price to beat: $${priceToBeat.toFixed(2)} for ${market.slug}`);
          }
        } catch {
          // ignore; will retry on next discover
        }
      }
    }
    // Set the global reference for the current window if we have the start price
    // This enables immediate opportunity detection as soon as price is captured
    const { startTime } = getCurrentFiveMinWindow();
    const capturedStartPrice = this.windowStartPrices.get(startTime);
    if (capturedStartPrice !== undefined) {
      this.detector.setWindowReference(capturedStartPrice, startTime);
    } else if (exchangePrice) {
      logger.debug(
        `Window reference unavailable for ${new Date(
          startTime * 1000
        ).toISOString()} (not captured near boundary yet)`
      );
    }

    // Clean up old window start prices (older than 10 minutes)
    const cutoff = nowSec - 600;
    for (const [startTime] of this.windowStartPrices) {
      if (startTime < cutoff) {
        this.windowStartPrices.delete(startTime);
        this.windowStartPricesByExchange.delete(startTime);
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

    // Track window boundary (window start price is set only via Chainlink or Polymarket scraping, never from exchange)
    const { startTime: currentWindowStart } = getCurrentFiveMinWindow();
    if (currentWindowStart !== this.lastSeenWindowStart && currentWindowStart > this.lastSeenWindowStart) {
      logger.debug(`New window detected: ${currentWindowStart} (previous: ${this.lastSeenWindowStart})`);
      
      // Immediately discover markets and fetch window start price for new window
      await this.discoverMarkets();
      
      const cexPrices = this.exchangeFeed.getPricesByExchange();
      if (cexPrices.size > 0 && !this.windowStartPricesByExchange.has(currentWindowStart)) {
        const exchangeStartPrices: Record<string, number> = {};
        cexPrices.forEach((price, name) => {
          exchangeStartPrices[name] = price;
        });
        this.windowStartPricesByExchange.set(currentWindowStart, exchangeStartPrices);
        logger.debug(`Captured CEX window start prices for window ${currentWindowStart}`);
      }
      
      // Immediately try to fetch window start price (bypass throttle for new windows)
      const newWindowMarket = this.activeMarkets.find(m => m.startTime === currentWindowStart);
      if (newWindowMarket && !this.windowStartPrices.has(currentWindowStart)) {
        if (isChainlinkConfigured()) {
          const chainlinkPrice = await getBtcPriceAtTimestamp(currentWindowStart);
          if (chainlinkPrice != null) {
            this.windowStartPrices.set(currentWindowStart, chainlinkPrice);
            const exchangeStartPrices: Record<string, number> = {};
            cexPrices.forEach((price, name) => {
              exchangeStartPrices[name] = price;
            });
            this.windowStartPricesByExchange.set(currentWindowStart, exchangeStartPrices);
            logger.info(`New window starting price added: $${chainlinkPrice.toFixed(2)} for ${newWindowMarket.slug} (from Chainlink)`);
            this.detector.setWindowReference(chainlinkPrice, currentWindowStart);
          }
        } else {
          // Immediately fetch price-to-beat for new window (bypass throttle)
          try {
            const priceToBeat = await this.polymarketFeed.getPriceToBeatForEventPage(newWindowMarket.slug);
            if (priceToBeat != null && Number.isFinite(priceToBeat)) {
              this.windowStartPrices.set(currentWindowStart, priceToBeat);
              this.lastPriceToBeatFetchBySlug.set(newWindowMarket.slug, Date.now());
              logger.info(`New window starting price added: $${priceToBeat.toFixed(2)} for ${newWindowMarket.slug} (from Polymarket price to beat)`);
              this.detector.setWindowReference(priceToBeat, currentWindowStart);
            }
          } catch (error) {
            logger.debug(`Failed to fetch price-to-beat for new window ${newWindowMarket.slug}: ${error}`);
          }
        }
      }
      
      this.lastSeenWindowStart = currentWindowStart;
    }

    const exchangePrice = this.exchangeFeed.getLatestPrice();
    if (!exchangePrice) {
      logger.debug("No exchange price available yet");
      return;
    }

    // Record price sample for momentum analysis
    this.detector.recordPriceSample(exchangePrice.price);
    const priceAgeMs = Date.now() - exchangePrice.timestamp;
    if (priceAgeMs > MAX_EXCHANGE_PRICE_AGE_MS) {
      logger.warn(
        `Exchange price is stale (${priceAgeMs}ms old), skipping cycle`
      );
      return;
    }
    if (!this.config.dryRun && this.polymarketFeed.isSimulating()) {
      logger.warn("LIVE MODE: simulation data active, refusing to place trades");
      await this.broadcastDashboardState(exchangePrice);
      return;
    }

    const nowSec = Math.floor(Date.now() / 1000);
    // Fill missing window start prices from Chainlink (on-demand at exact timestamp)
    const cexPricesCycle = this.exchangeFeed.getPricesByExchange();
    for (const market of this.activeMarkets) {
      if (!this.windowStartPrices.has(market.startTime) && isChainlinkConfigured()) {
        const chainlinkPrice = await getBtcPriceAtTimestamp(market.startTime);
        if (chainlinkPrice != null) {
          this.windowStartPrices.set(market.startTime, chainlinkPrice);
          // Capture per-exchange prices at window start
          const exchangeStartPrices: Record<string, number> = {};
          cexPricesCycle.forEach((price, name) => {
            exchangeStartPrices[name] = price;
          });
          this.windowStartPricesByExchange.set(market.startTime, exchangeStartPrices);
          logger.info(`New window starting price added: $${chainlinkPrice.toFixed(2)} for ${market.slug} (from Chainlink)`);
          logger.debug(`Chainlink window start: $${chainlinkPrice.toFixed(2)} for ${market.slug}`);
        }
      }
    }
    // When Chainlink is not configured, try Polymarket price-to-beat (throttled, but already fetched for new windows above)
    if (!isChainlinkConfigured()) {
      const nowMs = Date.now();
      for (const market of this.activeMarkets) {
        if (this.windowStartPrices.has(market.startTime)) continue;
        const lastFetch = this.lastPriceToBeatFetchBySlug.get(market.slug) ?? 0;
        if (nowMs - lastFetch < PolymarketArbBot.PRICE_TO_BEAT_FETCH_INTERVAL_MS) continue;
        this.lastPriceToBeatFetchBySlug.set(market.slug, nowMs);
        try {
          const priceToBeat = await this.polymarketFeed.getPriceToBeatForEventPage(market.slug);
          if (priceToBeat != null && Number.isFinite(priceToBeat)) {
            this.windowStartPrices.set(market.startTime, priceToBeat);
            logger.info(`New window starting price added: $${priceToBeat.toFixed(2)} for ${market.slug} (from Polymarket price to beat)`);
            logger.debug(`Polymarket price to beat: $${priceToBeat.toFixed(2)} for ${market.slug}`);
            // Set window reference if this is the current window
            const { startTime } = getCurrentFiveMinWindow();
            if (market.startTime === startTime) {
              this.detector.setWindowReference(priceToBeat, startTime);
            }
          }
        } catch {
          // ignore
        }
      }
    }

    // Check each active market for opportunities (and cache prices for unrealized PnL)
    for (const market of this.activeMarkets) {
      if (market.endTime <= nowSec) {
        // Markets can remain in activeMarkets briefly between discovery refreshes.
        // Never fetch/trade on an already ended 5-min window.
        continue;
      }
      // For simulation mode, pass BTC prices to generate realistic lagging prices
      let actualWindowStartPrice = this.windowStartPrices.get(market.startTime);
      if (actualWindowStartPrice == null && isChainlinkConfigured()) {
        const chainlinkPrice = await getBtcPriceAtTimestamp(market.startTime);
        if (chainlinkPrice != null) {
          this.windowStartPrices.set(market.startTime, chainlinkPrice);
          // Capture per-exchange prices at window start
          const cexPricesForMarket = this.exchangeFeed.getPricesByExchange();
          const exchangeStartPrices: Record<string, number> = {};
          cexPricesForMarket.forEach((price, name) => {
            exchangeStartPrices[name] = price;
          });
          this.windowStartPricesByExchange.set(market.startTime, exchangeStartPrices);
          logger.info(`New window starting price added: $${chainlinkPrice.toFixed(2)} for ${market.slug} (from Chainlink)`);
          actualWindowStartPrice = chainlinkPrice;
        }
      }
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

      // Skip markets where we don't have the actual window start price.
      if (actualWindowStartPrice == null) {
        logger.debug(`Skipping ${market.slug}: no window start price captured`);
        continue;
      }

      this.detector.setWindowReference(actualWindowStartPrice, market.startTime);
      const secondsRemaining = market.endTime - nowSec;

      // --- Endgame arb: near-certain side close to resolution ---
      const endgameEnabled = this.config.endgameArbEnabled ?? true;
      const endgameMaxSec = this.config.endgameMaxSecondsRemaining ?? 60;
      const endgameMinSec = this.config.endgameMinSecondsRemaining ?? 5;
      const inEndgameWindow =
        secondsRemaining <= endgameMaxSec && secondsRemaining >= endgameMinSec;

      if (endgameEnabled && inEndgameWindow) {
        const endgameOpp = this.detector.detectEndgameOpportunity(
          prices,
          exchangePrice,
          secondsRemaining,
          {
            endgameMinProbability: this.config.endgameMinProbability ?? 0.85,
            endgameMaxAsk: this.config.endgameMaxAsk ?? 0.98,
            minAskSizeShares: this.config.minAskSizeShares ?? 50,
          }
        );
        if (endgameOpp) {
          endgameOpp.windowStartBtcPrice = actualWindowStartPrice;
          await this.handleOpportunity(endgameOpp);
          continue;
        }
      }

      // --- Directional edge ---
      const minEdge = this.config.minEdgePercent ?? 5;
      let signalThreshold = this.config.exchangeSignalThresholdPercent ?? 0.02;
      let minMove = this.config.minExchangeMovePercent ?? 0.03;
      const minWinProbability = this.config.minWinProbability ?? 0.52;
      const minAskSize = this.config.minAskSizeShares ?? 30;

      // Adjust thresholds based on rolling BTC volatility (capped so high vol doesn't over-tighten)
      const volatility = this.exchangeFeed.getVolatility();
      if (volatility != null) {
        // Baseline: ~0.02% stdev for BTC 2-second returns in normal conditions
        const baselineVol = 0.02;
        const volRatio = volatility / baselineVol;
        const adjustmentFactor = Math.max(0.6, Math.min(1.3, 0.5 + volRatio * 0.5));
        signalThreshold *= adjustmentFactor;
        minMove *= adjustmentFactor;
        if (Math.abs(volRatio - 1.0) > 0.3) {
          logger.debug(`Volatility adjustment: vol=${volatility.toFixed(4)}% ratio=${volRatio.toFixed(2)}x, thresholds ${adjustmentFactor.toFixed(2)}x`);
        }
      }
      const directionalOpp = this.detector.detectDirectionalOpportunity(
        prices,
        exchangePrice,
        minEdge,
        signalThreshold,
        minMove,
        secondsRemaining,
        minWinProbability,
        minAskSize
      );
      if (directionalOpp) {
        directionalOpp.windowStartBtcPrice = actualWindowStartPrice;
        await this.handleOpportunity(directionalOpp);
      }
    }

    // Check open positions for stop loss and take profit exits
    await this.checkStopLossAndTakeProfit(exchangePrice);

    await this.releasePositionsForEndedMarkets(exchangePrice?.price ?? null);
    
    // Clean up old pending settlements (older than 1 hour) - they should have resolved by then
    const oneHourAgo = Date.now() - 3600000;
    for (const [key, pending] of this.pendingSettlements.entries()) {
      if (pending.lastChecked < oneHourAgo) {
        logger.warn(`Pending settlement expired: ${key} (marketEndTime: ${pending.marketEndTime})`);
        this.pendingSettlements.delete(key);
      }
    }
    
    // Clean up old window end prices (older than 1 hour)
    const cutoff = nowSec - 3600;
    for (const [windowEnd] of this.windowEndPrices) {
      if (windowEnd < cutoff) {
        this.windowEndPrices.delete(windowEnd);
      }
    }
    
    this.trimExecutions();
    await this.broadcastDashboardState(exchangePrice);
  }

  /**
   * Check open positions for stop loss and take profit conditions, exit if triggered.
   */
  private async checkStopLossAndTakeProfit(exchangePrice: ExchangePrice | null): Promise<void> {
    if (!exchangePrice) return;
    
    const stopLossPercent = this.config.stopLossPercent ?? 0.10;
    
    // Skip if disabled
    if (stopLossPercent === 0) return;
    
    const nowSec = Math.floor(Date.now() / 1000);
    
    for (const execution of this.executions) {
      if (!execution.fullyExecuted || execution.settled || execution.pendingSettlement) continue;
      if (execution.opportunity.market.endTime <= nowSec) continue; // Window ended, will be settled
      
      const key = this.getExecutionKey(execution);
      const opp = execution.opportunity;
      const isUp = opp.exchangeSignal === "UP";
      const side = isUp ? "YES" : "NO";
      const tokenId = isUp ? opp.market.yesTokenId : opp.market.noTokenId;
      const entryPrice = isUp ? opp.yesPrice : opp.noPrice;
      const filledSize = isUp ? (execution.yesTrade.filledSize ?? 0) : (execution.noTrade.filledSize ?? 0);
      
      if (filledSize === 0) continue;
      
      // Get current market price
      const marketPrices = this.lastMarketPricesBySlug.get(opp.market.slug);
      if (!marketPrices) continue;
      
      const currentBidPrice = isUp ? marketPrices.yesBestBid : marketPrices.noBestBid;
      if (currentBidPrice === 0) continue; // No bid available
      
      // Calculate unrealized PnL
      const unrealizedProfit = (currentBidPrice - entryPrice) * filledSize;
      const entryCost = entryPrice * filledSize;
      const pnlPercent = entryCost > 0 ? (unrealizedProfit / entryCost) : 0;
      
      let shouldExit = false;
      let exitReason: "stop-loss" | null = null;
      
      // Check stop loss
      if (stopLossPercent > 0 && pnlPercent <= -stopLossPercent) {
        shouldExit = true;
        exitReason = "stop-loss";
      }
      
      if (shouldExit && exitReason) {
        logger.info(`Exiting position: ${opp.market.slug} | ${exitReason} | PnL ${pnlPercent >= 0 ? "+" : ""}${(pnlPercent * 100).toFixed(1)}% ($${unrealizedProfit.toFixed(2)})`);
        
        try {
          const sellResult = await this.trader.placeLimitSell(tokenId, currentBidPrice, filledSize, side);
          if (sellResult.success && sellResult.filledSize && sellResult.filledSize > 0) {
            const exitPrice = sellResult.price;
            const actualProfit = (exitPrice - entryPrice) * sellResult.filledSize;
            
            execution.actualProfit = actualProfit;
            execution.settled = true;
            execution.lossCapped = exitReason === "stop-loss";
            execution.profitTaken = false;
            
            this.lifetimeTotalProfit += actualProfit;
            if (actualProfit > 0) this.lifetimeProfitableTrades++;
            this._profitSyncDirty = true;
            this.riskManager.recordSettlement(actualProfit);
            
            // Update trade record
            const tradeId = this.getExecutionTradeId(execution);
            if (tradeId) {
              updateTradeSettlement(
                tradeId,
                actualProfit,
                exchangePrice.price,
                execution.lossCapped,
                execution.profitTaken
              );
            }
            
            logger.info(`Position exited: ${opp.market.slug} | ${exitReason} | Profit $${actualProfit.toFixed(2)}`);
          }
        } catch (error) {
          logger.error(`Failed to exit position ${opp.market.slug}: ${error}`);
        }
      }
    }
  }

  /**
   * Release open positions when their 5-min market window has ended.
   * For directional trades, resolve PnL using BTC at window end vs window start.
   * Only settles when Polymarket API confirms the market is resolved to avoid false outcomes.
   */
  private async releasePositionsForEndedMarkets(fallbackBtcPrice: number | null): Promise<void> {
    const nowSec = Math.floor(Date.now() / 1000);
    
    // Build a map of Polymarket resolved markets by windowEnd for quick lookup
    const resolvedByWindowEnd = new Map<number, (typeof this.recentResolvedMarkets)[number]>();
    for (const resolved of this.recentResolvedMarkets) {
      resolvedByWindowEnd.set(resolved.windowEnd, resolved);
    }
    
    for (const execution of this.executions) {
      if (!execution.fullyExecuted) continue;
      const { market, detectedAt, exchangeSignal } = execution.opportunity;
      if (market.endTime > nowSec) continue;
      const key = `${market.slug}-${detectedAt}`;
      if (this.releasedPositionKeys.has(key) || execution.settled) continue;
      const tradeId = this.getExecutionTradeId(execution);
      if (tradeId && getTradeRecordById(tradeId)?.settled) {
        execution.settled = true;
        execution.pendingSettlement = false;
        this.releasedPositionKeys.add(key);
        this.settlementEndPriceByKey.delete(key);
        this.settlementPriceFromChainlinkByKey.delete(key);
        this.pendingSettlements.delete(key);
        continue;
      }

      const isDirectional = execution.opportunity.totalCost >= 1.0;
      if (!isDirectional) {
        // Non-directional trades can be released immediately
        this.riskManager.releasePosition();
        this.releasedPositionKeys.add(key);
        continue;
      }

      // For directional trades, check if Polymarket has confirmed the outcome
      const polymarketResolved = resolvedByWindowEnd.get(market.endTime);
      
      if (!polymarketResolved || !polymarketResolved.outcome) {
        // Polymarket hasn't confirmed yet - defer settlement but release position from open count
        const existing = this.pendingSettlements.get(key);
        if (!existing) {
          this.pendingSettlements.set(key, { marketEndTime: market.endTime, lastChecked: Date.now() });
          execution.pendingSettlement = true;
          this.riskManager.releasePosition(); // Release from open count so we can trade in next window
          logger.debug(`Settlement pending for ${market.slug}: waiting for Polymarket confirmation (windowEnd: ${market.endTime})`);
        } else {
          // Update last checked timestamp
          existing.lastChecked = Date.now();
        }
        continue;
      }

      // Polymarket has confirmed - proceed with settlement using verified outcome
      const polymarketOutcome = polymarketResolved.outcome; // "UP" or "DOWN"
      
      // Lock in the BTC price the first time we see the window has ended.
      // Prefer Chainlink at exact window end (same as Polymarket); fallback to exchange price.
      if (!this.settlementEndPriceByKey.has(key)) {
        let priceToLock: number | null = null;
        let fromChainlink = false;
        if (isChainlinkConfigured()) {
          priceToLock = await getBtcPriceAtTimestamp(market.endTime);
          if (priceToLock != null) fromChainlink = true;
          if (priceToLock == null) {
            logger.debug(`Settlement: Chainlink null for ${market.slug} endTime ${market.endTime}, using exchange fallback`);
          }
        }
        if (priceToLock == null) priceToLock = fallbackBtcPrice;
        if (priceToLock != null) {
          this.settlementEndPriceByKey.set(key, priceToLock);
          if (fromChainlink) this.settlementPriceFromChainlinkByKey.add(key);
          // Store window end price for use as next window's start price
          this.windowEndPrices.set(market.endTime, priceToLock);
        }
      }
      const priceAtEnd = this.settlementEndPriceByKey.get(key) ?? fallbackBtcPrice ?? null;

      // Use canonical window start price for this market (prefer previous window's end price)
      const windowStartBtcPrice =
        this.windowStartPrices.get(market.startTime) ?? execution.opportunity.windowStartBtcPrice;

      if (priceAtEnd == null) {
        logger.debug(`Settlement deferred for ${market.slug}: no BTC price yet`);
        continue;
      }
      
      if (typeof windowStartBtcPrice !== "number") {
        logger.warn(`Settlement skipped for ${market.slug}: missing window start price, resolving as $0`);
        execution.actualProfit = 0;
        execution.settled = true;
        execution.pendingSettlement = false;
        this._profitSyncDirty = true;
        this.riskManager.recordSettlement(0);
        if (tradeId) {
          const updated = updateTradeSettlement(
            tradeId,
            0,
            priceAtEnd ?? execution.opportunity.exchangePrice.price,
            false
          );
          if (!updated) {
            logger.warn(`Settlement (no window start price): trade record not updated`, {
              tradeId,
              key,
            });
          }
        }
        this.releasedPositionKeys.add(key);
        this.settlementEndPriceByKey.delete(key);
        this.settlementPriceFromChainlinkByKey.delete(key);
        this.pendingSettlements.delete(key);
        continue;
      }

      // Calculate outcome based on prices
      const ourCalculatedOutcome = priceAtEnd >= windowStartBtcPrice ? "UP" : "DOWN";
      
      // Verify against Polymarket's outcome - use Polymarket as source of truth
      if (polymarketOutcome !== ourCalculatedOutcome) {
        const windowIso = new Date(market.endTime * 1000).toISOString();
        logger.warn(
          `Settlement: our prices said ${ourCalculatedOutcome} but Polymarket resolved ${polymarketOutcome} for window ${windowIso}. Using Polymarket result.`
        );
        logger.debug("Outcome mismatch detail", {
          windowEnd: market.endTime,
          ourPriceAtStart: windowStartBtcPrice,
          ourPriceAtEnd: priceAtEnd,
          polymarketOutcome,
        });
      }
      
      // Use Polymarket's confirmed outcome for settlement
      const weBetUp = exchangeSignal === "UP";
      const ourSideWon = (weBetUp && polymarketOutcome === "UP") || (!weBetUp && polymarketOutcome === "DOWN");
      
      const filledSize = weBetUp
        ? (execution.yesTrade.filledSize ?? 0)
        : (execution.noTrade.filledSize ?? 0);
      const actualProfit = ourSideWon
        ? filledSize * 1.0 - execution.actualTotalCost
        : -execution.actualTotalCost;
      
      execution.actualProfit = actualProfit;
      execution.settled = true;
      execution.pendingSettlement = false;
      this.lifetimeTotalProfit += actualProfit;
      if (actualProfit > 0) this.lifetimeProfitableTrades++;
      this._profitSyncDirty = true;
      this.riskManager.recordSettlement(actualProfit);

      // Update trade record with settlement info
      if (tradeId) {
        const updated = updateTradeSettlement(tradeId, actualProfit, priceAtEnd, false);
        if (!updated) {
          logger.warn(`Settlement: trade record not updated (trade not found or already settled)`, {
            tradeId,
            key,
          });
        }
      }

      // Record historical market only when we used Chainlink for price-at-end (same oracle as Polymarket).
      if (this.settlementPriceFromChainlinkByKey.has(key)) {
        recordHistoricalMarket({
          windowStart: market.startTime,
          windowEnd: market.endTime,
          btcPriceAtStart: windowStartBtcPrice,
          btcPriceAtEnd: priceAtEnd,
          outcome: polymarketOutcome,
          recordedAt: Date.now(),
        });
      } else {
        logger.debug(`Settlement: skipping historical record for ${market.slug} (price at end from exchange fallback, not Chainlink)`);
      }

      const pnlStr = actualProfit >= 0 ? `+$${actualProfit.toFixed(2)}` : `$${actualProfit.toFixed(2)}`;
      logger.info(
        `[Settlement] ${market.slug} | Bet ${exchangeSignal} | ${ourSideWon ? "WON" : "LOST"} | ${pnlStr}`
      );
      logger.debug(
        `Settlement detail: BTC start=$${windowStartBtcPrice.toFixed(2)} end=$${priceAtEnd.toFixed(2)} | Polymarket outcome=${polymarketOutcome}`
      );

      // Clean up settlement tracking
      this.releasedPositionKeys.add(key);
      this.settlementEndPriceByKey.delete(key);
      this.settlementPriceFromChainlinkByKey.delete(key);
      this.pendingSettlements.delete(key);
    }
  }

  /**
   * Merge locally recorded historical markets (from our settlements) with API-resolved markets.
   * When both exist for the same windowEnd, prefer API outcome (Polymarket source of truth) and keep local prices.
   */
  private mergeHistoricalMarketsForDashboard(): NonNullable<DashboardState["historicalMarkets"]> {
    const local = getHistoricalMarkets(100);
    const api = this.recentResolvedMarkets;
    const apiByWindowEnd = new Map<number, (typeof api)[number]>();
    for (const m of api) {
      apiByWindowEnd.set(m.windowEnd, m);
    }
    const byWindowEnd = new Map<number, (typeof local)[number]>();
    for (const m of local) {
      const apiRecord = apiByWindowEnd.get(m.windowEnd);
      if (apiRecord) {
        if (apiRecord.outcome !== m.outcome) {
          logger.warn("Historical outcome discrepancy: local vs Polymarket API", {
            windowEnd: m.windowEnd,
            windowEndIso: new Date(m.windowEnd * 1000).toISOString(),
            localOutcome: m.outcome,
            apiOutcome: apiRecord.outcome,
          });
          updateHistoricalMarketOutcome(m.windowEnd, apiRecord.outcome);
        }
        byWindowEnd.set(m.windowEnd, { ...m, outcome: apiRecord.outcome });
      } else {
        byWindowEnd.set(m.windowEnd, m);
      }
    }
    for (const m of api) {
      if (!byWindowEnd.has(m.windowEnd)) {
        byWindowEnd.set(m.windowEnd, m);
      }
    }
    return Array.from(byWindowEnd.values())
      .sort((a, b) => b.windowEnd - a.windowEnd)
      .slice(0, 100);
  }

  private async broadcastDashboardState(exchangePrice: { price: number; timestamp: number } | null): Promise<void> {
    if (!this.dashboard) return;
    this.syncLifetimeProfitFromTradeLog();
    const { startTime, endTime } = getCurrentFiveMinWindow();
    const risk = this.riskManager.getState();
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

    // Change detection: skip expensive array building + JSON serialization when key fields unchanged
    const broadcastKey = [
      exchangePrice?.price ?? 0,
      risk.openPositions,
      risk.tradesLastMinute,
      this.lifetimeTotalProfit,
      this.executions.length,
      currentMarketPrices?.up ?? 0,
      currentMarketPrices?.down ?? 0,
      startTime,
    ].join("|");
    if (broadcastKey === this._lastBroadcastKey) return;
    this._lastBroadcastKey = broadcastKey;

    const recentExecutions = this.executions.slice(-MAX_EXECUTIONS_FOR_DASHBOARD);
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
      const pendingSettlement = e.pendingSettlement === true;
      const filledSize = side === "UP" ? (e.yesTrade.filledSize ?? 0) : (e.noTrade.filledSize ?? 0);
      const prices = this.lastMarketPricesBySlug.get(opp.market.slug);
      let unrealizedProfit: number | null = null;
      if (!settled && prices && filledSize > 0) {
        const currentPrice = side === "UP" ? prices.yesBestBid : prices.noBestBid;
        unrealizedProfit = (currentPrice - entryPrice) * filledSize;
      }
      return {
        id: this.getExecutionTradeId(e),
        marketSlug: opp.market.slug,
        actualProfit: e.actualProfit,
        fullyExecuted: e.fullyExecuted,
        settled,
        pendingSettlement,
        timestamp: opp.detectedAt,
        side,
        entry: entryStr,
        size: opp.suggestedSize,
        marketWindowStart: opp.market.startTime,
        marketWindowEnd: opp.market.endTime,
        unrealizedProfit,
        lossCapped: e.lossCapped,
        profitTaken: e.profitTaken,
        kellyFraction: opp.kellyFraction,
        estimatedWinProbability: opp.estimatedWinProbability,
      };
    });
    const allTradeRecords = getTradeRecords();
    const persistedExecutions: DashboardState["executions"] = allTradeRecords
      .slice(-MAX_EXECUTIONS_FOR_DASHBOARD)
      .map((t) => ({
        id: t.id,
        marketSlug: t.marketSlug,
        actualProfit: t.profit ?? 0,
        fullyExecuted: true,
        settled: t.settled,
        timestamp: t.timestamp,
        side: t.side,
        entry: `${Math.round(t.entryPrice * 100)}¢`,
        size: t.size,
        marketWindowStart: t.marketWindowStart,
        marketWindowEnd: t.marketWindowEnd,
        unrealizedProfit: null,
        lossCapped: t.lossCapped ?? false,
        profitTaken: t.profitTaken ?? false,
        kellyFraction: t.kellyFraction,
        estimatedWinProbability: t.estimatedWinProbability,
      }));
    // Full trade history for Closed tab (newest first)
    const tradeHistory: DashboardState["executions"] = [...allTradeRecords]
      .reverse()
      .map((t) => ({
        id: t.id,
        marketSlug: t.marketSlug,
        actualProfit: t.profit ?? 0,
        fullyExecuted: true,
        settled: t.settled,
        timestamp: t.timestamp,
        side: t.side,
        entry: `${Math.round(t.entryPrice * 100)}¢`,
        size: t.size,
        marketWindowStart: t.marketWindowStart,
        marketWindowEnd: t.marketWindowEnd,
        unrealizedProfit: null,
        lossCapped: t.lossCapped ?? false,
        profitTaken: t.profitTaken ?? false,
        kellyFraction: t.kellyFraction,
        estimatedWinProbability: t.estimatedWinProbability,
      }));
    const byKey = new Map<string, (typeof liveExecutions)[number]>();
    const combined = [...liveExecutions, ...persistedExecutions];
    for (const e of combined) {
      const key = e.id ?? `${e.marketSlug}-${e.timestamp}-${e.side}`;
      const existing = byKey.get(key);
      if (!existing) {
        byKey.set(key, e);
      } else if (e.unrealizedProfit != null && existing.unrealizedProfit == null) {
        byKey.set(key, e);
      }
    }
    const mergedExecutions: DashboardState["executions"] = Array.from(byKey.values())
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
      cexWindowStartPrices: this.windowStartPricesByExchange.get(startTime),
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
      tradeHistory,
      recentLogs,
      historicalMarkets: this.mergeHistoricalMarketsForDashboard(),
    });
  }

  /** Log once per market per window when we skip an endgame opportunity so user sees why nothing opened. */
  private logEndgameSkippedOnce(slug: string, endTime: number, reason: string): void {
    const key = `${slug}-${endTime}`;
    if (!this.endgameSkippedLoggedForMarket.has(key)) {
      this.endgameSkippedLoggedForMarket.add(key);
      logger.info(`Endgame skipped for ${slug}: ${reason}`);
    }
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
    const marketSecondsRemaining = opportunity.market.endTime - nowSec;
    const isEndgame = opportunity.opportunityType === "endgame";

    if (isEndgame) {
      const endgameMaxSec = this.config.endgameMaxSecondsRemaining ?? 60;
      const endgameMinSec = this.config.endgameMinSecondsRemaining ?? 5;
      if (
        marketSecondsRemaining > endgameMaxSec ||
        marketSecondsRemaining < endgameMinSec
      ) {
        this.logEndgameSkippedOnce(
          opportunity.market.slug,
          opportunity.market.endTime,
          `outside time window (${marketSecondsRemaining}s left, need [${endgameMinSec}, ${endgameMaxSec}])`
        );
        return;
      }
    } else {
      const minSecLeft = this.config.minSecondsRemainingInWindow ?? 15;
      const maxSecLeft = this.config.maxSecondsRemainingInWindow ?? 270;
      if (marketSecondsRemaining < minSecLeft) {
        logger.debug(
          `Skip directional: only ${marketSecondsRemaining}s left in market window (min ${minSecLeft}s)`
        );
        return;
      }
      if (marketSecondsRemaining > maxSecLeft) {
        logger.debug(
          `Skip directional: too early in window (${marketSecondsRemaining}s remaining, max ${maxSecLeft}s)`
        );
        return;
      }
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
        kellyFraction: opportunity.kellyFraction,
        kellyMultiplier: this.config.kellyMultiplier,
      });
      if (!decision.allowed) {
        if (isEndgame) {
          this.logEndgameSkippedOnce(opportunity.market.slug, opportunity.market.endTime, `demo capital — ${decision.reason}`);
        } else {
          logger.debug(`Skip trade: demo capital — ${decision.reason}`);
        }
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
        logger.debug(`Capped size: final $${(opportunity.totalCost * decision.finalSuggestedSize!).toFixed(2)} (max $${decision.maxAllowedNotionalUsd.toFixed(2)})`);
      }
    }

    // Cap order size to available liquidity at best ask
    const marketPricesForSize = this.lastMarketPricesBySlug.get(toExecute.market.slug);
    if (marketPricesForSize) {
      const isUp = toExecute.exchangeSignal === "UP";
      const availableSize = isUp ? marketPricesForSize.yesBestAskSize : marketPricesForSize.noBestAskSize;
      if (availableSize != null && toExecute.suggestedSize > availableSize) {
        const cappedSize = Math.max(1, Math.floor(availableSize));
        toExecute = {
          ...toExecute,
          suggestedSize: cappedSize,
          totalExpectedProfit: toExecute.profitPerShare * cappedSize,
        };
        logger.debug(`Capped size to available liquidity: ${cappedSize} shares (available: ${availableSize})`);
      }
    }

    this.stats.opportunitiesFound++;

    // Risk check
    const riskCheck = this.riskManager.checkTrade(toExecute);
    if (!riskCheck.allowed) {
      const reason = riskCheck.reason ?? "";
      if (isEndgame) {
        this.logEndgameSkippedOnce(opportunity.market.slug, opportunity.market.endTime, reason);
      } else {
        const isExpectedLimit =
          reason.includes("Min time between trades") ||
          reason.includes("Max open positions reached");
        if (isExpectedLimit) {
          logger.debug(`Trade blocked by risk: ${reason}`);
        } else {
          logger.warn(`Trade blocked by risk: ${reason}`);
        }
      }
      return;
    }

    logger.info(`Opening position: ${toExecute.market.slug} (expected profit $${toExecute.totalExpectedProfit.toFixed(2)})`);

    const preExecuteNowSec = Math.floor(Date.now() / 1000);
    const remainingBeforeExecution = toExecute.market.endTime - preExecuteNowSec;
    if (remainingBeforeExecution <= EXECUTION_END_BUFFER_SEC) {
      if (isEndgame) {
        this.logEndgameSkippedOnce(toExecute.market.slug, toExecute.market.endTime, `too close to end (${remainingBeforeExecution}s)`);
      } else {
        logger.debug(`Skip trade: ${toExecute.market.slug} too close to end (${remainingBeforeExecution}s)`);
      }
      return;
    }

    if (toExecute.opportunityType === "endgame") {
      const logKey = `${toExecute.market.slug}-${toExecute.market.endTime}`;
      if (!this.endgameLoggedForMarket.has(logKey)) {
        this.endgameLoggedForMarket.add(logKey);
        const entryPrice = toExecute.exchangeSignal === "UP" ? toExecute.yesPrice : toExecute.noPrice;
        logger.info(
          `Endgame arb: opening ${toExecute.exchangeSignal} on ${toExecute.market.slug} | entry $${entryPrice.toFixed(2)}, ~${toExecute.profitPercent.toFixed(1)}% if win, ${remainingBeforeExecution}s left`
        );
      }
    }

    const execution = await this.trader.executeDirectional(toExecute);
    execution.settled = false;
    this.executions.push(execution);
    this.riskManager.recordExecution(execution);

    if (execution.fullyExecuted) {
      this.lifetimeTradesExecuted++;
      this.stats.directionalTradesExecuted++;
      // "Position opened" is logged by the trader with size/cost details
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
    const profitPerHour = runtime > 0 ? (this.stats.totalProfit / runtime) * 3600 : 0;
    logger.info(
      `Session: ${runtime.toFixed(0)}s | Cycles ${this.stats.cyclesRun} | Trades ${this.stats.tradesExecuted} (dir ${this.stats.directionalTradesExecuted}) | PnL $${this.stats.totalProfit.toFixed(2)} ($${profitPerHour.toFixed(2)}/hr)`
    );
  }

  /**
   * Trim in-memory executions to keep at most 200 settled + all unsettled.
   * Discards the oldest settled entries to prevent unbounded memory growth.
   */
  private trimExecutions(): void {
    if (this.executions.length <= 250) return;
    let settledCount = 0;
    for (const e of this.executions) {
      if (e.settled) settledCount++;
    }
    if (settledCount <= 200) return;
    const settledToSkip = settledCount - 200;
    let skipped = 0;
    const keep: ArbitrageExecution[] = [];
    for (const e of this.executions) {
      if (e.settled && skipped < settledToSkip) {
        skipped++;
        continue;
      }
      keep.push(e);
    }
    this.executions = keep;
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
