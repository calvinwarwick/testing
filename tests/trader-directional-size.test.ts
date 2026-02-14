import { Trader } from "../src/execution/trader";
import type { ArbitrageOpportunity, BotConfig, PolymarketMarket } from "../src/types";

jest.mock("../src/utils/logger", () => ({
  logger: {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  },
  recordTrade: jest.fn(),
}));

function makeConfig(): BotConfig {
  return {
    polymarketApiUrl: "https://clob.polymarket.com",
    polymarketGammaUrl: "https://gamma-api.polymarket.com",
    polygonPrivateKey:
      "0x0000000000000000000000000000000000000000000000000000000000000001",
    polygonRpcUrl: "https://polygon-rpc.com",
    binanceApiKey: "",
    binanceApiSecret: "",
    minProfitThresholdCents: 2,
    maxPositionSizeUsdc: 1000,
    pollIntervalMs: 1000,
    dryRun: true,
  };
}

function makeMarket(): PolymarketMarket {
  const FIVE_MIN = 300;
  const startTime = Math.floor(Date.now() / 1000 / FIVE_MIN) * FIVE_MIN;
  return {
    conditionId: "cond",
    slug: `btc-updown-5m-${startTime}`,
    question: "test",
    yesTokenId: "yes-token",
    noTokenId: "no-token",
    startTime,
    endTime: startTime + 300,
    active: true,
  };
}

function makeDirectionalOpportunity(size: number): ArbitrageOpportunity {
  return {
    market: makeMarket(),
    totalCost: 0.51,
    profitPerShare: 0.02,
    profitPercent: 4,
    yesPrice: 0.51,
    noPrice: 0.49,
    suggestedSize: size,
    totalExpectedProfit: size * 0.02,
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

describe("Trader.executeDirectional", () => {
  it("uses opportunity.suggestedSize (does not recompute from max position)", async () => {
    const trader = new Trader(makeConfig());
    const opportunity = makeDirectionalOpportunity(73);
    const execution = await trader.executeDirectional(opportunity);
    expect(execution.fullyExecuted).toBe(true);
    expect(execution.yesTrade.filledSize).toBe(73);
    expect(execution.actualTotalCost).toBeCloseTo(73 * 0.51, 6);
  });
});
