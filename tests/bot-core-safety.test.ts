import { PolymarketArbBot } from "../src/bot";
import type {
  ArbitrageExecution,
  ArbitrageOpportunity,
  BotConfig,
  TradeRecord,
} from "../src/types";
import * as loggerStore from "../src/utils/logger";

function makeConfig(overrides: Partial<BotConfig> = {}): BotConfig {
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
    pollIntervalMs: 250,
    dryRun: true,
    minSecondsRemainingInWindow: 0,
    ...overrides,
  };
}

function makeOpportunity(endTime: number): ArbitrageOpportunity {
  const startTime = endTime - 300;
  const detectedAt = Date.now();
  return {
    market: {
      conditionId: "cond",
      slug: `btc-updown-5m-${startTime}`,
      question: "test",
      yesTokenId: "yes-token",
      noTokenId: "no-token",
      startTime,
      endTime,
      active: true,
    },
    totalCost: 1.02,
    profitPerShare: 0.02,
    profitPercent: 2,
    yesPrice: 0.51,
    noPrice: 0.51,
    suggestedSize: 10,
    totalExpectedProfit: 0.2,
    exchangePrice: {
      exchange: "binance",
      symbol: "BTCUSDT",
      price: 70000,
      timestamp: detectedAt,
    },
    exchangeSignal: "UP",
    windowStartBtcPrice: 70000,
    detectedAt,
  };
}

function makeExecution(opp: ArbitrageOpportunity): ArbitrageExecution {
  return {
    opportunity: opp,
    yesTrade: {
      success: true,
      orderId: "trade-1",
      side: "YES",
      price: opp.yesPrice,
      size: opp.suggestedSize,
      filledSize: opp.suggestedSize,
      timestamp: Date.now(),
    },
    noTrade: {
      success: false,
      side: "NO",
      price: 0,
      size: 0,
      timestamp: Date.now(),
    },
    actualTotalCost: opp.yesPrice * opp.suggestedSize,
    actualProfit: 0,
    fullyExecuted: true,
    settled: false,
  };
}

describe("bot core safety guards", () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it("restores open state from persisted unsettled trades after restart", () => {
    const nowSec = Math.floor(Date.now() / 1000);
    const unsettled: TradeRecord = {
      id: "persist-1",
      timestamp: Date.now() - 10_000,
      marketSlug: `btc-updown-5m-${nowSec - 60}`,
      side: "UP",
      type: "directional",
      entryPrice: 0.52,
      size: 8,
      cost: 4.16,
      settled: false,
      marketWindowStart: nowSec - 60,
      marketWindowEnd: nowSec + 240,
      btcPriceAtEntry: 70000,
    };
    const settled: TradeRecord = {
      ...unsettled,
      id: "persist-2",
      settled: true,
      outcome: "win",
      profit: 1,
      marketWindowStart: nowSec - 600,
      marketWindowEnd: nowSec - 300,
    };
    jest.spyOn(loggerStore, "getTradeRecords").mockReturnValue([unsettled, settled]);
    jest
      .spyOn(loggerStore, "getUnsettledTradeRecords")
      .mockReturnValue([unsettled]);

    const bot = new PolymarketArbBot(makeConfig());
    const restoreOpenSpy = jest.spyOn(
      (bot as any).riskManager,
      "restoreOpenPositions"
    );

    (bot as any).restoreRuntimeStateFromTradeRecords();

    expect((bot as any).executions).toHaveLength(1);
    expect(restoreOpenSpy).toHaveBeenCalledWith(1);
    expect((bot as any).releasedPositionKeys.has(`${settled.marketSlug}-${settled.timestamp}`)).toBe(true);
  });

  it("skips settlement replay when persisted trade is already settled", () => {
    const nowSec = Math.floor(Date.now() / 1000);
    const opp = makeOpportunity(nowSec - 1);
    const execution = makeExecution(opp);
    const bot = new PolymarketArbBot(makeConfig());
    (bot as any).executions = [execution];

    const recordSettlementSpy = jest.spyOn((bot as any).riskManager, "recordSettlement");
    jest.spyOn(loggerStore, "getTradeRecordById").mockReturnValue({
      id: "trade-1",
      settled: true,
    } as TradeRecord);

    (bot as any).releasePositionsForEndedMarkets(70001);

    const key = `${opp.market.slug}-${opp.detectedAt}`;
    expect(recordSettlementSpy).not.toHaveBeenCalled();
    expect((bot as any).releasedPositionKeys.has(key)).toBe(true);
    expect(execution.settled).toBe(true);
  });

  it("re-checks execution window and skips trades too close to market end", async () => {
    const nowSec = Math.floor(Date.now() / 1000);
    const opp = makeOpportunity(nowSec + 2);
    const bot = new PolymarketArbBot(
      makeConfig({ dryRun: false, minSecondsRemainingInWindow: 0 })
    );

    const executeDirectional = jest.fn();
    (bot as any).trader = { executeDirectional };
    (bot as any).riskManager = {
      checkTrade: () => ({ allowed: true }),
      recordExecution: jest.fn(),
    };

    await (bot as any).handleOpportunity(opp);

    expect(executeDirectional).not.toHaveBeenCalled();
  });
});
