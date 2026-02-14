import {
  ArbitrageOpportunity,
  ExchangePrice,
  MarketPrices,
  PriceDirection,
} from "../types";
import { logger } from "../utils/logger";

/**
 * Arbitrage detection engine.
 *
 * STRATEGY: On Polymarket, binary markets have YES and NO tokens.
 * Together they always resolve to exactly $1.00 (one wins, one loses).
 *
 *   If we buy 1 YES at $0.48 + 1 NO at $0.48 = $0.96 total cost
 *   After resolution, one pays $1.00 -> guaranteed $0.04 profit
 *
 * This happens when:
 *   1. The market is inefficient (yes_ask + no_ask < 1.00)
 *   2. There's a price delay: exchange prices move but Polymarket
 *      hasn't caught up, temporarily mispricing both sides
 *
 * The delay comes from Polymarket using Chainlink/UMA oracles to
 * resolve markets. Exchange prices update in milliseconds; oracle
 * prices update in seconds-to-minutes. During this window, market
 * makers on Polymarket may not have adjusted their quotes.
 */
export class ArbitrageDetector {
  private readonly minProfitCents: number;
  private readonly maxPositionUsdc: number;

  /** Track the reference price at the start of each 5-min window */
  private windowReferencePrice: number | null = null;
  private windowStartTime: number = 0;

  constructor(minProfitCents: number, maxPositionUsdc: number) {
    this.minProfitCents = minProfitCents;
    this.maxPositionUsdc = maxPositionUsdc;
  }

  /**
   * Set the reference price for the current 5-minute window.
   * This is the price at the start of the window — the oracle
   * will compare the end-of-window price against this.
   */
  setWindowReference(price: number, windowStart: number): void {
    this.windowReferencePrice = price;
    this.windowStartTime = windowStart;
    logger.info(
      `Window reference set: $${price.toFixed(2)} at ${new Date(windowStart * 1000).toISOString()}`
    );
  }

  /**
   * Determine which direction the exchange price suggests the
   * 5-min candle will close relative to the window reference price.
   *
   * If exchange price is significantly above the reference -> UP
   * If exchange price is significantly below -> DOWN
   * Otherwise -> NEUTRAL
   */
  getExchangeSignal(
    currentExchangePrice: number,
    thresholdPercent: number = 0.02
  ): PriceDirection {
    if (!this.windowReferencePrice) return "NEUTRAL";

    const pctChange =
      ((currentExchangePrice - this.windowReferencePrice) /
        this.windowReferencePrice) *
      100;

    if (pctChange > thresholdPercent) return "UP";
    if (pctChange < -thresholdPercent) return "DOWN";
    return "NEUTRAL";
  }

  /**
   * Core detection: check if buying both YES + NO costs less than $1.
   *
   * Returns an ArbitrageOpportunity if profitable, null otherwise.
   */
  detectArbitrage(
    marketPrices: MarketPrices,
    exchangePrice: ExchangePrice
  ): ArbitrageOpportunity | null {
    const yesAsk = marketPrices.yesBestAsk;
    const noAsk = marketPrices.noBestAsk;
    const totalCost = yesAsk + noAsk;

    // The guaranteed profit per share pair
    const profitPerShare = 1.0 - totalCost;
    const profitCents = profitPerShare * 100;

    // Log every check for monitoring
    logger.debug(
      `Arb check: YES=${yesAsk.toFixed(3)} + NO=${noAsk.toFixed(3)} = ${totalCost.toFixed(3)} | profit=${profitCents.toFixed(1)}c`,
      { market: marketPrices.market.slug }
    );

    // Must meet minimum profit threshold
    if (profitCents < this.minProfitCents) {
      return null;
    }

    // Calculate how many share pairs we can buy within position limits
    const maxSharesByBudget = Math.floor(this.maxPositionUsdc / totalCost);
    const suggestedSize = Math.max(1, maxSharesByBudget);

    const signal = this.getExchangeSignal(exchangePrice.price);

    const opportunity: ArbitrageOpportunity = {
      market: marketPrices.market,
      totalCost,
      profitPerShare,
      profitPercent: (profitPerShare / totalCost) * 100,
      yesPrice: yesAsk,
      noPrice: noAsk,
      suggestedSize,
      totalExpectedProfit: profitPerShare * suggestedSize,
      exchangePrice,
      exchangeSignal: signal,
      detectedAt: Date.now(),
    };

    logger.info(
      `ARB DETECTED: ${marketPrices.market.slug} | ` +
        `YES=$${yesAsk.toFixed(3)} + NO=$${noAsk.toFixed(3)} = $${totalCost.toFixed(3)} | ` +
        `Profit: $${opportunity.totalExpectedProfit.toFixed(4)} (${opportunity.profitPercent.toFixed(2)}%) | ` +
        `Signal: ${signal} | Size: ${suggestedSize}`
    );

    return opportunity;
  }

