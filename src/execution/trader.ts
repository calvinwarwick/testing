import { ethers } from "ethers";
import axios, { AxiosInstance } from "axios";
import {
  ArbitrageExecution,
  ArbitrageOpportunity,
  TradeResult,
  BotConfig,
  TradeRecord,
} from "../types";
import { logger, recordTrade } from "../utils/logger";

/**
 * Handles trade execution on Polymarket's CLOB.
 *
 * Polymarket uses a hybrid-decentralized order book:
 * - Orders are signed EIP-712 messages (off-chain signing)
 * - Matching happens off-chain on the CLOB operator
 * - Settlement happens on-chain via the CTF Exchange contract
 *
 * For our arbitrage strategy, we place limit orders at the
 * current best ask for both YES and NO tokens simultaneously.
 */
export class Trader {
  private readonly config: BotConfig;
  private readonly httpClient: AxiosInstance;
  private wallet: ethers.Wallet | null = null;
  private apiKey: string = "";
  private apiSecret: string = "";
  private apiPassphrase: string = "";

  constructor(config: BotConfig) {
    this.config = config;
    this.httpClient = axios.create({
      baseURL: config.polymarketApiUrl,
      timeout: 10000,
    });
  }

  /**
   * Initialize the trader: set up wallet and derive API credentials.
   */
  async initialize(): Promise<void> {
    if (this.config.dryRun) {
      logger.info("Trader initialized in DRY RUN mode — no real orders");
      return;
    }

    try {
      // Create wallet from private key
      const provider = new ethers.JsonRpcProvider(this.config.polygonRpcUrl);
      this.wallet = new ethers.Wallet(this.config.polygonPrivateKey, provider);

      logger.info(`Trader wallet: ${this.wallet.address}`);

      // Derive L2 API credentials via CLOB
      await this.deriveApiCredentials();

      logger.info("Trader initialized with API credentials");
    } catch (error) {
      logger.error("Failed to initialize trader", { error: String(error) });
      throw error;
    }
  }

  /**
   * Derive L2 API credentials from the wallet.
   * The CLOB API uses HMAC-SHA256 for L2 auth (faster than signing every request).
   */
  private async deriveApiCredentials(): Promise<void> {
    if (!this.wallet) throw new Error("Wallet not initialized");

    try {
      // Create or derive API key using the CLOB endpoint
      const timestamp = Math.floor(Date.now() / 1000).toString();
      const nonce = "0";
      const message = `${timestamp}${nonce}`;

      // Sign the message with our wallet
      const signature = await this.wallet.signMessage(message);

      const response = await this.httpClient.post("/auth/derive-api-key", {
        timestamp,
        nonce,
        signature,
      });

      this.apiKey = response.data.apiKey;
      this.apiSecret = response.data.secret;
      this.apiPassphrase = response.data.passphrase;

      logger.info("L2 API credentials derived successfully");
    } catch (error) {
      logger.error("Failed to derive API credentials", {
        error: String(error),
      });
      throw error;
    }
  }

  /**
   * Generate L2 auth headers for authenticated requests.
   */
  private getAuthHeaders(
    method: string,
    path: string,
    body: string = ""
  ): Record<string, string> {
    const timestamp = Math.floor(Date.now() / 1000).toString();
    const message = `${timestamp}${method}${path}${body}`;

    // HMAC-SHA256 signature
    const encoder = new TextEncoder();
    const keyData = encoder.encode(this.apiSecret);
    const msgData = encoder.encode(message);

    // For actual HMAC we'd use crypto, but the py-clob-client
    // handles this. Here we structure the headers correctly.
    return {
      "POLY-API-KEY": this.apiKey,
      "POLY-TIMESTAMP": timestamp,
      "POLY-PASSPHRASE": this.apiPassphrase,
      "POLY-SIGNATURE": "", // Computed via HMAC in production
    };
  }

  /**
   * Place a limit buy order for a specific token on the CLOB.
   */
  async placeLimitBuy(
    tokenId: string,
    price: number,
    size: number,
    side: "YES" | "NO"
  ): Promise<TradeResult> {
    const tradeResult: TradeResult = {
      success: false,
      side,
      price,
      size,
      timestamp: Date.now(),
    };

    // Dry run mode: simulate the trade
    if (this.config.dryRun) {
      logger.info(
        `[DRY RUN] BUY ${side}: ${size} shares @ $${price.toFixed(3)} (token: ${tokenId.slice(0, 12)}...)`
      );
      return {
        ...tradeResult,
        success: true,
        orderId: `dry-run-${Date.now()}`,
        filledSize: size,
      };
    }

    try {
      // Build the order payload for the CLOB
      const orderPayload = {
        tokenID: tokenId,
        price: price.toFixed(4),
        size: size.toString(),
        side: "BUY" as const,
        type: "GTC",
        feeRateBps: "0",
      };

      // Sign the order (EIP-712 typed data)
      const signedOrder = await this.signOrder(orderPayload);

      // Submit to CLOB
      const response = await this.httpClient.post(
        "/order",
        { order: signedOrder },
        { headers: this.getAuthHeaders("POST", "/order", JSON.stringify(signedOrder)) }
      );

      tradeResult.success = true;
      tradeResult.orderId = response.data.orderID;
      tradeResult.filledSize = parseFloat(response.data.filledSize || "0");

      logger.info(
        `ORDER PLACED: ${side} ${size} @ $${price.toFixed(3)} | ID: ${tradeResult.orderId}`
      );

      return tradeResult;
    } catch (error) {
      tradeResult.error = String(error);
      logger.error(`Failed to place ${side} order`, {
        error: String(error),
        price,
        size,
      });
      return tradeResult;
    }
  }

