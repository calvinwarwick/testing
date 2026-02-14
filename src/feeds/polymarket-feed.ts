import axios from "axios";
import {
  PolymarketMarket,
  MarketPrices,
  OrderBook,
  OrderBookLevel,
} from "../types";
import { logger } from "../utils/logger";

/** Gamma API event shape (subset we use) */
interface GammaEvent {
  slug?: string;
  markets?: GammaMarket[];
  enableOrderBook?: boolean;
}

/** Gamma API market shape (subset we use) */
interface GammaMarket {
  conditionId?: string;
  condition_id?: string;
  slug?: string;
  question?: string;
  clobTokenIds?: string | string[];
  startDate?: string;
  start_date_iso?: string;
  endDate?: string;
  end_date_iso?: string;
  active?: boolean;
  enableOrderBook?: boolean;
}

/**
 * Fetches market data and order book prices from Polymarket.
 *
 * Uses two APIs:
 * - Gamma API Events: market discovery (find active 5-min BTC events by slug)
 * - CLOB API: order book data (get YES/NO bid/ask prices)
 *
 * The CLOB uses a hybrid-decentralized model: off-chain matching
 * with on-chain settlement via the Conditional Token Framework (CTF).
 */
export class PolymarketFeed {
  private readonly gammaUrl: string;
  private readonly clobUrl: string;
  private readonly btc5mEventSlug?: string;

  constructor(
    gammaUrl: string,
    clobUrl: string,
    btc5mEventSlug?: string
  ) {
    this.gammaUrl = gammaUrl;
    this.clobUrl = clobUrl;
    this.btc5mEventSlug = btc5mEventSlug;
  }

  /** Simulation mode flag - set to true when no real markets found or SIMULATE_MARKETS=true */
  private simulationMode = process.env.SIMULATE_MARKETS === "true";
  /** Track consecutive order book failures to auto-enable simulation */
  private orderBookFailures = 0;
  /** Simulated market prices (updated each cycle for realism) */
  private simulatedPrices = new Map<string, { yesAsk: number; noAsk: number; lastUpdate: number }>();

  /**
   * Discover active 5-minute BTC markets on Polymarket.
   * Uses current time to compute the active window end and requests those slugs
   * from the Gamma Events API so we always get markets that exist right now.
   * Falls back to simulated markets if no real markets are found or SIMULATE_MARKETS=true.
   */
  async findActiveCryptoMarkets(
    asset: string = "BTC"
  ): Promise<PolymarketMarket[]> {
    // If SIMULATE_MARKETS is set, always use simulation
    if (process.env.SIMULATE_MARKETS === "true") {
      this.simulationMode = true;
      return this.generateSimulatedMarkets();
    }

    const markets = await this.findBtc5MinMarketsBySlugs();
    if (markets.length > 0) {
      this.simulationMode = false;
      return markets;
    }
    const legacyMarkets = await this.findBtc5MinMarketsLegacy(asset);
    if (legacyMarkets.length > 0) {
      this.simulationMode = false;
      return legacyMarkets;
    }
    // No real markets found - switch to simulation mode
    this.simulationMode = true;
    return this.generateSimulatedMarkets();
  }

  /**
   * Generate simulated BTC 5-min markets for demonstration.
   * Creates realistic market windows based on current time.
   */
  private generateSimulatedMarkets(): PolymarketMarket[] {
    const nowSec = Math.floor(Date.now() / 1000);
    const FIVE_MIN = 300;
    const currentWindowEnd = Math.ceil(nowSec / FIVE_MIN) * FIVE_MIN;

    const markets: PolymarketMarket[] = [];
    for (let i = 0; i < 12; i++) {
      const endTime = currentWindowEnd + i * FIVE_MIN;
      const startTime = endTime - FIVE_MIN;
      markets.push({
        conditionId: `sim-condition-${endTime}`,
        slug: `btc-updown-5m-${endTime}`,
        question: `Will BTC be higher at ${new Date(endTime * 1000).toISOString().slice(11, 16)} UTC?`,
        yesTokenId: `sim-yes-${endTime}`,
        noTokenId: `sim-no-${endTime}`,
        startTime,
        endTime,
        active: true,
      });
    }

    if (markets.length > 0) {
      logger.info(`SIMULATION MODE: Generated ${markets.length} simulated BTC 5-min markets`);
    }
    return markets;
  }

