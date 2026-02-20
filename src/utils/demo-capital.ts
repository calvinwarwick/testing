import type { ArbitrageExecution, TradeRecord } from "../types";

export interface DemoCapitalDecision {
  allowed: boolean;
  finalSuggestedSize?: number;
  attemptedNotionalUsd: number;
  maxAllowedNotionalUsd: number;
  currentBalanceUsd: number;
  reservedCapitalUsd: number;
  availableBalanceUsd: number;
  reason?: string;
}

export function calculateReservedCapital(
  executions: ArbitrageExecution[],
  releasedKeys: Set<string>,
  persistedTrades: TradeRecord[] = [],
  inMemoryTradeIds: Set<string> = new Set()
): number {
  const fromExecutions = executions
    .filter((e) => {
      if (!e.fullyExecuted) return false;
      if (e.pendingSettlement === true) return false; // Don't reserve capital while waiting for Polymarket settlement
      const key = `${e.opportunity.market.slug}-${e.opportunity.detectedAt}`;
      return !releasedKeys.has(key);
    })
    .reduce((sum, e) => sum + e.actualTotalCost, 0);
  const nowSec = Math.floor(Date.now() / 1000);
  const fromPersisted = persistedTrades
    .filter(
      (t) =>
        t.type === "directional" &&
        !t.settled &&
        t.marketWindowEnd > nowSec &&
        !inMemoryTradeIds.has(t.id)
    )
    .reduce((sum, t) => sum + (Number.isFinite(t.cost) ? t.cost : 0), 0);
  return fromExecutions + fromPersisted;
}

export function decideDemoCapitalSizing(input: {
  startingBalanceUsd: number;
  lifetimeProfitUsd: number;
  reservedCapitalUsd: number;
  totalCostPerShareUsd: number;
  suggestedSize: number;
  maxPerTradeFraction?: number;
  /** Raw Kelly fraction from detector (0..1). When provided with kellyMultiplier, replaces flat maxPerTradeFraction. */
  kellyFraction?: number;
  /** Fractional Kelly multiplier (e.g. 0.25 = quarter-Kelly). Default 0.25. */
  kellyMultiplier?: number;
}): DemoCapitalDecision {
  const hardCapFraction = input.maxPerTradeFraction ?? 0.15;
  const currentBalanceUsd = Math.max(
    0,
    input.startingBalanceUsd + input.lifetimeProfitUsd
  );
  const availableBalanceUsd = Math.max(
    0,
    currentBalanceUsd - input.reservedCapitalUsd
  );
  const attemptedNotionalUsd = input.totalCostPerShareUsd * input.suggestedSize;

  if (availableBalanceUsd < input.totalCostPerShareUsd) {
    return {
      allowed: false,
      attemptedNotionalUsd,
      maxAllowedNotionalUsd: 0,
      currentBalanceUsd,
      reservedCapitalUsd: input.reservedCapitalUsd,
      availableBalanceUsd,
      reason: "insufficient_available_cash",
    };
  }

  // Kelly-based sizing: use fractional Kelly when available, otherwise fall back to hard cap
  const kellyMultiplier = input.kellyMultiplier ?? 0.25;
  const effectiveFraction =
    input.kellyFraction != null && input.kellyFraction > 0
      ? Math.min(input.kellyFraction * kellyMultiplier, hardCapFraction)
      : hardCapFraction;

  const maxAllowedNotionalUsd = Math.min(
    currentBalanceUsd * effectiveFraction,
    availableBalanceUsd
  );
  const finalSuggestedSize = Math.max(
    1,
    Math.floor(maxAllowedNotionalUsd / input.totalCostPerShareUsd)
  );
  if (finalSuggestedSize < 1) {
    return {
      allowed: false,
      attemptedNotionalUsd,
      maxAllowedNotionalUsd,
      currentBalanceUsd,
      reservedCapitalUsd: input.reservedCapitalUsd,
      availableBalanceUsd,
      reason: "size_below_one_share",
    };
  }

  return {
    allowed: true,
    finalSuggestedSize,
    attemptedNotionalUsd,
    maxAllowedNotionalUsd,
    currentBalanceUsd,
    reservedCapitalUsd: input.reservedCapitalUsd,
    availableBalanceUsd,
  };
}
