import { RiskManager } from "../src/utils/risk";
import {
  ArbitrageOpportunity,
  ArbitrageExecution,
  PolymarketMarket,
} from "../src/types";

function makeMockMarket(): PolymarketMarket {
  return {
    conditionId: "0xabc",
    slug: "btc-test",
    question: "Test market",
    yesTokenId: "yes-token",
    noTokenId: "no-token",
    startTime: Math.floor(Date.now() / 1000),
    endTime: Math.floor(Date.now() / 1000) + 300,
    active: true,
  };
}

function makeMockOpportunity(
  overrides?: Partial<ArbitrageOpportunity>
): ArbitrageOpportunity {
  return {
    market: makeMockMarket(),
    totalCost: 0.96,
    profitPerShare: 0.04,
    profitPercent: 4.17,
    yesPrice: 0.48,
    noPrice: 0.48,
    suggestedSize: 50,
    totalExpectedProfit: 2.0,
    exchangePrice: {
      exchange: "binance",
      symbol: "BTCUSDT",
      price: 65000,
      timestamp: Date.now(),
    },
    exchangeSignal: "NEUTRAL",
    detectedAt: Date.now(),
    ...overrides,
  };
}

function makeMockExecution(
  overrides?: Partial<ArbitrageExecution>
): ArbitrageExecution {
  return {
    opportunity: makeMockOpportunity(),
    yesTrade: {
      success: true,
      orderId: "yes-order-1",
      side: "YES",
      price: 0.48,
      size: 50,
      filledSize: 50,
      timestamp: Date.now(),
    },
    noTrade: {
      success: true,
      orderId: "no-order-1",
      side: "NO",
      price: 0.48,
      size: 50,
      filledSize: 50,
      timestamp: Date.now(),
    },
    actualTotalCost: 48.0,
    actualProfit: 2.0,
    fullyExecuted: true,
    ...overrides,
  };
}

describe("RiskManager", () => {
  let risk: RiskManager;

  beforeEach(() => {
    risk = new RiskManager({
      maxPositionUsdc: 100,
      maxOpenPositions: 3,
      maxTradesPerMinute: 5,
      minTimeBetweenTradesMs: 100,
    });
  });

  describe("checkTrade", () => {
    it("should allow a valid trade", () => {
      const opp = makeMockOpportunity();
      const result = risk.checkTrade(opp);
      expect(result.allowed).toBe(true);
    });

    it("should block trades when max open positions reached", () => {
      // Fill up positions
      risk.recordExecution(makeMockExecution());
      risk.recordExecution(makeMockExecution());
      risk.recordExecution(makeMockExecution());

      const result = risk.checkTrade(makeMockOpportunity());
      expect(result.allowed).toBe(false);
      expect(result.reason).toContain("open positions");
    });

    it("should allow high profit percent (directional)", () => {
      const opp = makeMockOpportunity({ profitPercent: 60, totalCost: 1.05 });
      const result = risk.checkTrade(opp);
      expect(result.allowed).toBe(true);
    });

    it("should block trades exceeding position size", () => {
      // totalCost * suggestedSize = 0.96 * 200 = $192 > $100 max
      const opp = makeMockOpportunity({ suggestedSize: 200 });
      const result = risk.checkTrade(opp);
      expect(result.allowed).toBe(false);
      expect(result.reason).toContain("Trade size");
    });

    it("should enforce minimum time between trades", () => {
      risk.recordExecution(makeMockExecution());
      const result = risk.checkTrade(makeMockOpportunity());
      expect(result.allowed).toBe(false);
      expect(result.reason).toContain("Min time between trades");
    });
  });

  describe("recordSettlement", () => {
    it("should track daily PnL from settlements", () => {
      risk.recordExecution(makeMockExecution());
      risk.recordSettlement(2.0);

      const state = risk.getState();
      expect(state.dailyPnL).toBe(2.0);
      expect(state.openPositions).toBe(0);
    });

    it("should decrement open positions on settlement", () => {
      risk.recordExecution(makeMockExecution());
      risk.recordExecution(makeMockExecution());

      expect(risk.getState().openPositions).toBe(2);

      risk.recordSettlement(1.0);

      expect(risk.getState().openPositions).toBe(1);
    });
  });

  describe("getState", () => {
    it("should return current risk state", () => {
      const state = risk.getState();
      expect(state.dailyPnL).toBe(0);
      expect(state.openPositions).toBe(0);
      expect(state.tradesLastMinute).toBe(0);
    });
  });
});
