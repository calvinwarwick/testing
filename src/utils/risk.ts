import { ArbitrageOpportunity, ArbitrageExecution } from "../types";
import { logger } from "./logger";

/**
 * Risk management for the directional bot.
 *
 * Enforces position limits and prevents runaway trading in case of data feed issues.
 */
export class RiskManager {
  private readonly maxPositionUsdc: number;
  private readonly maxOpenPositions: number;
  private readonly maxTradesPerMinute: number;
  private readonly minTimeBetweenTradesMs: number;

  private dailyPnL: number = 0;
  private openPositions: number = 0;
  private recentTrades: number[] = []; // timestamps
  private lastTradeTime: number = 0;
  private dailyResetTime: number = 0;

  constructor(options: {
    maxPositionUsdc: number;
    maxOpenPositions?: number;
    maxTradesPerMinute?: number;
    minTimeBetweenTradesMs?: number;
  }) {
    this.maxPositionUsdc = options.maxPositionUsdc;
    this.maxOpenPositions = Math.max(1, options.maxOpenPositions ?? 3);
    this.maxTradesPerMinute = options.maxTradesPerMinute ?? 50;
    this.minTimeBetweenTradesMs = options.minTimeBetweenTradesMs ?? 2000;
    this.resetDaily();
  }

  /**
   * Restore risk state from persisted session (e.g. after restart).
   */
  restoreState(state: { dailyPnL: number; dailyResetTime: number }): void {
    this.dailyPnL = state.dailyPnL;
    this.dailyResetTime = state.dailyResetTime;
  }

  /**
   * Restore open position count after replaying persisted unsettled trades.
   */
  restoreOpenPositions(count: number): void {
    this.openPositions = Math.max(0, Math.floor(count));
  }

  /**
   * Check if a trade is allowed by risk limits.
   * Returns { allowed: true } or { allowed: false, reason: string }.
   */
  checkTrade(opportunity: ArbitrageOpportunity): {
    allowed: boolean;
    reason?: string;
  } {
    this.maybeResetDaily();
    const now = Date.now();

    // Check open positions
    if (this.openPositions >= this.maxOpenPositions) {
      return {
        allowed: false,
        reason: `Max open positions reached: ${this.openPositions}/${this.maxOpenPositions}`,
      };
    }

    // Check position size
    const tradeSize = opportunity.totalCost * opportunity.suggestedSize;
    if (tradeSize > this.maxPositionUsdc) {
      return {
        allowed: false,
        reason: `Trade size $${tradeSize.toFixed(2)} exceeds max $${this.maxPositionUsdc}`,
      };
    }

    // Check minimum spacing between trades
    if (
      this.lastTradeTime > 0 &&
      now - this.lastTradeTime < this.minTimeBetweenTradesMs
    ) {
      const waitMs = this.minTimeBetweenTradesMs - (now - this.lastTradeTime);
      return {
        allowed: false,
        reason: `Min time between trades not met: wait ${waitMs}ms`,
      };
    }

    // Check trades per minute
    const oneMinuteAgo = now - 60000;
    this.recentTrades = this.recentTrades.filter((t) => t > oneMinuteAgo);
    if (this.recentTrades.length >= this.maxTradesPerMinute) {
      return {
        allowed: false,
        reason: `Rate limit: ${this.recentTrades.length}/${this.maxTradesPerMinute} trades/min`,
      };
    }

    return { allowed: true };
  }

  /**
   * Record a completed trade execution.
   */
  recordExecution(execution: ArbitrageExecution): void {
    const now = Date.now();
    this.lastTradeTime = now;
    this.recentTrades.push(now);

    if (execution.fullyExecuted) {
      this.openPositions++;
      logger.debug(`Risk: open positions ${this.openPositions}`);
    }
  }

  /**
   * Record when a position resolves (market settles).
   */
  recordSettlement(profit: number): void {
    this.dailyPnL += profit;
    this.openPositions = Math.max(0, this.openPositions - 1);
    logger.info(`Settlement: $${profit.toFixed(2)} | Daily PnL $${this.dailyPnL.toFixed(2)} | Open ${this.openPositions}`);
  }

  /**
   * Release one open position when its market window has ended (without recording PnL).
   * Use when we don't have settlement data but the 5-min window is past.
   */
  releasePosition(): void {
    if (this.openPositions > 0) {
      this.openPositions--;
      logger.debug(`Risk: position released, open ${this.openPositions}`);
    }
  }

  /**
   * Get current risk state for monitoring and persistence.
   */
  getState(): {
    dailyPnL: number;
    dailyResetTime: number;
    openPositions: number;
    tradesLastMinute: number;
  } {
    const oneMinuteAgo = Date.now() - 60000;
    this.recentTrades = this.recentTrades.filter((t) => t > oneMinuteAgo);
    return {
      dailyPnL: this.dailyPnL,
      dailyResetTime: this.dailyResetTime,
      openPositions: this.openPositions,
      tradesLastMinute: this.recentTrades.length,
    };
  }

  private resetDaily(): void {
    this.dailyPnL = 0;
    this.openPositions = 0;
    this.recentTrades = [];
    this.dailyResetTime = this.getNextMidnightUtc();
  }

  private maybeResetDaily(): void {
    if (Date.now() > this.dailyResetTime) {
      logger.debug(`Daily risk reset, previous PnL $${this.dailyPnL.toFixed(2)}`);
      this.resetDaily();
    }
  }

  private getNextMidnightUtc(): number {
    const now = new Date();
    const tomorrow = new Date(
      Date.UTC(
        now.getUTCFullYear(),
        now.getUTCMonth(),
        now.getUTCDate() + 1,
        0,
        0,
        0
      )
    );
    return tomorrow.getTime();
  }
}
