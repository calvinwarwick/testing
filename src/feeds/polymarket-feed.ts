import axios from "axios";
import {
  PolymarketMarket,
  MarketPrices,
  OrderBook,
  OrderBookLevel,
} from "../types";
import { logger } from "../utils/logger";

const FIVE_MIN_SEC = 300;
const MAX_ORDERBOOK_AGE_MS = 10000;

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
  volume?: number | string;
  volumeNum?: number | string;
  volume_24hr?: number | string;
  volume24hr?: number | string;
  liquidity?: number | string;
  liquidityNum?: number | string;
  closed?: boolean;
  outcomes?: string[] | string;
  outcomePrices?: string[] | string;
  winner?: string | null;
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
  private readonly forceRealData: boolean;

  constructor(
    gammaUrl: string,
    clobUrl: string,
    btc5mEventSlug?: string,
    forceRealData: boolean = false
  ) {
    this.gammaUrl = gammaUrl;
    this.clobUrl = clobUrl;
    this.btc5mEventSlug = btc5mEventSlug;
    this.forceRealData = forceRealData;
    this.simulationMode =
      process.env.SIMULATE_MARKETS === "true" && !this.forceRealData;
    this.modeReason = this.simulationMode
      ? "env_simulate_markets"
      : "live_markets";
  }

  /** Simulation mode flag - set to true when no real markets found or SIMULATE_MARKETS=true */
  private simulationMode = false;
  /** Human-readable reason for current mode (for logs/dashboard) */
  private modeReason = "live_markets";
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
    if (this.forceRealData && process.env.SIMULATE_MARKETS === "true") {
      logger.warn(
        "FORCE_REAL_DATA=true: ignoring SIMULATE_MARKETS=true and requiring live markets"
      );
    }
    // If SIMULATE_MARKETS is set, always use simulation
    if (!this.forceRealData && process.env.SIMULATE_MARKETS === "true") {
      this.setMode(
        true,
        "env_simulate_markets",
        "SIMULATION MODE forced by SIMULATE_MARKETS=true"
      );
      return this.generateSimulatedMarkets();
    }

    const markets = await this.findBtc5MinMarketsBySlugs();
    if (markets.length > 0) {
      this.setMode(false, "live_markets");
      return markets;
    }
    const legacyMarkets = await this.findBtc5MinMarketsLegacy(asset);
    if (legacyMarkets.length > 0) {
      this.setMode(false, "live_markets_legacy");
      return legacyMarkets;
    }

    if (this.forceRealData) {
      this.setMode(
        false,
        "force_real_data_no_markets",
        "FORCE_REAL_DATA=true and no live markets discovered; refusing simulation fallback"
      );
      return [];
    }

    // No real markets found - switch to simulation mode
    this.setMode(
      true,
      "no_live_markets_found",
      "No live BTC 5-min markets found; falling back to simulation mode"
    );
    return this.generateSimulatedMarkets();
  }

  /**
   * Generate simulated BTC 5-min markets for demonstration.
   * Creates realistic market windows based on current time.
   */
  private generateSimulatedMarkets(): PolymarketMarket[] {
    const nowSec = Math.floor(Date.now() / 1000);
    const currentWindowEnd = Math.ceil(nowSec / FIVE_MIN_SEC) * FIVE_MIN_SEC;

    const markets: PolymarketMarket[] = [];
    for (let i = 0; i < 12; i++) {
      const endTime = currentWindowEnd + i * FIVE_MIN_SEC;
      const startTime = endTime - FIVE_MIN_SEC;
      markets.push({
        conditionId: `sim-condition-${endTime}`,
        slug: `btc-updown-5m-${startTime}`,
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
   * Fetch most recent resolved BTC 5-min markets directly from Polymarket.
   * Uses prior window slugs and resolves outcome from winner/outcomes labels.
   */
  async getRecentResolvedBtcMarkets(limit: number = 10): Promise<
    Array<{
      windowStart: number;
      windowEnd: number;
      outcome: "UP" | "DOWN";
      recordedAt: number;
      btcPriceAtStart: number;
      btcPriceAtEnd: number;
    }>
  > {
    const nowSec = Math.floor(Date.now() / 1000);
    // Start from the PREVIOUS 5-min boundary; current boundary may still be unresolved.
    const latestResolvedStart =
      Math.floor(nowSec / FIVE_MIN_SEC) * FIVE_MIN_SEC - FIVE_MIN_SEC;
    const lookback = Math.max(limit * 3, 30);
    const slugs: string[] = [];
    for (let i = 0; i < lookback; i++) {
      slugs.push(`btc-updown-5m-${latestResolvedStart - i * FIVE_MIN_SEC}`);
    }

    const requests = slugs.map((slug) =>
      axios
        .get<GammaEvent[]>(`${this.gammaUrl}/events`, {
          params: { slug, limit: "5" },
          timeout: 8000,
        })
        .then((r) => ({ slug, events: Array.isArray(r.data) ? r.data : [] }))
        .catch(() => ({ slug, events: [] as GammaEvent[] }))
    );
    const responses = await Promise.all(requests);
    const out: Array<{
      windowStart: number;
      windowEnd: number;
      outcome: "UP" | "DOWN";
      recordedAt: number;
      btcPriceAtStart: number;
      btcPriceAtEnd: number;
    }> = [];
    const seen = new Set<number>();

    for (const res of responses) {
      if (out.length >= limit) break;
      const event = res.events[0];
      const market =
        event?.markets?.find((m) => m.slug === res.slug) ??
        event?.markets?.find((m) => (m.slug ?? "").startsWith("btc-updown-5m-")) ??
        event?.markets?.[0];
      if (!market) continue;
      const slug = market.slug || event.slug || res.slug;
      if (!slug.startsWith("btc-updown-5m-")) continue;
      const windowStart = this.parseSlugTimestamp(slug);
      if (!windowStart || seen.has(windowStart) || windowStart > nowSec) continue;
      if (windowStart % FIVE_MIN_SEC !== 0) continue;
      if (market.closed !== true) continue;
      // BTC up/down strategy windows are always 5 minutes; slug timestamp is the window START.
      const normalizedStart = windowStart;
      const normalizedEnd = windowStart + FIVE_MIN_SEC;
      const outcome = this.resolveUpDownOutcome(market);
      if (!outcome) continue;
      seen.add(normalizedStart);
      out.push({
        windowStart: normalizedStart,
        windowEnd: normalizedEnd,
        outcome,
        recordedAt: Date.now(),
        btcPriceAtStart: 0,
        btcPriceAtEnd: 0,
      });
    }

    return out.sort((a, b) => b.windowEnd - a.windowEnd).slice(0, limit);
  }

  /**
   * Fetch BTC 5-min markets by requesting event slugs for the current and next windows.
   * Slug pattern: btc-updown-5m-{unix_timestamp} (window end time, 5-min = 300s apart).
   * We use current time so we always request windows that exist (not a fixed env slug).
   */
  private async findBtc5MinMarketsBySlugs(): Promise<PolymarketMarket[]> {
    const nowSec = Math.floor(Date.now() / 1000);
    // Slug timestamp is the 5-min window START.
    const currentWindowStart = Math.floor(nowSec / FIVE_MIN_SEC) * FIVE_MIN_SEC;
    // Directional runtime tracks only the current market; fetch a tiny forward set
    // to remain resilient around boundary turnover.
    const numWindows = 2;
    const slugs: string[] = [];
    for (let i = 0; i < numWindows; i++) {
      slugs.push(`btc-updown-5m-${currentWindowStart + i * FIVE_MIN_SEC}`);
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
        const slug = m.slug || event.slug || "";
        const slugStart = this.parseSlugTimestamp(slug);
        const startTimeFromSlug = slugStart ?? 0;
        const endTimeFromSlug = slugStart != null ? slugStart + FIVE_MIN_SEC : 0;
        const endTimeFromDate = endDate
          ? Math.floor(new Date(endDate).getTime() / 1000)
          : 0;
        const endTime = endTimeFromSlug || endTimeFromDate;
        const startTime =
          startTimeFromSlug ||
          (startDate ? Math.floor(new Date(startDate).getTime() / 1000) : 0);
        const hasFiveMinWindow =
          startTime > 0 &&
          endTime > 0 &&
          endTime - startTime === FIVE_MIN_SEC &&
          startTime % FIVE_MIN_SEC === 0 &&
          endTime % FIVE_MIN_SEC === 0;
        if (!hasFiveMinWindow) continue;
        if (endTime > 0 && endTime <= nowSec) continue;

        out.push({
          conditionId: m.conditionId || m.condition_id || "",
          slug,
          question: m.question || "",
          yesTokenId: tokenIds[0],
          noTokenId: tokenIds[1],
          // Gamma startDate can be market creation time, not 5-min window start.
          // Use slug timestamp as authoritative for window alignment.
          startTime,
          endTime,
          active: m.active !== false,
          volumeUsd:
            this.parseNumberLike(m.volumeNum) ??
            this.parseNumberLike(m.volume) ??
            this.parseNumberLike(m.volume24hr) ??
            this.parseNumberLike(m.volume_24hr),
          liquidityUsd:
            this.parseNumberLike(m.liquidityNum) ??
            this.parseNumberLike(m.liquidity),
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

  private parseNumberLike(v: unknown): number | undefined {
    if (typeof v === "number" && Number.isFinite(v)) return v;
    if (typeof v === "string") {
      const n = parseFloat(v);
      return Number.isFinite(n) ? n : undefined;
    }
    return undefined;
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
          volumeUsd:
            this.parseNumberLike((m as { volumeNum?: unknown }).volumeNum) ??
            this.parseNumberLike((m as { volume?: unknown }).volume) ??
            this.parseNumberLike((m as { volume24hr?: unknown }).volume24hr) ??
            this.parseNumberLike((m as { volume_24hr?: unknown }).volume_24hr),
          liquidityUsd:
            this.parseNumberLike((m as { liquidityNum?: unknown }).liquidityNum) ??
            this.parseNumberLike((m as { liquidity?: unknown }).liquidity),
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
      const apiTimestampRaw =
        (data as { timestamp?: number | string; ts?: number | string }).timestamp ??
        (data as { ts?: number | string }).ts;
      const apiTimestampMs =
        typeof apiTimestampRaw === "number"
          ? apiTimestampRaw
          : typeof apiTimestampRaw === "string"
            ? Number(apiTimestampRaw)
            : NaN;
      const normalizedTimestampMs = Number.isFinite(apiTimestampMs)
        ? apiTimestampMs > 1_000_000_000_000
          ? Math.floor(apiTimestampMs)
          : Math.floor(apiTimestampMs * 1000)
        : Date.now();

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
        timestamp: normalizedTimestampMs,
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
          if (this.forceRealData) {
            logger.error(
              "FORCE_REAL_DATA=true and order books unavailable after 5 failures; refusing simulation fallback"
            );
            return null;
          }
          this.setMode(
            true,
            "orderbook_failures",
            "Order books unavailable - switching to SIMULATION MODE"
          );
          return this.getSimulatedMarketPrices(market, currentBtcPrice, windowStartBtcPrice);
        }
        logger.debug(`Missing order book data for market ${market.slug} (failure ${this.orderBookFailures}/5)`);
        return null;
      }
      const newestBookTs = Math.max(yesBook.timestamp, noBook.timestamp);
      const booksAgeMs = Date.now() - newestBookTs;
      if (!Number.isFinite(booksAgeMs) || booksAgeMs > MAX_ORDERBOOK_AGE_MS) {
        logger.debug(
          `Skipping ${market.slug}: stale orderbook (${Math.max(
            0,
            Math.floor(booksAgeMs)
          )}ms old)`
        );
        return null;
      }

      // Reset failure count on success
      this.orderBookFailures = 0;

      // Best ask = lowest price someone is willing to sell at (cost to buy)
      // Best bid = highest price someone is willing to buy at (what we can sell for)
      const yesBestAskLevel = yesBook.asks.length > 0
        ? yesBook.asks.reduce((min, a) => (a.price < min.price ? a : min))
        : null;
      const yesBestAsk = yesBook.asks.length > 0
        ? Math.min(...yesBook.asks.map((a) => a.price))
        : 1.0;
      const yesBestAskSize = yesBestAskLevel?.size;
      const yesBestBid = yesBook.bids.length > 0
        ? Math.max(...yesBook.bids.map((b) => b.price))
        : 0.0;
      const noBestAskLevel = noBook.asks.length > 0
        ? noBook.asks.reduce((min, a) => (a.price < min.price ? a : min))
        : null;
      const noBestAsk = noBook.asks.length > 0
        ? Math.min(...noBook.asks.map((a) => a.price))
        : 1.0;
      const noBestAskSize = noBestAskLevel?.size;
      const noBestBid = noBook.bids.length > 0
        ? Math.max(...noBook.bids.map((b) => b.price))
        : 0.0;

      return {
        market,
        yesBestAsk,
        yesBestAskSize,
        noBestAsk,
        noBestAskSize,
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
      yesBestAskSize: 1000,
      noBestAsk: noAsk,
      noBestAskSize: 1000,
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

  /** Get current market data mode for status surfaces (dashboard/logging). */
  getDataMode(): "simulation" | "live" {
    return this.simulationMode ? "simulation" : "live";
  }

  /** Get reason for current data mode. */
  getModeReason(): string {
    return this.modeReason;
  }

  private setMode(
    simulation: boolean,
    reason: string,
    transitionLog?: string
  ): void {
    const changed = this.simulationMode !== simulation;
    this.simulationMode = simulation;
    this.modeReason = reason;
    if (changed && transitionLog) {
      logger.warn(transitionLog);
    }
  }

  private parseStringArray(v: unknown): string[] {
    if (Array.isArray(v)) {
      return v.map((x) => String(x));
    }
    if (typeof v === "string") {
      try {
        const parsed = JSON.parse(v);
        if (Array.isArray(parsed)) return parsed.map((x) => String(x));
      } catch {
        // ignored
      }
    }
    return [];
  }

  private parseSlugTimestamp(slug: string): number | null {
    const m = slug.match(/btc-updown-5m-(\d{9,})$/);
    if (!m) return null;
    const n = Number(m[1]);
    return Number.isFinite(n) ? n : null;
  }

  private resolveUpDownOutcome(market: GammaMarket): "UP" | "DOWN" | null {
    const outcomes = this.parseStringArray(market.outcomes);
    const normalized = outcomes.map((o) => o.toLowerCase());
    const winnerRaw =
      typeof market.winner === "string" ? market.winner.toLowerCase().trim() : "";

    const mapLabel = (label: string): "UP" | "DOWN" | null => {
      if (/\bup\b/.test(label)) return "UP";
      if (/\bdown\b/.test(label)) return "DOWN";
      if (/\byes\b/.test(label)) return "UP";
      if (/\bno\b/.test(label)) return "DOWN";
      return null;
    };

    // Prefer the explicit winner marker when available.
    if (winnerRaw) {
      const winnerFromLabel = mapLabel(winnerRaw);
      if (winnerFromLabel) return winnerFromLabel;
      if (/^\d+$/.test(winnerRaw) && normalized.length > 0) {
        const idx = Number(winnerRaw);
        if (idx >= 0 && idx < normalized.length) {
          const winnerFromIndex = mapLabel(normalized[idx]);
          if (winnerFromIndex) return winnerFromIndex;
        }
      }
    }

    // Fallback: direct outcomes label mapping for markets that expose only one definitive label.
    if (normalized.length === 1) {
      return mapLabel(normalized[0]);
    }

    // Secondary fallback: if outcomes include explicit UP/DOWN labels, use their first appearance.
    for (const label of normalized) {
      const mapped = mapLabel(label);
      if (mapped) return mapped;
    }

    return null;
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
