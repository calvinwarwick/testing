import { PolymarketFeed } from "../src/feeds/polymarket-feed";
import { PolymarketMarket } from "../src/types";

function makeMarket(): PolymarketMarket {
  const nowSec = Math.floor(Date.now() / 1000);
  return {
    conditionId: "cond-1",
    slug: "btc-updown-5m-test",
    question: "Will BTC be up in 5 minutes?",
    yesTokenId: "yes-token",
    noTokenId: "no-token",
    startTime: nowSec,
    endTime: nowSec + 300,
    active: true,
  };
}

describe("PolymarketFeed mode controls", () => {
  const originalSimulateMarkets = process.env.SIMULATE_MARKETS;

  afterEach(() => {
    if (originalSimulateMarkets === undefined) {
      delete process.env.SIMULATE_MARKETS;
    } else {
      process.env.SIMULATE_MARKETS = originalSimulateMarkets;
    }
    jest.restoreAllMocks();
  });

  it("keeps live mode when FORCE_REAL_DATA is true and no markets are found", async () => {
    delete process.env.SIMULATE_MARKETS;
    const feed = new PolymarketFeed("https://gamma", "https://clob", undefined, true);
    (feed as unknown as { findBtc5MinMarketsBySlugs: () => Promise<PolymarketMarket[]> })
      .findBtc5MinMarketsBySlugs = async () => [];
    (feed as unknown as { findBtc5MinMarketsLegacy: () => Promise<PolymarketMarket[]> })
      .findBtc5MinMarketsLegacy = async () => [];

    const markets = await feed.findActiveCryptoMarkets("BTC");

    expect(markets).toEqual([]);
    expect(feed.isSimulating()).toBe(false);
    expect(feed.getDataMode()).toBe("live");
    expect(feed.getModeReason()).toBe("force_real_data_no_markets");
  });

  it("falls back to simulation when FORCE_REAL_DATA is false and no markets are found", async () => {
    delete process.env.SIMULATE_MARKETS;
    const feed = new PolymarketFeed("https://gamma", "https://clob");
    (feed as unknown as { findBtc5MinMarketsBySlugs: () => Promise<PolymarketMarket[]> })
      .findBtc5MinMarketsBySlugs = async () => [];
    (feed as unknown as { findBtc5MinMarketsLegacy: () => Promise<PolymarketMarket[]> })
      .findBtc5MinMarketsLegacy = async () => [];

    const markets = await feed.findActiveCryptoMarkets("BTC");

    expect(markets.length).toBeGreaterThan(0);
    expect(feed.isSimulating()).toBe(true);
    expect(feed.getDataMode()).toBe("simulation");
    expect(feed.getModeReason()).toBe("no_live_markets_found");
  });

  it("does not auto-switch to simulation after order-book failures when FORCE_REAL_DATA is true", async () => {
    delete process.env.SIMULATE_MARKETS;
    const feed = new PolymarketFeed("https://gamma", "https://clob", undefined, true);
    const market = makeMarket();
    jest
      .spyOn(feed, "getOrderBook")
      .mockResolvedValue(null);

    for (let i = 0; i < 6; i++) {
      // eslint-disable-next-line no-await-in-loop
      const prices = await feed.getMarketPrices(market, 70000, 69900);
      expect(prices).toBeNull();
    }

    expect(feed.isSimulating()).toBe(false);
    expect(feed.getDataMode()).toBe("live");
  });
});
