import WebSocket from "ws";
import axios from "axios";
import { ExchangePrice } from "../types";
import { logger } from "../utils/logger";

const AGGREGATE_INTERVAL_MS = 2000;
const REST_TIMEOUT_MS = 5000;
const MAX_PRICE_AGE_MS = 10000;

type PriceEntry = { price: number; timestamp: number };

/**
 * Fetches real-time BTC price from Binance only.
 * Uses Binance WebSocket for low-latency plus REST polling for Binance.
 * Other exchanges are still polled for reference but not used for trading.
 */
export class ExchangeFeed {
  private ws: WebSocket | null = null;
  private prices = new Map<string, PriceEntry>();
  private aggregated: ExchangePrice | null = null;
  private reconnectAttempts = 0;
  private maxReconnectAttempts = 10;
  private isRunning = false;
  private restInterval: ReturnType<typeof setInterval> | null = null;
  private restFetchInProgress = false;

  /** Rolling price samples for volatility calculation */
  private priceSamples: { price: number; timestamp: number }[] = [];
  private static readonly VOLATILITY_WINDOW_MS = 600_000; // 10 minutes
  private static readonly MAX_VOLATILITY_SAMPLES = 300;

  private readonly binanceWsUrl =
    "wss://stream.binance.com:9443/ws/btcusdt@ticker";
  private readonly binanceRestUrl =
    "https://api.binance.com/api/v3/ticker/price?symbol=BTCUSDT";

  private static readonly REST_SOURCES: Array<{
    name: string;
    url: string;
    parse: (data: unknown) => number | null;
  }> = [
    {
      name: "binance",
      url: "https://api.binance.com/api/v3/ticker/price?symbol=BTCUSDT",
      parse: (d) =>
        typeof (d as { price?: string }).price === "string"
          ? parseFloat((d as { price: string }).price)
          : null,
    },
    {
      name: "coinbase",
      url: "https://api.coinbase.com/v2/prices/BTC-USD/spot",
      parse: (d) => {
        const data = (d as { data?: { amount?: string } }).data;
        return data?.amount != null ? parseFloat(data.amount) : null;
      },
    },
    {
      name: "okx",
      url: "https://www.okx.com/api/v5/market/ticker?instId=BTC-USDT",
      parse: (d) => {
        const arr = (d as { data?: Array<{ last?: string }> }).data;
        const last = arr?.[0]?.last;
        return last != null ? parseFloat(last) : null;
      },
    },
    {
      name: "bybit",
      url: "https://api.bybit.com/v5/market/tickers?category=spot&symbol=BTCUSDT",
      parse: (d) => {
        const list = (d as { result?: { list?: Array<{ lastPrice?: string }> } })
          .result?.list;
        const last = list?.[0]?.lastPrice;
        return last != null ? parseFloat(last) : null;
      },
    },
    {
      name: "kraken",
      url: "https://api.kraken.com/0/public/Ticker?pair=XBTUSD",
      parse: (d) => {
        const result = (d as { result?: Record<string, { c?: string[] }> })
          .result;
        const pair = result?.XXBTZUSD ?? result?.XBTCUSD;
        const c = pair?.c;
        return c?.[0] != null ? parseFloat(c[0]) : null;
      },
    },
    {
      name: "bitfinex",
      url: "https://api-pub.bitfinex.com/v2/ticker/tBTCUSD",
      parse: (d) => {
        const arr = d as number[];
        return Array.isArray(arr) && typeof arr[6] === "number" ? arr[6] : null;
      },
    },
  ];

  async start(): Promise<void> {
    this.isRunning = true;
    logger.info("Exchange feed starting (REST + Binance WS)");

    await this.fetchAllRest();
    this.recomputeAggregated();

    this.restInterval = setInterval(() => {
      if (!this.isRunning) return;
      this.fetchAllRest();
      this.recomputeAggregated();
    }, AGGREGATE_INTERVAL_MS);

    this.connectWebSocket();
  }

  stop(): void {
    this.isRunning = false;
    if (this.restInterval) {
      clearInterval(this.restInterval);
      this.restInterval = null;
    }
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
    this.prices.clear();
    this.aggregated = null;
    logger.debug("Exchange feed stopped");
  }

  getLatestPrice(): ExchangePrice | null {
    if (!this.aggregated) return null;
    if (Date.now() - this.aggregated.timestamp > MAX_PRICE_AGE_MS) {
      return null;
    }
    return this.aggregated;
  }

  /**
   * Get last price per exchange (for dashboard / debugging).
   */
  getPricesByExchange(): Map<string, number> {
    const out = new Map<string, number>();
    this.prices.forEach((e, name) => out.set(name, e.price));
    return out;
  }