  /**
   * Fetch BTC 5-min markets by requesting event slugs for the current and next windows.
   * Slug pattern: btc-updown-5m-{unix_timestamp} (window end time, 5-min = 300s apart).
   * We use current time so we always request windows that exist (not a fixed env slug).
   */
  private async findBtc5MinMarketsBySlugs(): Promise<PolymarketMarket[]> {
    const nowSec = Math.floor(Date.now() / 1000);
    const FIVE_MIN = 300;
    // Current active window ends at the next 5-min boundary >= now (e.g. 10:50, 10:55)
    const currentWindowEnd = Math.ceil(nowSec / FIVE_MIN) * FIVE_MIN;
    const numWindows = 12;
    const slugs: string[] = [];
    for (let i = 0; i < numWindows; i++) {
      slugs.push(`btc-updown-5m-${currentWindowEnd + i * FIVE_MIN}`);
    }

    try {
      // Try multi-slug request first (some APIs accept slug=x&slug=y)
      const params = new URLSearchParams();
      params.set("closed", "false");
      params.set("limit", "50");
      slugs.forEach((s) => params.append("slug", s));

      let response = await axios.get<GammaEvent[]>(`${this.gammaUrl}/events`, {
        params,
        timeout: 10000,
      });

      let data = response.data;
      let events = Array.isArray(data) ? data : [];

      // If no events, try fetching one slug at a time (API may only honor one slug param)
      if (events.length === 0) {
        const allEvents: GammaEvent[] = [];
        for (const slug of slugs.slice(0, 8)) {
          try {
            const r = await axios.get<GammaEvent[]>(`${this.gammaUrl}/events`, {
              params: { closed: "false", slug, limit: "5" },
              timeout: 8000,
            });
            const arr = Array.isArray(r.data) ? r.data : [];
            for (const ev of arr) {
              const id = (ev as { id?: string })?.id ?? (ev as { slug?: string })?.slug;
              if (ev && id && !allEvents.some((e) => ((e as { id?: string }).id ?? (e as { slug?: string }).slug) === id)) {
                allEvents.push(ev);
              }
            }
          } catch {
            // skip this slug
          }
        }
        events = allEvents;
      }

      const markets = this.eventsToMarkets(events);
      if (markets.length > 0) {
        logger.info(
          `Found ${markets.length} active BTC 5-min markets (slugs: ${slugs[0]}..${slugs[slugs.length - 1]})`
        );
      } else if (events.length > 0) {
        logger.warn(
          `Gamma returned ${events.length} events but none passed filters (enableOrderBook, clobTokenIds, endTime)`
        );
      }
      return markets;
    } catch (error) {
      logger.error("Failed to fetch BTC 5-min events from Gamma API", {
        error: String(error),
      });
      return [];
    }
  }

  /** Convert Gamma events array to PolymarketMarket[], parsing clobTokenIds. Only includes markets whose window has not ended (CLOB returns 404 for resolved markets). */
  private eventsToMarkets(events: GammaEvent[]): PolymarketMarket[] {
    const nowSec = Math.floor(Date.now() / 1000);
    const out: PolymarketMarket[] = [];
    for (const event of events) {
      if (!event.markets?.length || event.enableOrderBook === false) continue;
      for (const m of event.markets) {
        if (m.enableOrderBook === false) continue;
        const tokenIds = this.parseClobTokenIds(m.clobTokenIds);
        if (tokenIds.length < 2) continue;

        const startDate = m.startDate || m.start_date_iso;
        const endDate = m.endDate || m.end_date_iso;
        const endTime = endDate
          ? Math.floor(new Date(endDate).getTime() / 1000)
          : 0;
        if (endTime > 0 && endTime <= nowSec) continue;

        out.push({
          conditionId: m.conditionId || m.condition_id || "",
          slug: m.slug || event.slug || "",
          question: m.question || "",
          yesTokenId: tokenIds[0],
          noTokenId: tokenIds[1],
          startTime: startDate
            ? Math.floor(new Date(startDate).getTime() / 1000)
            : 0,
          endTime,
          active: m.active !== false,
        });
      }
    }
    return out;
  }

