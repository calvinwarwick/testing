import {
  calculateReservedCapital,
  decideDemoCapitalSizing,
} from "../src/utils/demo-capital";
import type {
  ArbitrageExecution,
  ArbitrageOpportunity,
  PolymarketMarket,
  TradeRecord,
} from "../src/types";

function makeMarket(slug: string): PolymarketMarket {
  const start = Math.floor(Date.now() / 1000);
  return {
    conditionId: `cond-${slug}`,
    slug,
    question: "test",
    yesTokenId: "yes",
    noTokenId: "no",
    startTime: start,
    endTime: start + 300,
    active: true,
  };
}

function makeOpp(slug: string): ArbitrageOpportunity {
  return {
    market: makeMarket(slug),
    totalCost: 0.5,
    profitPerShare: 0.02,
    profitPercent: 4,
    yesPrice: 0.5,
    noPrice: 0.5,
    suggestedSize: 2000,
    totalExpectedProfit: 40,
    exchangePrice: {
      exchange: "binance",
      symbol: "BTCUSDT",
      price: 70000,
      timestamp: Date.now(),
    },
    exchangeSignal: "UP",
    detectedAt: Date.now(),
  };
}

function makeExecution(slug: string, detectedAt: number, cost: number): ArbitrageExecution {
  const opp = {
    ...makeOpp(slug),
    detectedAt,
  };
  return {
    opportunity: opp,
    yesTrade: {
      success: true,
      side: "YES",
      price: 0.5,
      size: 1,
      filledSize: 1,
      timestamp: Date.now(),
    },
    noTrade: {
      success: false,
      side: "NO",
      price: 0,
      size: 0,
      timestamp: Date.now(),
    },
    actualTotalCost: cost,
    actualProfit: 0,
    fullyExecuted: true,
  };
}

describe("demo capital controls", () => {
  it("caps to 5% of current balance", () => {
    const d = decideDemoCapitalSizing({
      startingBalanceUsd: 1000,
      lifetimeProfitUsd: 0,
      reservedCapitalUsd: 0,
      totalCostPerShareUsd: 0.5,
      suggestedSize: 2000, // attempted $1000
    });
    expect(d.allowed).toBe(true);
    expect(d.finalSuggestedSize).toBe(100); // $50 notional cap
    expect(d.maxAllowedNotionalUsd).toBe(50);
  });

  it("blocks new trades when free cash cannot buy one share", () => {
    const d = decideDemoCapitalSizing({
      startingBalanceUsd: 1000,
      lifetimeProfitUsd: 0,
      reservedCapitalUsd: 999.8,
      totalCostPerShareUsd: 0.5,
      suggestedSize: 10,
    });
    expect(d.allowed).toBe(false);
    expect(d.reason).toBe("insufficient_available_cash");
  });

  it("tracks reserved capital only for unreleased executions", () => {
    const e1 = makeExecution("btc-updown-5m-1", 1, 50);
    const e2 = makeExecution("btc-updown-5m-2", 2, 40);
    const released = new Set<string>(["btc-updown-5m-1-1"]);
    const reserved = calculateReservedCapital([e1, e2], released);
    expect(reserved).toBe(40);
  });

  it("includes persisted unsettled notional not present in memory", () => {
    const persisted: TradeRecord[] = [
      {
        id: "persisted-1",
        timestamp: Date.now(),
        marketSlug: "btc-updown-5m-1",
        side: "UP",
        type: "directional",
        entryPrice: 0.51,
        size: 20,
        cost: 10.2,
        settled: false,
        marketWindowStart: Math.floor(Date.now() / 1000),
        marketWindowEnd: Math.floor(Date.now() / 1000) + 300,
        btcPriceAtEntry: 70000,
      },
    ];
    const reserved = calculateReservedCapital([], new Set(), persisted, new Set());
    expect(reserved).toBeCloseTo(10.2, 6);
  });
});