  /**
   * Get rolling BTC price volatility as standard deviation of percentage returns.
   * Returns null if insufficient data (< 10 samples).
   */
  getVolatility(): number | null {
    if (this.priceSamples.length < 10) return null;

    const returns: number[] = [];
    for (let i = 1; i < this.priceSamples.length; i++) {
      const ret = (this.priceSamples[i].price - this.priceSamples[i - 1].price)
                  / this.priceSamples[i - 1].price * 100;
      returns.push(ret);
    }

    const mean = returns.reduce((s, r) => s + r, 0) / returns.length;
    const variance = returns.reduce((s, r) => s + (r - mean) ** 2, 0) / returns.length;
    return Math.sqrt(variance);
  }

  private recordPriceSample(): void {
    if (!this.aggregated) return;
    const now = Date.now();
    this.priceSamples.push({ price: this.aggregated.price, timestamp: now });

    // Evict old samples
    const cutoff = now - ExchangeFeed.VOLATILITY_WINDOW_MS;
    while (this.priceSamples.length > 0 && this.priceSamples[0].timestamp < cutoff) {
      this.priceSamples.shift();
    }
    if (this.priceSamples.length > ExchangeFeed.MAX_VOLATILITY_SAMPLES) {
      this.priceSamples = this.priceSamples.slice(-ExchangeFeed.MAX_VOLATILITY_SAMPLES);
    }
  }

  private setPrice(exchange: string, price: number): void {
    this.prices.set(exchange, { price, timestamp: Date.now() });
  }

  private recomputeAggregated(): void {
    this.evictStalePrices();
    // Use only Binance price instead of median
    const binancePrice = this.prices.get("binance");
    if (!binancePrice) return;
    
    this.aggregated = {
      exchange: "binance",
      symbol: "BTCUSDT",
      price: binancePrice.price,
      timestamp: binancePrice.timestamp,
    };
    this.recordPriceSample();
  }

  private evictStalePrices(): void {
    const cutoff = Date.now() - MAX_PRICE_AGE_MS;
    for (const [exchange, entry] of this.prices) {
      if (entry.timestamp < cutoff) {
        this.prices.delete(exchange);
      }
    }
  }

  private async fetchAllRest(): Promise<void> {
    if (this.restFetchInProgress) return;
    this.restFetchInProgress = true;
    try {
      const results = await Promise.allSettled(
        ExchangeFeed.REST_SOURCES.map(async (src) => {
          const res = await axios.get(src.url, { timeout: REST_TIMEOUT_MS });
          const price = src.parse(res.data);
          if (price != null && Number.isFinite(price)) {
            this.setPrice(src.name, price);
          }
        })
      );
      const failed = results.filter((r) => r.status === "rejected").length;
      if (failed > 0) {
        logger.debug(
          `REST feeds: ${this.prices.size}/${ExchangeFeed.REST_SOURCES.length} succeeded`
        );
      }
    } finally {
      this.restFetchInProgress = false;
    }
  }

  private connectWebSocket(): void {
    if (!this.isRunning) return;

    try {
      this.ws = new WebSocket(this.binanceWsUrl);

      this.ws.on("open", () => {
        logger.debug("Binance WebSocket connected");
        this.reconnectAttempts = 0;
      });

      this.ws.on("message", (data: WebSocket.Data) => {
        try {
          const ticker = JSON.parse(data.toString());
          const p = parseFloat(ticker.c);
          if (Number.isFinite(p)) {
            this.setPrice("binance", p);
            this.recomputeAggregated();
          }
        } catch {
          logger.warn("Failed to parse WebSocket ticker message");
        }
      });

      this.ws.on("close", () => {
        logger.warn("Binance WebSocket disconnected");
        this.scheduleReconnect();
      });

      this.ws.on("error", (error: Error) => {
        logger.error("Binance WebSocket error", { error: String(error) });
        this.ws?.close();
      });
    } catch (error) {
      logger.error("Failed to create WebSocket connection", {
        error: String(error),
      });
      this.scheduleReconnect();
    }
  }

  private scheduleReconnect(): void {
    if (!this.isRunning) return;
    if (this.reconnectAttempts >= this.maxReconnectAttempts) {
      logger.warn(
        "Max Binance WebSocket reconnects reached; continuing with REST-only aggregation"
      );
      return;
    }

    const delay = Math.min(1000 * Math.pow(2, this.reconnectAttempts), 30000);
    this.reconnectAttempts++;
    logger.debug(`Reconnecting Binance WS in ${delay}ms (attempt ${this.reconnectAttempts})`);
    setTimeout(() => this.connectWebSocket(), delay);
  }
}