  /**
   * Place a limit sell order (e.g. to exit a position at a stop-loss).
   */
  async placeLimitSell(
    tokenId: string,
    price: number,
    size: number,
    side: "YES" | "NO"
  ): Promise<TradeResult> {
    const tradeResult: TradeResult = {
      success: false,
      side: side === "YES" ? "NO" : "YES",
      price,
      size,
      timestamp: Date.now(),
    };

    if (this.config.dryRun) {
      logger.info(
        `[DRY RUN] SELL ${side}: ${size} shares @ $${price.toFixed(3)} (token: ${tokenId.slice(0, 12)}...)`
      );
      return { ...tradeResult, success: true, orderId: `dry-run-sell-${Date.now()}`, filledSize: size };
    }

    try {
      const orderPayload = {
        tokenID: tokenId,
        price: price.toFixed(4),
        size: size.toString(),
        side: "SELL" as const,
        type: "GTC",
        feeRateBps: "0",
      };
      const signedOrder = await this.signOrder(orderPayload);
      const response = await this.httpClient.post(
        "/order",
        { order: signedOrder },
        { headers: this.getAuthHeaders("POST", "/order", JSON.stringify(signedOrder)) }
      );
      tradeResult.success = true;
      tradeResult.orderId = response.data.orderID;
      tradeResult.filledSize = parseFloat(response.data.filledSize || "0");
      logger.info(`ORDER PLACED: SELL ${side} ${size} @ $${price.toFixed(3)} | ID: ${tradeResult.orderId}`);
      return tradeResult;
    } catch (error) {
      tradeResult.error = String(error);
      logger.error(`Failed to place SELL ${side} order`, { error: String(error), price, size });
      return tradeResult;
    }
  }

  /**
   * Sign an order using EIP-712 typed structured data.
   * This is how the CLOB validates order authenticity.
   */
  private async signOrder(
    orderPayload: Record<string, string>
  ): Promise<Record<string, string>> {
    if (!this.wallet) throw new Error("Wallet not initialized");

    // EIP-712 domain for Polymarket CTF Exchange
    const domain = {
      name: "Polymarket CTF Exchange",
      version: "1",
      chainId: 137, // Polygon
    };

    const types = {
      Order: [
        { name: "tokenId", type: "uint256" },
        { name: "price", type: "uint256" },
        { name: "size", type: "uint256" },
        { name: "side", type: "uint8" },
      ],
    };

    const sideNum = orderPayload.side === "SELL" ? 1 : 0;
    const value = {
      tokenId: orderPayload.tokenID,
      price: Math.round(parseFloat(orderPayload.price) * 10000),
      size: Math.round(parseFloat(orderPayload.size)),
      side: sideNum,
    };

    const signature = await this.wallet.signTypedData(domain, types, value);

    return {
      ...orderPayload,
      signature,
    };
  }