  private parseClobTokenIds(
    clobTokenIds: string | string[] | undefined
  ): string[] {
    if (!clobTokenIds) return [];
    if (Array.isArray(clobTokenIds)) return clobTokenIds;
    try {
      const parsed = JSON.parse(clobTokenIds as string);
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }

  /**
   * Legacy: discover via /markets with tag crypto (may not return 5-min events).
   */
  private async findBtc5MinMarketsLegacy(
    asset: string
  ): Promise<PolymarketMarket[]> {
    try {
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
        const question = (m.question || "").toLowerCase();
        const isBtcMarket =
          question.includes(asset.toLowerCase()) ||
          question.includes("bitcoin");
        const is5MinMarket =
          question.includes("5 min") ||
          question.includes("5-min") ||
          question.includes("five min");

        if (!isBtcMarket || !is5MinMarket) continue;
        const tokenIds = this.parseClobTokenIds(m.clobTokenIds);
        if (tokenIds.length < 2) continue;

        markets.push({
          conditionId: m.conditionId || m.condition_id,
          slug: m.slug || m.market_slug || "",
          question: m.question,
          yesTokenId: tokenIds[0],
          noTokenId: tokenIds[1],
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
    } catch (error: unknown) {
      const status = (error as { response?: { status?: number } })?.response?.status;
      if (status === 404) {
        logger.debug(`Order book 404 for token ${tokenId} (market may be resolved)`);
      } else {
        logger.error(`Failed to fetch order book for token ${tokenId}`, {
          error: String(error),
        });
      }
      return null;
    }
  }

  /**
   * Get the current best prices for a market (both YES and NO sides).
   * This is the core data we need for arbitrage detection.
   * In simulation mode, generates realistic prices that lag behind BTC.
   */
  async getMarketPrices(market: PolymarketMarket, currentBtcPrice?: number, windowStartBtcPrice?: number): Promise<MarketPrices | null> {
    // In simulation mode, generate realistic lagging prices
    if (this.simulationMode) {
      return this.getSimulatedMarketPrices(market, currentBtcPrice, windowStartBtcPrice);
    }

    try {
      // Fetch both order books in parallel for speed
      const [yesBook, noBook] = await Promise.all([
        this.getOrderBook(market.yesTokenId),
        this.getOrderBook(market.noTokenId),
      ]);

      if (!yesBook || !noBook) {
        this.orderBookFailures++;
        // After 5 consecutive failures, auto-enable simulation mode
        if (this.orderBookFailures >= 5 && !this.simulationMode) {
          logger.warn(`Order books unavailable - switching to SIMULATION MODE`);
          this.simulationMode = true;
          return this.getSimulatedMarketPrices(market, currentBtcPrice, windowStartBtcPrice);
        }
        logger.debug(`Missing order book data for market ${market.slug} (failure ${this.orderBookFailures}/5)`);
        return null;
      }

      // Reset failure count on success
      this.orderBookFailures = 0;

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
   * Generate simulated market prices that lag behind BTC movements.
   * Creates realistic arbitrage opportunities when BTC moves quickly.
   */
  private getSimulatedMarketPrices(market: PolymarketMarket, currentBtcPrice?: number, windowStartBtcPrice?: number): MarketPrices | null {
    const now = Date.now();
    const cached = this.simulatedPrices.get(market.slug);

    // Start with 50/50 prices
    let yesAsk = cached?.yesAsk ?? 0.50;
    let noAsk = cached?.noAsk ?? 0.50;

    // If we have BTC prices, simulate market maker lag
    if (currentBtcPrice && windowStartBtcPrice) {
      const btcMove = (currentBtcPrice - windowStartBtcPrice) / windowStartBtcPrice;
      const btcMovePercent = btcMove * 100;

      // "True" fair price based on BTC position (what we think it should be)
      // Uses the same formula as the detector: 0.5 + pctMove * 0.4
      const fairYesPrice = Math.min(0.85, Math.max(0.15, 0.5 + btcMovePercent * 0.4));

      // Simulated market is SLOW - only reacts to 30% of the fair move
      // This creates the arbitrage opportunity we're looking for
      const lagFactor = 0.30;
      const targetYes = 0.5 + (fairYesPrice - 0.5) * lagFactor;
      const targetNo = 1.0 - targetYes;

      // Quick adjustment (simulate market catching up each cycle)
      const adjustSpeed = 0.5; // 50% adjustment per cycle
      yesAsk = yesAsk + (targetYes - yesAsk) * adjustSpeed;
      noAsk = noAsk + (targetNo - noAsk) * adjustSpeed;

      // Add small spread
      yesAsk = Math.min(0.95, Math.max(0.05, yesAsk + 0.002));
      noAsk = Math.min(0.95, Math.max(0.05, noAsk + 0.002));

      // Log simulated prices occasionally for debugging
      if (Math.random() < 0.05) {
        logger.debug(`SIM: BTC move ${(btcMovePercent).toFixed(3)}% | Fair YES=$${fairYesPrice.toFixed(3)} | Market YES=$${yesAsk.toFixed(3)} NO=$${noAsk.toFixed(3)}`);
      }
    }

    // Cache the updated prices
    this.simulatedPrices.set(market.slug, { yesAsk, noAsk, lastUpdate: now });

    return {
      market,
      yesBestAsk: yesAsk,
      noBestAsk: noAsk,
      yesBestBid: yesAsk - 0.01,
      noBestBid: noAsk - 0.01,
      yesMid: yesAsk - 0.005,
      noMid: noAsk - 0.005,
      timestamp: now,
    };
  }

  /** Check if currently in simulation mode */
  isSimulating(): boolean {
    return this.simulationMode;
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
