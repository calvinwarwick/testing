import WebSocket from "ws";
import axios from "axios";
import { ExchangePrice } from "../types";
import { logger } from "../utils/logger";

/**
 * Fetches real-time BTC/USDT price from Binance.
 * Uses WebSocket for low-latency streaming with REST fallback.
 *
 * The key insight: exchange prices update faster than Polymarket's
 * oracle (Chainlink). We use the exchange price to predict the
 * 5-min candle direction before Polymarket prices adjust.
 */
export class ExchangeFeed {
  private ws: WebSocket | null = null;
  private latestPrice: ExchangePrice | null = null;
  private reconnectAttempts = 0;
  private maxReconnectAttempts = 10;
  private isRunning = false;

  private readonly binanceWsUrl =
    "wss://stream.binance.com:9443/ws/btcusdt@ticker";
  private readonly binanceRestUrl =
    "https://api.binance.com/api/v3/ticker/price?symbol=BTCUSDT";

  /**
   * Start the price feed. Connects via WebSocket with REST fallback.
   */
  async start(): Promise<void> {
    this.isRunning = true;
    logger.info("Starting exchange price feed (Binance BTC/USDT)");

    // Fetch an initial price via REST before WebSocket connects
    await this.fetchRestPrice();

    // Then start WebSocket for real-time updates
    this.connectWebSocket();
  }

  /**
   * Stop the price feed and close connections.
   */
  stop(): void {
    this.isRunning = false;
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
    logger.info("Exchange price feed stopped");
  }

  /**
   * Get the latest BTC price. Returns null if no price is available yet.
   */
  getLatestPrice(): ExchangePrice | null {
    return this.latestPrice;
  }

  /**
   * Fetch the current price via REST API (fallback / initial).
   */
  async fetchRestPrice(): Promise<ExchangePrice | null> {
    try {
      const response = await axios.get<{ symbol: string; price: string }>(
        this.binanceRestUrl,
        { timeout: 5000 }
      );
      const price: ExchangePrice = {
        exchange: "binance",
        symbol: "BTCUSDT",
        price: parseFloat(response.data.price),
        timestamp: Date.now(),
      };
      this.latestPrice = price;
      logger.debug(`REST price update: $${price.price}`);
      return price;
    } catch (error) {
      logger.error("Failed to fetch REST price from Binance", {
        error: String(error),
      });
      return null;
    }
  }

  /**
   * Connect to Binance WebSocket for real-time ticker updates.
   * The ticker stream gives us last price, bid/ask, and volume
   * with sub-second latency.
   */
  private connectWebSocket(): void {
    if (!this.isRunning) return;

    try {
      this.ws = new WebSocket(this.binanceWsUrl);

      this.ws.on("open", () => {
        logger.info("Binance WebSocket connected");
        this.reconnectAttempts = 0;
      });

      this.ws.on("message", (data: WebSocket.Data) => {
        try {
          const ticker = JSON.parse(data.toString());
          this.latestPrice = {
            exchange: "binance",
            symbol: "BTCUSDT",
            price: parseFloat(ticker.c), // 'c' = last price in ticker
            timestamp: Date.now(),
          };
        } catch {
          logger.warn("Failed to parse WebSocket ticker message");
        }
      });

      this.ws.on("close", () => {
        logger.warn("Binance WebSocket disconnected");
        this.scheduleReconnect();
      });

      this.ws.on("error", (error) => {
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

  /**
   * Schedule a reconnection attempt with exponential backoff.
   */
  private scheduleReconnect(): void {
    if (!this.isRunning) return;
    if (this.reconnectAttempts >= this.maxReconnectAttempts) {
      logger.error(
        "Max WebSocket reconnect attempts reached, falling back to REST polling"
      );
      this.startRestPolling();
      return;
    }

    const delay = Math.min(1000 * Math.pow(2, this.reconnectAttempts), 30000);
    this.reconnectAttempts++;
    logger.info(
      `Reconnecting WebSocket in ${delay}ms (attempt ${this.reconnectAttempts})`
    );
    setTimeout(() => this.connectWebSocket(), delay);
  }

  /**
   * Fall back to REST polling if WebSocket is unavailable.
   */
  private startRestPolling(): void {
    const poll = async () => {
      if (!this.isRunning) return;
      await this.fetchRestPrice();
      setTimeout(poll, 1000);
    };
    poll();
  }
}
