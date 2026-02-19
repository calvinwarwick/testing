import { ArbitrageDetector } from "../src/arbitrage/detector";
import {
  ArbitrageOpportunity,
  ExchangePrice,
  MarketPrices,
  PolymarketMarket,
} from "../src/types";

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
    detector = new ArbitrageDetector(100);
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

  describe("directional opportunity totalCost", () => {
    it("directional opportunity has totalCost >= 1", () => {
      detector.setWindowReference(65000, Math.floor(Date.now() / 1000));
      const prices = makeMockPrices(0.55, 0.5); // YES + NO = 1.05
      const exchangePrice = makeMockExchangePrice(65325);
      const opp = detector.detectDirectionalOpportunity(prices, exchangePrice);
      expect(opp).not.toBeNull();
      expect(opp!.totalCost).toBeGreaterThanOrEqual(1.0);
    });
  });

  describe("detectEndgameOpportunity", () => {
    it("returns endgame opportunity when near-certain side is in range", () => {
      detector.setWindowReference(65000, Math.floor(Date.now() / 1000));
      // YES at 0.96 (UP side nearly certain), NO at 0.04
      const prices = makeMockPrices(0.96, 0.04, {
        yesBestAskSize: 100,
        noBestAskSize: 100,
      });
      const exchangePrice = makeMockExchangePrice(65100); // above ref -> UP
      const opp = detector.detectEndgameOpportunity(
        prices,
        exchangePrice,
        45,
        { endgameMinProbability: 0.93, endgameMaxAsk: 0.98, minAskSizeShares: 50 }
      );
      expect(opp).not.toBeNull();
      expect(opp!.opportunityType).toBe("endgame");
      expect(opp!.exchangeSignal).toBe("UP");
      expect(opp!.yesPrice).toBe(0.96);
      expect(opp!.profitPerShare).toBeGreaterThan(0);
    });

    it("returns null when target ask above endgameMaxAsk", () => {
      detector.setWindowReference(65000, Math.floor(Date.now() / 1000));
      const prices = makeMockPrices(0.99, 0.01, {
        yesBestAskSize: 100,
        noBestAskSize: 100,
      });
      const exchangePrice = makeMockExchangePrice(65100);
      const opp = detector.detectEndgameOpportunity(
        prices,
        exchangePrice,
        30,
        { endgameMinProbability: 0.93, endgameMaxAsk: 0.98, minAskSizeShares: 50 }
      );
      expect(opp).toBeNull();
    });

    it("returns null when signal is NEUTRAL", () => {
      detector.setWindowReference(65000, Math.floor(Date.now() / 1000));
      const prices = makeMockPrices(0.96, 0.04, {
        yesBestAskSize: 100,
        noBestAskSize: 100,
      });
      const exchangePrice = makeMockExchangePrice(65000); // no move
      const opp = detector.detectEndgameOpportunity(
        prices,
        exchangePrice,
        40,
        { endgameMinProbability: 0.93, endgameMaxAsk: 0.98, minAskSizeShares: 50 }
      );
      expect(opp).toBeNull();
    });
  });
});
