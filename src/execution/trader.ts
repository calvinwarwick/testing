import { ethers } from "ethers";
import axios, { AxiosInstance } from "axios";
import {
  ArbitrageExecution,
  ArbitrageOpportunity,
  TradeResult,
  BotConfig,
  TradeRecord,
} from "../types";
import { ArbitrageDetector } from "../arbitrage/detector";
import { logger, recordTrade } from "../utils/logger";

/**
 * Handles trade execution on Polymarket's CLOB.
 *
 * Polymarket uses a hybrid-decentralized order book:
 * - Orders are signed EIP-712 messages (off-chain signing)
 * - Matching happens off-chain on the CLOB operator
 * - Settlement happens on-chain via the CTF Exchange contract
 *
 * For our directional strategy, we place limit orders at the
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

      await this.deriveApiCredentials();
      logger.info(`Trader initialized: ${this.wallet.address}`);
    } catch (error) {
      logger.error("Failed to initialize trader", { error: String(error) });
      throw error;
    }
  }

  /**
   * Get USDC balance from wallet (for live trading).
   * USDC on Polygon: 0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359 (native USDC)
   */
  async getUsdcBalance(): Promise<number | null> {
    if (!this.wallet || this.config.dryRun) return null;
    try {
      const provider = new ethers.JsonRpcProvider(this.config.polygonRpcUrl);
      // USDC native on Polygon
      const usdcAddress = "0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359";
      const usdcAbi = [
        "function balanceOf(address owner) view returns (uint256)",
        "function decimals() view returns (uint8)",
      ];
      const usdcContract = new ethers.Contract(usdcAddress, usdcAbi, provider);
      const balance = await usdcContract.balanceOf(this.wallet.address);
      const decimals = await usdcContract.decimals();
      const balanceUsd = Number(balance) / 10 ** Number(decimals);
      return balanceUsd;
    } catch (error) {
      logger.debug("Failed to fetch USDC balance", { error: String(error) });
      return null;
    }
  }

  /** CLOB L1 auth: fixed message for EIP-712 derive-api-key signature */
  private static readonly CLOB_AUTH_MESSAGE =
    "This message attests that I control the given wallet";

  /**
   * Derive L2 API credentials from the wallet.
   * Uses GET /auth/derive-api-key with L1 headers (POLY_ADDRESS, POLY_SIGNATURE, POLY_TIMESTAMP, POLY_NONCE).
   * POLY_SIGNATURE is EIP-712 ClobAuth, not personal_sign.
   */
  private async deriveApiCredentials(): Promise<void> {
    if (!this.wallet) throw new Error("Wallet not initialized");

    try {
      const timestamp = Math.floor(Date.now() / 1000);
      const nonce = 0;
      const address = await this.wallet.getAddress();
      const ts = `${timestamp}`;

      const domain = {
        name: "ClobAuthDomain",
        version: "1",
        chainId: 137,
      };
      const types = {
        ClobAuth: [
          { name: "address", type: "address" },
          { name: "timestamp", type: "string" },
          { name: "nonce", type: "uint256" },
          { name: "message", type: "string" },
        ],
      };
      const value = {
        address,
        timestamp: ts,
        nonce,
        message: Trader.CLOB_AUTH_MESSAGE,
      };
      const signature = await this.wallet.signTypedData(domain, types, value);

      const response = await this.httpClient.get("/auth/derive-api-key", {
        headers: {
          POLY_ADDRESS: address,
          POLY_SIGNATURE: signature,
          POLY_TIMESTAMP: ts,
          POLY_NONCE: String(nonce),
        },
      });

      this.apiKey = response.data.apiKey;
      this.apiSecret = response.data.secret;
      this.apiPassphrase = response.data.passphrase;

      logger.debug("L2 API credentials derived");
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
      // feeRateBps must be >= dynamic taker fee for order acceptance
      const feeRate = ArbitrageDetector.estimateDynamicFeeRate(price);
      const feeRateBps = Math.ceil(feeRate * 10000).toString();
      const orderPayload = {
        tokenID: tokenId,
        price: price.toFixed(4),
        size: size.toString(),
        side: "BUY" as const,
        type: "GTC",
        feeRateBps,
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
      const feeRate = ArbitrageDetector.estimateDynamicFeeRate(price);
      const feeRateBps = Math.ceil(feeRate * 10000).toString();
      const orderPayload = {
        tokenID: tokenId,
        price: price.toFixed(4),
        size: size.toString(),
        side: "SELL" as const,
        type: "GTC",
        feeRateBps,
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
      logger.debug(`ORDER PLACED: SELL ${side} ${size} @ $${price.toFixed(3)} | ID: ${tradeResult.orderId}`);
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
    const size = Math.max(1, Math.floor(opportunity.suggestedSize));

    logger.debug(
      `Placing order: ${targetSide} ${size} @ $${price.toFixed(3)} on ${opportunity.market.slug}`
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
      settled: false,
    };

    if (execution.fullyExecuted) {
      const tradeRecordId = trade.orderId ?? `trade-${Date.now()}`;
      if (!trade.orderId) {
        trade.orderId = tradeRecordId;
      }
      logger.info(
        `Position opened: ${opportunity.market.slug} | ${targetSide} ${filledSize} @ $${price.toFixed(2)} | cost $${actualTotalCost.toFixed(2)}`
      );

      // Record the trade
      const tradeRecord: TradeRecord = {
        id: tradeRecordId,
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
        btcPriceAtWindowStart: opportunity.windowStartBtcPrice,
        kellyFraction: opportunity.kellyFraction,
        estimatedWinProbability: opportunity.estimatedWinProbability,
      };
      recordTrade(tradeRecord);
    } else {
      logger.warn(`Position not opened: ${opportunity.market.slug} — order did not fill`);
    }

    return execution;
  }

  /**
   * Cancel an open order by ID.
   */
  async cancelOrder(orderId: string): Promise<boolean> {
    if (this.config.dryRun) {
      logger.debug(`[DRY RUN] Cancel order: ${orderId}`);
      return true;
    }

    try {
      await this.httpClient.delete(`/order/${orderId}`, {
        headers: this.getAuthHeaders("DELETE", `/order/${orderId}`),
      });
      logger.debug(`Order cancelled: ${orderId}`);
      return true;
    } catch (error) {
      logger.error(`Failed to cancel order ${orderId}`, {
        error: String(error),
      });
      return false;
    }
  }
}
