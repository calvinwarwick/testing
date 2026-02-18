import {
  ArbitrageOpportunity,
  ExchangePrice,
  MarketPrices,
  PriceDirection,
} from "../types";
import { logger } from "../utils/logger";

/**
 * Directional detection engine for 5-min BTC up/down markets.
 * Compares exchange (CEX) price vs window-start price for signal (UP/DOWN)
 * and Polymarket YES/NO asks for edge vs fair value.
 */
export class ArbitrageDetector {
  private readonly maxPositionUsdc: number;

  /** Track the reference price at the start of each 5-min window */
  private windowReferencePrice: number | null = null;
  private windowStartTime: number = 0;

  constructor(maxPositionUsdc: number) {
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
    logger.debug(
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
   * Detect a directional opportunity when CEX signals a direction and
   * Polymarket hasn't fully priced it in (edge above threshold).
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

    // Kelly Criterion: optimal fraction of bankroll to wager
    // For a binary outcome paying $1 if correct, $0 if wrong:
    //   f* = (p - cost) / (1 - cost)
    // where p = estimated win probability, cost = entry price per share
    const kellyFraction = Math.max(0, (estimatedFairPrice - targetAsk) / (1 - targetAsk));

    const otherAsk =
      signal === "UP" ? marketPrices.noBestAsk : marketPrices.yesBestAsk;
    const totalCost = targetAsk + otherAsk;

    const direction = signal === "UP" ? "UP" : "DOWN";
    logger.info(
      `Position detected: bet ${direction} on ${marketPrices.market.slug} | entry $${targetAsk.toFixed(2)}, edge ${edgePercent.toFixed(1)}%`
    );
    logger.debug(
      `Detection detail: Fair=$${estimatedFairPrice.toFixed(3)} | Kelly: ${(kellyFraction * 100).toFixed(1)}% | Exchange move: ${pctMove.toFixed(3)}%`
    );

    // suggestedSize is a max-position fallback; actual sizing uses Kelly in demo-capital
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
      kellyFraction,
      estimatedWinProbability: estimatedFairPrice,
    };
  }
}
