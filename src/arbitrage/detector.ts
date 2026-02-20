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

  /** Recent price samples for momentum confirmation */
  private recentPrices: { price: number; timestamp: number }[] = [];
  private static readonly MOMENTUM_WINDOW_MS = 15_000; // last 15 seconds
  private static readonly MIN_MOMENTUM_SAMPLES = 3;

  constructor(maxPositionUsdc: number) {
    this.maxPositionUsdc = maxPositionUsdc;
  }

  /**
   * Estimate Polymarket dynamic taker fee rate for 5-min crypto markets.
   * Fee = max(0, 0.0315 - |price - 0.5| * 0.063)
   * Fee is applied to net winnings only: fee_rate * (1 - entryPrice) * size
   */
  static estimateDynamicFeeRate(entryPrice: number): number {
    return Math.max(0, 0.0315 - Math.abs(entryPrice - 0.5) * 0.063);
  }

  /**
   * Set the reference price for the current 5-minute window.
   * This is the price at the start of the window — the oracle
   * will compare the end-of-window price against this.
   */
  setWindowReference(price: number, windowStart: number): void {
    this.windowReferencePrice = price;
    this.windowStartTime = windowStart;
    this.recentPrices = []; // Reset momentum history for new window
    logger.debug(
      `Window reference set: $${price.toFixed(2)} at ${new Date(windowStart * 1000).toISOString()}`
    );
  }

  /**
   * Record a price sample for momentum analysis.
   * Call every polling cycle with the latest exchange price.
   */
  recordPriceSample(price: number): void {
    const now = Date.now();
    this.recentPrices.push({ price, timestamp: now });

    const cutoff = now - ArbitrageDetector.MOMENTUM_WINDOW_MS;
    while (this.recentPrices.length > 0 && this.recentPrices[0].timestamp < cutoff) {
      this.recentPrices.shift();
    }
  }

  /**
   * Check if recent prices confirm the given direction.
   * Requires 55%+ of recent samples on the correct side of reference,
   * and the latest price further from reference than the average.
   */
  private confirmMomentum(signal: "UP" | "DOWN"): boolean {
    if (!this.windowReferencePrice) return false;
    if (this.recentPrices.length < ArbitrageDetector.MIN_MOMENTUM_SAMPLES) return true; // insufficient data, allow

    const ref = this.windowReferencePrice;
    let onSideCount = 0;

    for (const sample of this.recentPrices) {
      if (signal === "UP" && sample.price > ref) onSideCount++;
      if (signal === "DOWN" && sample.price < ref) onSideCount++;
    }

    const onSideRatio = onSideCount / this.recentPrices.length;
    if (onSideRatio < 0.55) {
      logger.debug(`Momentum rejected: ${signal} signal but only ${(onSideRatio * 100).toFixed(0)}% of recent prices confirm`);
      return false;
    }

    // Check trend: last price should be further from ref than the average
    const lastPrice = this.recentPrices[this.recentPrices.length - 1].price;
    const avgPrice = this.recentPrices.reduce((s, p) => s + p.price, 0) / this.recentPrices.length;

    if (signal === "UP" && lastPrice < avgPrice) {
      logger.debug(`Momentum rejected: UP signal but price declining (last=${lastPrice.toFixed(2)}, avg=${avgPrice.toFixed(2)})`);
      return false;
    }
    if (signal === "DOWN" && lastPrice > avgPrice) {
      logger.debug(`Momentum rejected: DOWN signal but price rising (last=${lastPrice.toFixed(2)}, avg=${avgPrice.toFixed(2)})`);
      return false;
    }

    return true;
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
   * Optimized for win rate with time-based probability adjustments.
   */
  detectDirectionalOpportunity(
    marketPrices: MarketPrices,
    exchangePrice: ExchangePrice,
    minEdgePercent: number = 10,
    signalThresholdPercent: number = 0.03,
    minExchangeMovePercent: number = 0.05,
    secondsRemaining?: number,
    minWinProbability: number = 0.55,
    minAskSizeShares: number = 50
  ): ArbitrageOpportunity | null {
    const signal = this.getExchangeSignal(exchangePrice.price, signalThresholdPercent);
    if (signal === "NEUTRAL") return null;

    // Confirm momentum before proceeding
    if (!this.confirmMomentum(signal)) return null;

    // If exchange says UP, the YES token should be more expensive
    // If exchange says DOWN, the NO token should be more expensive
    // We look for cases where Polymarket hasn't caught up

    const targetToken = signal === "UP" ? "YES" : "NO";
    const targetAsk =
      signal === "UP" ? marketPrices.yesBestAsk : marketPrices.noBestAsk;

    // Verify sufficient liquidity at best ask
    const targetAskSize = signal === "UP" ? marketPrices.yesBestAskSize : marketPrices.noBestAskSize;
    if (targetAskSize != null && targetAskSize < minAskSizeShares) {
      logger.debug(`Skipping: insufficient liquidity at best ask (${targetAskSize} < ${minAskSizeShares} shares)`);
      return null;
    }

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

    // Map exchange move magnitude to base probability (conservative estimate)
    // Larger moves are more likely to hold, but account for mean reversion
    // A 0.1% move suggests ~52% probability; 0.5% move suggests ~65%
    // More conservative than before to improve win rate
    let baseProbability = Math.min(0.75, 0.48 + pctMove * 0.35);
    
    // Time-based adjustment: optimize for win rate based on time remaining
    // Wider sweet spot and softer edge penalty for more aggressive entry
    if (secondsRemaining != null) {
      const windowDuration = 300; // 5 minutes
      const timeRatio = secondsRemaining / windowDuration;
      
      // Softer penalty for entries too early (> 240s) or too late (< 30s)
      if (timeRatio > 0.8 || timeRatio < 0.1) {
        baseProbability *= 0.88;
      } else if (timeRatio >= 0.15 && timeRatio <= 0.85) {
        // Sweet spot (45-255s) - slight boost
        baseProbability *= 1.03;
        baseProbability = Math.min(0.78, baseProbability);
      }
      
      // Additional boost for optimal timing (90-180s remaining)
      if (secondsRemaining >= 60 && secondsRemaining <= 180) {
        const optimalBoost = 1.0 + (180 - Math.abs(secondsRemaining - 135)) / 180 * 0.08; // Peak at 135s
        baseProbability *= optimalBoost;
        baseProbability = Math.min(0.78, baseProbability);
      }
    }
    
    const estimatedFairPrice = baseProbability;

    // Require minimum win probability threshold
    if (estimatedFairPrice < minWinProbability) {
      logger.debug(`Skipping: win probability ${(estimatedFairPrice * 100).toFixed(1)}% below minimum ${(minWinProbability * 100).toFixed(1)}%`);
      return null;
    }

    // Account for Polymarket dynamic taker fee on 5-min crypto markets
    // Fee is charged on net winnings only: fee_rate * (1 - entryPrice)
    const feeRate = ArbitrageDetector.estimateDynamicFeeRate(targetAsk);
    const feePerShareIfWin = feeRate * (1 - targetAsk);

    // Post-fee edge: expected profit per share minus fee drag
    const postFeeEdge = estimatedFairPrice - targetAsk - estimatedFairPrice * feePerShareIfWin;
    const edgePercent = (postFeeEdge / targetAsk) * 100;

    // Require higher edge for lower probability trades (risk-adjusted edge)
    // Lower probability = need more edge to compensate
    const probabilityAdjustedMinEdge = minEdgePercent * (minWinProbability / estimatedFairPrice);
    if (edgePercent < probabilityAdjustedMinEdge) {
      logger.debug(`Skipping: edge ${edgePercent.toFixed(1)}% below adjusted minimum ${probabilityAdjustedMinEdge.toFixed(1)}% (prob ${(estimatedFairPrice * 100).toFixed(1)}%, fee ${(feeRate * 100).toFixed(2)}%)`);
      return null;
    }

    // Kelly Criterion with fees: f* = (p * netPayoff - (1-p) * cost) / netPayoff
    // where netPayoff = (1 - entryPrice) - feePerShareIfWin
    const netPayoffIfWin = (1 - targetAsk) - feePerShareIfWin;
    const kellyFraction = netPayoffIfWin > 0
      ? Math.max(0, (estimatedFairPrice * netPayoffIfWin - (1 - estimatedFairPrice) * targetAsk) / netPayoffIfWin)
      : 0;

    const otherAsk =
      signal === "UP" ? marketPrices.noBestAsk : marketPrices.yesBestAsk;
    const totalCost = targetAsk + otherAsk;

    const direction = signal === "UP" ? "UP" : "DOWN";
    logger.debug(
      `Detection detail: Fair=$${estimatedFairPrice.toFixed(3)} | Kelly: ${(kellyFraction * 100).toFixed(1)}% | Exchange move: ${pctMove.toFixed(3)}% | Fee: ${(feeRate * 100).toFixed(2)}%`
    );

    // suggestedSize is a max-position fallback; actual sizing uses Kelly in demo-capital
    const suggestedSize = Math.max(
      1,
      Math.floor(this.maxPositionUsdc / totalCost)
    );

    return {
      market: marketPrices.market,
      totalCost,
      profitPerShare: postFeeEdge,
      profitPercent: edgePercent,
      yesPrice: marketPrices.yesBestAsk,
      noPrice: marketPrices.noBestAsk,
      suggestedSize,
      totalExpectedProfit: postFeeEdge * suggestedSize,
      exchangePrice,
      exchangeSignal: signal,
      windowStartBtcPrice: this.windowReferencePrice ?? undefined,
      detectedAt: Date.now(),
      kellyFraction,
      estimatedWinProbability: estimatedFairPrice,
      estimatedFeePercent: feeRate * 100,
    };
  }

  /**
   * Detect endgame arb: buy the near-certain side (95–99¢) close to resolution.
   * Call only when secondsRemaining is within [endgameMinSecondsRemaining, endgameMaxSecondsRemaining].
   * Window reference must be set (setWindowReference) for the current market.
   * Do not log at info level here — would spam every poll. Bot logs once when opening (handleOpportunity).
   */
  detectEndgameOpportunity(
    marketPrices: MarketPrices,
    exchangePrice: ExchangePrice,
    secondsRemaining: number,
    opts: {
      endgameMinProbability: number;
      endgameMaxAsk: number;
      minAskSizeShares: number;
    }
  ): ArbitrageOpportunity | null {
    const signal = this.getExchangeSignal(exchangePrice.price, 0.02);
    if (signal === "NEUTRAL") return null;
    if (!this.windowReferencePrice) return null;

    const targetToken = signal === "UP" ? "YES" : "NO";
    const targetAsk =
      signal === "UP" ? marketPrices.yesBestAsk : marketPrices.noBestAsk;
    const targetAskSize =
      signal === "UP" ? marketPrices.yesBestAskSize : marketPrices.noBestAskSize;

    if (
      targetAskSize != null &&
      targetAskSize < opts.minAskSizeShares
    ) {
      logger.debug(
        `Endgame skip: insufficient liquidity (${targetAskSize} < ${opts.minAskSizeShares})`
      );
      return null;
    }

    if (targetAsk < opts.endgameMinProbability) {
      logger.debug(
        `Endgame skip: target ask $${targetAsk.toFixed(2)} below min probability $${opts.endgameMinProbability}`
      );
      return null;
    }
    if (targetAsk > opts.endgameMaxAsk) {
      logger.debug(
        `Endgame skip: target ask $${targetAsk.toFixed(2)} above max $${opts.endgameMaxAsk} (no edge)`
      );
      return null;
    }

    const otherAsk =
      signal === "UP" ? marketPrices.noBestAsk : marketPrices.yesBestAsk;
    const totalCost = targetAsk + otherAsk;
    const feeRate = ArbitrageDetector.estimateDynamicFeeRate(targetAsk);
    const feePerShareIfWin = feeRate * (1 - targetAsk);
    const profitPerShare = 1 - targetAsk - feePerShareIfWin;
    const profitPercent = (profitPerShare / targetAsk) * 100;
    const estimatedWinProbability = Math.min(0.99, targetAsk + 0.01);
    const netPayoffIfWin = 1 - targetAsk - feePerShareIfWin;
    const kellyFraction =
      netPayoffIfWin > 0
        ? Math.max(
            0,
            (estimatedWinProbability * netPayoffIfWin -
              (1 - estimatedWinProbability) * targetAsk) /
              netPayoffIfWin
          )
        : 0;

    const suggestedSize = Math.max(
      1,
      Math.floor(this.maxPositionUsdc / totalCost)
    );

    return {
      market: marketPrices.market,
      totalCost,
      profitPerShare,
      profitPercent,
      yesPrice: marketPrices.yesBestAsk,
      noPrice: marketPrices.noBestAsk,
      suggestedSize,
      totalExpectedProfit: profitPerShare * suggestedSize,
      exchangePrice,
      exchangeSignal: signal,
      windowStartBtcPrice: this.windowReferencePrice ?? undefined,
      detectedAt: Date.now(),
      opportunityType: "endgame",
      kellyFraction,
      estimatedWinProbability,
      estimatedFeePercent: feeRate * 100,
    };
  }
}
