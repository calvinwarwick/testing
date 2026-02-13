import axios from "axios";
import {
  PolymarketMarket,
  MarketPrices,
  OrderBook,
  OrderBookLevel,
} from "../types";
import { logger } from "../utils/logger";

/**
 * Fetches market data and order book prices from Polymarket.
 *
 * Uses two APIs:
 * - Gamma API: market discovery (find active 5-min crypto markets)
 * - CLOB API: order book data (get YES/NO bid/ask prices)
 *
 * The CLOB uses a hybrid-decentralized model: off-chain matching
 * with on-chain settlement via the Conditional Token Framework (CTF).
 */
export class PolymarketFeed {
  private readonly gammaUrl: string;
  private readonly clobUrl: string;

  constructor(gammaUrl: string, clobUrl: string) {
    this.gammaUrl = gammaUrl;
    this.clobUrl = clobUrl;
  }

  /**
   * Discover active 5-minute BTC markets on Polymarket.
   * Searches for markets tagged with crypto/BTC that have short timeframes.
   */
  async findActiveCryptoMarkets(
    asset: string = "BTC"
  ): Promise<PolymarketMarket[]> {
    try {
      // Search Gamma API for active crypto markets
      const response = await axios.get(`${this.gammaUrl}/markets`, {
        params: {
          closed: false,
          tag: "crypto",
          limit: 50,
        },
        timeout: 10000,
      });

      const markets: PolymarketMarket[] = [];

      for (const m of response.data) {
        // Filter for 5-min BTC up/down style markets
        const question = (m.question || "").toLowerCase();
        const isBtcMarket =
          question.includes(asset.toLowerCase()) ||
          question.includes("bitcoin");
        const is5MinMarket =
          question.includes("5 min") ||
          question.includes("5-min") ||
          question.includes("five min");

        if (!isBtcMarket || !is5MinMarket) continue;
        if (!m.clobTokenIds || m.clobTokenIds.length < 2) continue;

        markets.push({
          conditionId: m.conditionId || m.condition_id,
          slug: m.slug || m.market_slug || "",
          question: m.question,
          yesTokenId: m.clobTokenIds[0],
          noTokenId: m.clobTokenIds[1],
          startTime: Math.floor(
            new Date(m.startDate || m.start_date_iso).getTime() / 1000
          ),
          endTime: Math.floor(
            new Date(m.endDate || m.end_date_iso).getTime() / 1000
          ),
          active: m.active !== false,
        });
      }

      logger.info(`Found ${markets.length} active ${asset} 5-min markets`);
      return markets;
    } catch (error) {
      logger.error("Failed to fetch markets from Gamma API", {
        error: String(error),
      });
      return [];
    }
  }

  /**
   * Fetch the order book for a specific token from the CLOB.
   */
  async getOrderBook(tokenId: string): Promise<OrderBook | null> {
    try {
      const response = await axios.get(`${this.clobUrl}/book`, {
        params: { token_id: tokenId },
        timeout: 5000,
      });

      const data = response.data;

      const parseLevels = (
        levels: Array<{ price: string; size: string }>
      ): OrderBookLevel[] =>
        (levels || []).map((l) => ({
          price: parseFloat(l.price),
          size: parseFloat(l.size),
        }));

      return {
        tokenId,
        bids: parseLevels(data.bids),
        asks: parseLevels(data.asks),
        timestamp: Date.now(),
      };
    } catch (error) {
      logger.error(`Failed to fetch order book for token ${tokenId}`, {
        error: String(error),
      });
      return null;
    }
  }

  /**
   * Get the current best prices for a market (both YES and NO sides).
   * This is the core data we need for arbitrage detection.
   */
  async getMarketPrices(market: PolymarketMarket): Promise<MarketPrices | null> {
    try {
      // Fetch both order books in parallel for speed
      const [yesBook, noBook] = await Promise.all([
        this.getOrderBook(market.yesTokenId),
        this.getOrderBook(market.noTokenId),
      ]);

      if (!yesBook || !noBook) {
        logger.warn(`Missing order book data for market ${market.slug}`);
        return null;
      }

      // Best ask = lowest price someone is willing to sell at (cost to buy)
      // Best bid = highest price someone is willing to buy at (what we can sell for)
      const yesBestAsk = yesBook.asks.length > 0
        ? Math.min(...yesBook.asks.map((a) => a.price))
        : 1.0;
      const yesBestBid = yesBook.bids.length > 0
        ? Math.max(...yesBook.bids.map((b) => b.price))
        : 0.0;
      const noBestAsk = noBook.asks.length > 0
        ? Math.min(...noBook.asks.map((a) => a.price))
        : 1.0;
      const noBestBid = noBook.bids.length > 0
        ? Math.max(...noBook.bids.map((b) => b.price))
        : 0.0;

      return {
        market,
        yesBestAsk,
        noBestAsk,
        yesBestBid,
        noBestBid,
        yesMid: (yesBestAsk + yesBestBid) / 2,
        noMid: (noBestAsk + noBestBid) / 2,
        timestamp: Date.now(),
      };
    } catch (error) {
      logger.error(`Failed to get prices for market ${market.slug}`, {
        error: String(error),
      });
      return null;
    }
  }

  /**
   * Quick price check using the CLOB /price endpoint.
   * Faster than fetching the full order book when we only need midpoint.
   */
  async getMidpointPrice(tokenId: string): Promise<number | null> {
    try {
      const response = await axios.get(`${this.clobUrl}/price`, {
        params: { token_id: tokenId, side: "buy" },
        timeout: 5000,
      });
      return parseFloat(response.data.price);
    } catch (error) {
      logger.debug(`Failed to fetch midpoint for ${tokenId}`);
      return null;
    }
  }

  /**
   * Get available liquidity at the best ask for a token.
   * Tells us how many shares we can buy at the displayed price.
   */
  async getAvailableLiquidity(
    tokenId: string,
    side: "buy" | "sell"
  ): Promise<{ price: number; size: number } | null> {
    const book = await this.getOrderBook(tokenId);
    if (!book) return null;

    if (side === "buy" && book.asks.length > 0) {
      const bestAsk = book.asks.reduce((min, a) =>
        a.price < min.price ? a : min
      );
      return { price: bestAsk.price, size: bestAsk.size };
    }

    if (side === "sell" && book.bids.length > 0) {
      const bestBid = book.bids.reduce((max, b) =>
        b.price > max.price ? b : max
      );
      return { price: bestBid.price, size: bestBid.size };
    }

    return null;
  }
}