  /**
   * Enhanced detection that also considers directional trades.
   *
   * Beyond pure arbitrage (yes+no<$1), we can also make directional
   * bets when the exchange price strongly signals a direction but
   * Polymarket hasn't adjusted yet.
   *
   * Example: BTC jumps 0.5% on Binance in 30 seconds, but Polymarket's
   * "BTC up in next 5 min" YES token is still priced at $0.50.
   * We'd expect it to be worth ~$0.70+ given the momentum.
   */
  detectDirectionalOpportunity(
    marketPrices: MarketPrices,
    exchangePrice: ExchangePrice,
    minEdgePercent: number = 10,
    signalThresholdPercent: number = 0.03,
    minExchangeMovePercent: number = 0.15
  ): ArbitrageOpportunity | null {
    const signal = this.getExchangeSignal(exchangePrice.price, signalThresholdPercent);
    if (signal === "NEUTRAL") return null;

    // If exchange says UP, the YES token should be more expensive
    // If exchange says DOWN, the NO token should be more expensive
    // We look for cases where Polymarket hasn't caught up

    const targetToken = signal === "UP" ? "YES" : "NO";
    const targetAsk =
      signal === "UP" ? marketPrices.yesBestAsk : marketPrices.noBestAsk;

    // Estimate the "fair" price based on exchange movement
    // A strong move increases the probability significantly
    if (!this.windowReferencePrice) return null;

    const pctMove = Math.abs(
      ((exchangePrice.price - this.windowReferencePrice) /
        this.windowReferencePrice) *
        100
    );

    // Only enter when the exchange move is meaningful (avoids trading on noise)
    if (pctMove < minExchangeMovePercent) return null;

    // Map exchange move magnitude to estimated probability
    // Calibrated heuristic: larger moves are more likely to hold, but not 1:1
    // A 0.1% move suggests ~55% probability; 0.5% move suggests ~70%
    // Cap at 80% to account for mean reversion and uncertainty
    const estimatedFairPrice = Math.min(0.80, 0.5 + pctMove * 0.4);
    const edgePercent = ((estimatedFairPrice - targetAsk) / targetAsk) * 100;

    if (edgePercent < minEdgePercent) return null;

    const otherAsk =
      signal === "UP" ? marketPrices.noBestAsk : marketPrices.yesBestAsk;
    const totalCost = targetAsk + otherAsk;

    logger.info(
      `DIRECTIONAL: ${targetToken} on ${marketPrices.market.slug} | ` +
        `Ask=$${targetAsk.toFixed(3)} vs Fair=$${estimatedFairPrice.toFixed(3)} | ` +
        `Edge: ${edgePercent.toFixed(1)}% | Exchange move: ${pctMove.toFixed(3)}%`
    );

    // suggestedSize must respect total cost (we buy BOTH YES and NO), so
    // totalCost * suggestedSize <= maxPositionUsdc
    const suggestedSize = Math.max(
      1,
      Math.floor(this.maxPositionUsdc / totalCost)
    );

    return {
      market: marketPrices.market,
      totalCost,
      profitPerShare: estimatedFairPrice - targetAsk,
      profitPercent: edgePercent,
      yesPrice: marketPrices.yesBestAsk,
      noPrice: marketPrices.noBestAsk,
      suggestedSize,
      totalExpectedProfit: (estimatedFairPrice - targetAsk) * suggestedSize,
      exchangePrice,
      exchangeSignal: signal,
      windowStartBtcPrice: this.windowReferencePrice ?? undefined,
      detectedAt: Date.now(),
    };
  }
}
