import { ArbitrageDetector } from "../src/arbitrage/detector";
import { ExchangePrice, MarketPrices, PolymarketMarket } from "../src/types";

function makeMockMarket(overrides?: Partial<PolymarketMarket>): PolymarketMarket {
  return {
    conditionId: "0xabc123",
    slug: "btc-updown-5m-test",
    question: "Will BTC go up in the next 5 minutes?",
    yesTokenId: "token-yes-123",
    noTokenId: "token-no-456",
    startTime: Math.floor(Date.now() / 1000),
    endTime: Math.floor(Date.now() / 1000) + 300,
    active: true,
    ...overrides,
  };
}

function makeMockPrices(
  yesAsk: number,
  noAsk: number,
  overrides?: Partial<MarketPrices>
): MarketPrices {
  return {
    market: makeMockMarket(),
    yesBestAsk: yesAsk,
    noBestAsk: noAsk,
    yesBestBid: yesAsk - 0.01,
    noBestBid: noAsk - 0.01,
    yesMid: yesAsk - 0.005,
    noMid: noAsk - 0.005,
    timestamp: Date.now(),
    ...overrides,
  };
}

function makeMockExchangePrice(price: number = 65000): ExchangePrice {
  return {
    exchange: "binance",
    symbol: "BTCUSDT",
    price,
    timestamp: Date.now(),
  };
}

describe("ArbitrageDetector", () => {
  let detector: ArbitrageDetector;

  beforeEach(() => {
    // Min profit = 2 cents, max position = $100
    detector = new ArbitrageDetector(2, 100);
  });

  describe("detectArbitrage", () => {
    it("should detect arbitrage when YES + NO < $1.00", () => {
      // YES at $0.48 + NO at $0.48 = $0.96 total -> 4 cent profit
      const prices = makeMockPrices(0.48, 0.48);
      const exchangePrice = makeMockExchangePrice();

      const opp = detector.detectArbitrage(prices, exchangePrice);

      expect(opp).not.toBeNull();
      expect(opp!.totalCost).toBeCloseTo(0.96);
      expect(opp!.profitPerShare).toBeCloseTo(0.04);
      expect(opp!.profitPercent).toBeCloseTo(4.167, 1);
    });

    it("should return null when YES + NO >= $1.00 (no arb)", () => {
      // YES at $0.55 + NO at $0.46 = $1.01 total -> no profit
      const prices = makeMockPrices(0.55, 0.46);
      const exchangePrice = makeMockExchangePrice();

      const opp = detector.detectArbitrage(prices, exchangePrice);

      expect(opp).toBeNull();
    });

    it("should return null when profit is below threshold", () => {
      // YES at $0.495 + NO at $0.495 = $0.99 -> 1 cent profit (below 2c threshold)
      const prices = makeMockPrices(0.495, 0.495);
      const exchangePrice = makeMockExchangePrice();

      const opp = detector.detectArbitrage(prices, exchangePrice);

      expect(opp).toBeNull();
    });

    it("should detect arb when both sides are cheap (market maker gap)", () => {
      // YES at $0.40 + NO at $0.40 = $0.80 -> 20 cent profit per share
      const prices = makeMockPrices(0.4, 0.4);
      const exchangePrice = makeMockExchangePrice();

      const opp = detector.detectArbitrage(prices, exchangePrice);

      expect(opp).not.toBeNull();
      expect(opp!.profitPerShare).toBeCloseTo(0.2);
    });

    it("should calculate suggested size based on max position", () => {
      // Cost per pair = $0.96, max position = $100 -> 104 pairs
      const prices = makeMockPrices(0.48, 0.48);
      const exchangePrice = makeMockExchangePrice();

      const opp = detector.detectArbitrage(prices, exchangePrice);

      expect(opp).not.toBeNull();
      expect(opp!.suggestedSize).toBe(104); // floor(100 / 0.96)
    });

    it("should include exchange price and signal in opportunity", () => {
      const prices = makeMockPrices(0.48, 0.48);
      const exchangePrice = makeMockExchangePrice(65000);

      const opp = detector.detectArbitrage(prices, exchangePrice);

      expect(opp).not.toBeNull();
      expect(opp!.exchangePrice.price).toBe(65000);
      expect(opp!.exchangeSignal).toBeDefined();
    });

    it("should handle edge case of exactly $1.00 total", () => {
      const prices = makeMockPrices(0.5, 0.5);
      const exchangePrice = makeMockExchangePrice();

      const opp = detector.detectArbitrage(prices, exchangePrice);

      // Exactly $1.00 = 0 profit, should be rejected
      expect(opp).toBeNull();
    });
  });

  describe("getExchangeSignal", () => {
    it("should return UP when exchange price is above reference", () => {
      detector.setWindowReference(65000, Math.floor(Date.now() / 1000));

      const signal = detector.getExchangeSignal(65020); // +0.03%
      expect(signal).toBe("UP");
    });

    it("should return DOWN when exchange price is below reference", () => {
      detector.setWindowReference(65000, Math.floor(Date.now() / 1000));

      const signal = detector.getExchangeSignal(64980); // -0.03%
      expect(signal).toBe("DOWN");
    });

    it("should return NEUTRAL when price is within threshold", () => {
      detector.setWindowReference(65000, Math.floor(Date.now() / 1000));

      const signal = detector.getExchangeSignal(65005); // +0.008% (below 0.02% threshold)
      expect(signal).toBe("NEUTRAL");
    });

    it("should return NEUTRAL when no reference is set", () => {
      const signal = detector.getExchangeSignal(65000);
      expect(signal).toBe("NEUTRAL");
    });
  });

  describe("detectDirectionalOpportunity", () => {
    it("should detect when exchange moves up but Polymarket is stale", () => {
      detector.setWindowReference(65000, Math.floor(Date.now() / 1000));

      const prices = makeMockPrices(0.5, 0.5);
      // BTC jumped 0.5% on exchange
      const exchangePrice = makeMockExchangePrice(65325);

      const opp = detector.detectDirectionalOpportunity(prices, exchangePrice);

      // Should detect that YES is underpriced given the exchange move
      expect(opp).not.toBeNull();
      if (opp) {
        expect(opp.exchangeSignal).toBe("UP");
      }
    });

    it("should return null for small exchange movements", () => {
      detector.setWindowReference(65000, Math.floor(Date.now() / 1000));

      const prices = makeMockPrices(0.5, 0.5);
      // Only 0.01% move - not enough signal
      const exchangePrice = makeMockExchangePrice(65006.5);

      const opp = detector.detectDirectionalOpportunity(prices, exchangePrice);

      expect(opp).toBeNull();
    });
  });
});
