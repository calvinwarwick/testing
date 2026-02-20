#!/usr/bin/env node
/**
 * Quick test script to verify trading authentication works.
 * Places a small test order (1 share) on an active BTC market.
 */

import { loadConfig } from "./src/config";
import { Trader } from "./src/execution/trader";
import { PolymarketFeed } from "./src/feeds/polymarket-feed";
import { ExchangeFeed } from "./src/feeds/exchange-feed";
import { logger } from "./src/utils/logger";
import { getCurrentFiveMinWindow } from "./src/utils/time";

async function testTrade() {
  try {
    logger.info("=== Starting Trade Test ===");
    
    // Load config
    const config = loadConfig();
    if (config.dryRun) {
      logger.warn("DRY_RUN is enabled - this will simulate trades only");
    } else {
      logger.info("LIVE MODE - real trades will be placed!");
    }

    // Initialize feeds
    logger.info("Initializing feeds...");
    const exchangeFeed = new ExchangeFeed();
    await exchangeFeed.start();
    
    const polymarketFeed = new PolymarketFeed(
      config.polymarketGammaUrl,
      config.polymarketApiUrl,
      config.btc5mEventSlug,
      config.forceRealData ?? false
    );

    // Wait for exchange price
    logger.info("Waiting for exchange price...");
    let exchangePrice = exchangeFeed.getLatestPrice();
    let attempts = 0;
    while (!exchangePrice && attempts < 10) {
      await new Promise(resolve => setTimeout(resolve, 1000));
      exchangePrice = exchangeFeed.getLatestPrice();
      attempts++;
    }

    if (!exchangePrice) {
      throw new Error("Failed to get exchange price");
    }
    logger.info(`Exchange price: $${exchangePrice.price.toFixed(2)}`);

    // Find active market
    logger.info("Finding active BTC market...");
    const markets = await polymarketFeed.findActiveCryptoMarkets("BTC");
    const nowSec = Math.floor(Date.now() / 1000);
    const activeMarket = markets.find(m => m.active && m.startTime <= nowSec && nowSec < m.endTime);
    
    if (!activeMarket) {
      throw new Error("No active BTC market found");
    }
    logger.info(`Found active market: ${activeMarket.slug}`);
    logger.info(`  Window: ${new Date(activeMarket.startTime * 1000).toISOString()} - ${new Date(activeMarket.endTime * 1000).toISOString()}`);
    logger.info(`  Time remaining: ${activeMarket.endTime - nowSec} seconds`);

    // Get market prices
    logger.info("Fetching market prices...");
    const prices = await polymarketFeed.getMarketPrices(
      activeMarket,
      exchangePrice.price,
      exchangePrice.price // Use current price as window start for test
    );

    if (!prices) {
      throw new Error("Failed to get market prices");
    }

    logger.info(`Market prices:`);
    logger.info(`  YES ask: ${(prices.yesBestAsk * 100).toFixed(2)}¢ (size: ${prices.yesBestAskSize ?? 'N/A'})`);
    logger.info(`  NO ask: ${(prices.noBestAsk * 100).toFixed(2)}¢ (size: ${prices.noBestAskSize ?? 'N/A'})`);

    // Initialize trader
    logger.info("Initializing trader...");
    const trader = new Trader(config);
    await trader.initialize();
    logger.info("Trader initialized successfully");

    // Choose cheapest side for minimal cost test
    const yesCost = prices.yesBestAsk;
    const noCost = prices.noBestAsk;
    const useYes = yesCost <= noCost;
    const tokenId = useYes ? activeMarket.yesTokenId : activeMarket.noTokenId;
    const price = useYes ? prices.yesBestAsk : prices.noBestAsk;
    const side = useYes ? "YES" : "NO";
    const size = 1; // Buy just 1 share for minimal cost

    const totalCost = price * size;
    logger.info(`\n=== Placing Test Order ===`);
    logger.info(`Side: ${side}`);
    logger.info(`Price: $${price.toFixed(4)}`);
    logger.info(`Size: ${size} share(s)`);
    logger.info(`Total cost: $${totalCost.toFixed(4)}`);
    logger.info(`Token ID: ${tokenId}`);

    // Place order
    logger.info("\nPlacing order...");
    const tradeResult = await trader.placeLimitBuy(tokenId, price, size, side as "YES" | "NO");

    if (tradeResult.success) {
      logger.info("\n✅ ORDER SUCCESSFUL!");
      logger.info(`  Order ID: ${tradeResult.orderId}`);
      logger.info(`  Filled size: ${tradeResult.filledSize ?? 0}`);
      logger.info(`  Price: $${tradeResult.price.toFixed(4)}`);
      logger.info(`  Total cost: $${(tradeResult.price * (tradeResult.filledSize ?? 0)).toFixed(4)}`);
      
      if (!config.dryRun) {
        logger.info("\n⚠️  LIVE TRADE EXECUTED - Position is now open");
        logger.info(`   This position will settle when the market window ends (${new Date(activeMarket.endTime * 1000).toISOString()})`);
        logger.info(`   You can monitor it in the dashboard or check your Polymarket account`);
      }
    } else {
      logger.error("\n❌ ORDER FAILED");
      logger.error(`  Error: ${tradeResult.error ?? "Unknown error"}`);
      logger.error(`  Price: $${price.toFixed(4)}`);
      logger.error(`  Size: ${size}`);
      logger.error(`  Token ID: ${tokenId}`);
      logger.error(`  Side: ${side}`);
      logger.error("\nTroubleshooting:");
      logger.error("  1. Check that your wallet has sufficient USDC balance");
      logger.error("  2. Verify API credentials are correct");
      logger.error("  3. Check that the market is still active");
      logger.error("  4. Ensure the order size meets minimum requirements");
      process.exit(1);
    }

    // Cleanup
    exchangeFeed.stop();
    logger.info("\n=== Test Complete ===");

  } catch (error: any) {
    logger.error("\n❌ TEST FAILED");
    logger.error(`Error: ${error?.message || String(error)}`);
    if (error?.stack) {
      logger.error(`Stack: ${error.stack}`);
    }
    if (error?.response) {
      logger.error("API Response:", {
        status: error.response.status,
        data: error.response.data,
      });
    }
    process.exit(1);
  }
}

testTrade();
