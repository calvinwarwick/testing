/** Core types for the Polymarket arbitrage bot */

export interface BotConfig {
  /** Polymarket CLOB API base URL */
  polymarketApiUrl: string;
  /** Polymarket Gamma API base URL */
  polymarketGammaUrl: string;
  /** Polygon wallet private key for signing trades */
  polygonPrivateKey: string;
  /** Polygon RPC URL */
  polygonRpcUrl: string;
  /** Binance API key (read-only for price feeds) */
  binanceApiKey: string;
  /** Binance API secret */
  binanceApiSecret: string;
  /** Minimum profit in cents to trigger a trade */
  minProfitThresholdCents: number;
  /** Maximum position size in USDC per trade */
  maxPositionSizeUsdc: number;
  /** How often to poll for prices (ms) */
  pollIntervalMs: number;
  /** If true, log trades but don't execute */
  dryRun: boolean;
  /** Optional: initial BTC 5-min event slug (e.g. btc-updown-5m-1771026600) to track this and subsequent windows */
  btc5mEventSlug?: string;
  /** Optional: WebSocket port for dashboard (0 = disabled) */
  dashboardWsPort?: number;
  /** Max concurrent open positions (default 3). Positions are released when their market window ends. */
  maxOpenPositions?: number;
  /** Path to session persistence file (e.g. data/session.json) */
  sessionFile?: string;
  /** Max profit % before treating as suspicious data error (default 50) */
  maxProfitPercentBeforeSuspicious?: number;
  /** Min ms between trades (default 2000) */
  minTimeBetweenTradesMs?: number;
  /** If true, only take pure arbitrage (yes+no < $1); skip directional opportunities */
  pureArbOnly?: boolean;
  /** If true, only take directional trades (exchange vs Polymarket); skip pure arbitrage */
  directionalOnly?: boolean;
  /** Min edge % for directional opportunities (default 10). Only enter when edge is clearly there. */
  minEdgePercent?: number;
  /** Exchange price must move this % vs window start for UP/DOWN signal (default 0.03 = 3%). Higher = fewer, stronger signals. */
  exchangeSignalThresholdPercent?: number;
  /** For directional, require at least this % exchange move (default 0.15). Avoids trading on noise. */
  minExchangeMovePercent?: number;
  /** Don't open new directional trades when less than this many seconds left in window (default 120 = 2 min). */
  minSecondsRemainingInWindow?: number;
  /** Demo starting balance in USD when dry run (default 1000). Used for display and 5% max per trade. */
  demoStartingBalance?: number;
}

/** Persisted session state for cross-restart tracking. */
export interface PersistedSession {
  totalProfit: number;
  totalTradesExecuted: number;
  /** Trades with known positive profit (pure arb: actualProfit > 0; directional: when settlement tracked) */
  profitableTrades?: number;
  firstRunAt?: number;
  dailyPnL: number;
  dailyResetTime: number;
  lastSavedAt?: number;
}

/** A price quote from an exchange (Binance, Coinbase, etc.) */
export interface ExchangePrice {
  exchange: string;
  symbol: string;
  price: number;
  timestamp: number;
}

/** Polymarket 5-min market metadata */
export interface PolymarketMarket {
  /** The condition ID for this market */
  conditionId: string;
  /** Market slug (e.g., btc-updown-5m-1707840000) */
  slug: string;
  /** Human-readable question */
  question: string;
  /** CLOB token ID for the YES outcome */
  yesTokenId: string;
  /** CLOB token ID for the NO outcome */
  noTokenId: string;
  /** Market start time (Unix seconds) */
  startTime: number;
  /** Market end time (Unix seconds) */
  endTime: number;
  /** Whether the market is currently active/tradeable */
  active: boolean;
}

/** Price snapshot for a Polymarket binary market */
export interface MarketPrices {
  market: PolymarketMarket;
  /** Best ask price for YES token (cost to buy YES) */
  yesBestAsk: number;
  /** Best ask price for NO token (cost to buy NO) */
  noBestAsk: number;
  /** Best bid for YES (what you can sell YES for) */
  yesBestBid: number;
  /** Best bid for NO (what you can sell NO for) */
  noBestBid: number;
  /** Midpoint price for YES */
  yesMid: number;
  /** Midpoint price for NO */
  noMid: number;
  /** Timestamp of this snapshot */
  timestamp: number;
}

/** An arbitrage opportunity detected by the engine */
export interface ArbitrageOpportunity {
  market: PolymarketMarket;
  /** Total cost to buy 1 share of YES + 1 share of NO */
  totalCost: number;
  /** Guaranteed profit per share pair (1.00 - totalCost) */
  profitPerShare: number;
  /** Profit as a percentage */
  profitPercent: number;
  /** The YES ask price used */
  yesPrice: number;
  /** The NO ask price used */
  noPrice: number;
  /** Suggested number of share pairs to buy */
  suggestedSize: number;
  /** Total expected profit for the suggested size */
  totalExpectedProfit: number;
  /** Exchange BTC price at detection time */
  exchangePrice: ExchangePrice;
  /** Which direction the exchange price suggests */
  exchangeSignal: "UP" | "DOWN" | "NEUTRAL";
  /** BTC price at window start (for resolving directional PnL at settlement) */
  windowStartBtcPrice?: number;
  /** Time detected */
  detectedAt: number;
}

/** Result of an executed trade */
export interface TradeResult {
  success: boolean;
  orderId?: string;
  side: "YES" | "NO";
  price: number;
  size: number;
  filledSize?: number;
  error?: string;
  timestamp: number;
}

/** Combined result of an arbitrage execution (buying both sides) */
export interface ArbitrageExecution {
  opportunity: ArbitrageOpportunity;
  yesTrade: TradeResult;
  noTrade: TradeResult;
  /** Actual total cost paid */
  actualTotalCost: number;
  /** Actual profit locked in */
  actualProfit: number;
  /** Whether both sides filled successfully */
  fullyExecuted: boolean;
}

/** Order book level */
export interface OrderBookLevel {
  price: number;
  size: number;
}

/** Full order book for a token */
export interface OrderBook {
  tokenId: string;
  bids: OrderBookLevel[];
  asks: OrderBookLevel[];
  timestamp: number;
}

/** Direction signal based on exchange price vs market reference */
export type PriceDirection = "UP" | "DOWN" | "NEUTRAL";