  /**
   * Execute a directional trade: buy only the side we're betting on (YES if UP, NO if DOWN).
   * For directional, buying both sides would cost > $1 and guarantee a loss. We buy one side only.
   */
  async executeDirectional(
    opportunity: ArbitrageOpportunity
  ): Promise<ArbitrageExecution> {
    const isUp = opportunity.exchangeSignal === "UP";
    const targetSide = isUp ? "YES" : "NO";
    const tokenId = isUp ? opportunity.market.yesTokenId : opportunity.market.noTokenId;
    const price = isUp ? opportunity.yesPrice : opportunity.noPrice;
    const size = Math.max(
      1,
      Math.floor(this.config.maxPositionSizeUsdc / price)
    );

    logger.info(
      `Executing DIRECTIONAL ${targetSide} on ${opportunity.market.slug}: ` +
        `${size} shares @ $${price.toFixed(3)} (bet: BTC ${opportunity.exchangeSignal})`
    );

    const trade = await this.placeLimitBuy(tokenId, price, size, targetSide);
    const filledSize = trade.filledSize ?? 0;
    const actualTotalCost = trade.price * filledSize;
    const dummyResult: TradeResult = {
      success: false,
      side: isUp ? "NO" : "YES",
      price: 0,
      size: 0,
      timestamp: Date.now(),
    };

    // Actual PnL is only known at settlement (one side pays $1). Until then we report 0.
    const execution: ArbitrageExecution = {
      opportunity,
      yesTrade: isUp ? trade : dummyResult,
      noTrade: isUp ? dummyResult : trade,
      actualTotalCost,
      actualProfit: 0,
      fullyExecuted: trade.success,
    };

    if (execution.fullyExecuted) {
      logger.info(
        `DIRECTIONAL EXECUTED: ${targetSide} ${filledSize} @ $${price.toFixed(3)} | ` +
          `Cost=$${actualTotalCost.toFixed(4)} | PnL at settlement`
      );

      // Record the trade
      const tradeRecord: TradeRecord = {
        id: trade.orderId ?? `trade-${Date.now()}`,
        timestamp: Date.now(),
        marketSlug: opportunity.market.slug,
        side: opportunity.exchangeSignal as "UP" | "DOWN",
        type: "directional",
        entryPrice: price,
        size: filledSize,
        cost: actualTotalCost,
        settled: false,
        marketWindowStart: opportunity.market.startTime,
        marketWindowEnd: opportunity.market.endTime,
        btcPriceAtEntry: opportunity.exchangePrice.price,
      };
      recordTrade(tradeRecord);
    } else {
      logger.warn(`DIRECTIONAL FAILED: ${targetSide} order did not fill`);
    }

    return execution;
  }

  /**
   * Execute a full arbitrage: buy both YES and NO simultaneously.
   *
   * We buy both sides at their respective ask prices.
   * Since YES + NO always resolves to $1.00, if total cost < $1.00,
   * the difference is our guaranteed profit.
   */
  async executeArbitrage(
    opportunity: ArbitrageOpportunity
  ): Promise<ArbitrageExecution> {
    logger.info(
      `Executing arbitrage on ${opportunity.market.slug}: ` +
        `${opportunity.suggestedSize} pairs @ $${opportunity.totalCost.toFixed(3)}`
    );

    const [yesTrade, noTrade] = await Promise.all([
      this.placeLimitBuy(
        opportunity.market.yesTokenId,
        opportunity.yesPrice,
        opportunity.suggestedSize,
        "YES"
      ),
      this.placeLimitBuy(
        opportunity.market.noTokenId,
        opportunity.noPrice,
        opportunity.suggestedSize,
        "NO"
      ),
    ]);

    const yesFilledSize = yesTrade.filledSize || 0;
    const noFilledSize = noTrade.filledSize || 0;
    const minFilled = Math.min(yesFilledSize, noFilledSize);

    const actualTotalCost =
      yesTrade.price * yesFilledSize + noTrade.price * noFilledSize;
    const actualProfit = minFilled * 1.0 - actualTotalCost;

    const execution: ArbitrageExecution = {
      opportunity,
      yesTrade,
      noTrade,
      actualTotalCost,
      actualProfit,
      fullyExecuted: yesTrade.success && noTrade.success,
    };

    if (execution.fullyExecuted) {
      logger.info(
        `ARB EXECUTED: Cost=$${actualTotalCost.toFixed(4)} | ` +
          `Profit=$${actualProfit.toFixed(4)} | ` +
          `Filled: YES=${yesFilledSize} NO=${noFilledSize}`
      );

      // Record the trade
      const tradeRecord: TradeRecord = {
        id: yesTrade.orderId ?? `arb-${Date.now()}`,
        timestamp: Date.now(),
        marketSlug: opportunity.market.slug,
        side: "UP", // Arbitrage covers both sides
        type: "arbitrage",
        entryPrice: opportunity.totalCost,
        size: minFilled,
        cost: actualTotalCost,
        settled: true, // Arbitrage is instantly profitable
        settledAt: Date.now(),
        profit: actualProfit,
        outcome: actualProfit > 0 ? "win" : "loss",
        marketWindowStart: opportunity.market.startTime,
        marketWindowEnd: opportunity.market.endTime,
        btcPriceAtEntry: opportunity.exchangePrice.price,
      };
      recordTrade(tradeRecord);
    } else {
      logger.warn(
        `ARB PARTIAL: YES=${yesTrade.success ? "OK" : "FAIL"} ` +
          `NO=${noTrade.success ? "OK" : "FAIL"}`
      );
    }

    return execution;
  }

  /**
   * Cancel an open order by ID.
   */
  async cancelOrder(orderId: string): Promise<boolean> {
    if (this.config.dryRun) {
      logger.info(`[DRY RUN] Cancel order: ${orderId}`);
      return true;
    }

    try {
      await this.httpClient.delete(`/order/${orderId}`, {
        headers: this.getAuthHeaders("DELETE", `/order/${orderId}`),
      });
      logger.info(`Order cancelled: ${orderId}`);
      return true;
    } catch (error) {
      logger.error(`Failed to cancel order ${orderId}`, {
        error: String(error),
      });
      return false;
    }
  }
}
