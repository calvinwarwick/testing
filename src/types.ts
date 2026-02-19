/** Core types for the Polymarket directional (5-min BTC up/down) bot */

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
  /** Min ms between trades (default 1000) */
  minTimeBetweenTradesMs?: number;
  /** Max trades per minute (default 50). Rate limit to prevent runaway trading. */
  maxTradesPerMinute?: number;
  /** If true, only take directional trades (exchange vs Polymarket). */
  directionalOnly?: boolean;
  /** Min edge % for directional opportunities (default 5). Only enter when edge is clearly there. */
  minEdgePercent?: number;
  /** Exchange price must move this % vs window start for UP/DOWN signal (default 0.02). Higher = fewer, stronger signals. */
  exchangeSignalThresholdPercent?: number;
  /** For directional, require at least this % exchange move (default 0.03). Avoids trading on noise. */
  minExchangeMovePercent?: number;
  /** Don't open new directional trades when less than this many seconds left in window (default 15). */
  minSecondsRemainingInWindow?: number;
  /** Don't open new directional trades when more than this many seconds left (default 270; use 300 to allow first 60s). */
  maxSecondsRemainingInWindow?: number;
  /** Minimum estimated win probability to enter a trade (default 0.52 = 52%). Higher = more selective. */
  minWinProbability?: number;
  /** Demo starting balance in USD when dry run (default 1000). Used for display and 5% max per trade. */
  demoStartingBalance?: number;
  /** If true, refuse simulation fallback and require live Polymarket market data. */
  forceRealData?: boolean;
  /** Optional: Chainlink Data Streams API key (UUID). When set with chainlinkDsApiSecret, window start price is fetched from Chainlink to align with Polymarket. */
  chainlinkDsApiKey?: string;
  /** Optional: Chainlink Data Streams API secret for HMAC auth. */
  chainlinkDsApiSecret?: string;
  /** Optional: Chainlink Data Streams BTC/USD feed ID (hex). If unset and Chainlink is configured, resolved via listFeeds() or default constant. */
  chainlinkBtcUsdFeedId?: string;
  /** Fractional Kelly multiplier for position sizing (default 0.4). Range [0.05, 1.0]. */
  kellyMultiplier?: number;
  /** Stop loss threshold as % of entry cost (default 0.10 = 10% loss). Set to 0 to disable. */
  stopLossPercent?: number;
  /** Minimum shares available at best ask to consider a trade (default 30). */
  minAskSizeShares?: number;
  /** If true, allow endgame arb: buy near-certain side close to resolution (default true). */
  endgameArbEnabled?: boolean;
  /** Only consider endgame when this many seconds or fewer remain (default 60). */
  endgameMaxSecondsRemaining?: number;
  /** Require at least this many seconds left for execution (default 5). */
  endgameMinSecondsRemaining?: number;
  /** Endgame: target side must be at least this price, e.g. 0.85 (default 0.85). */
  endgameMinProbability?: number;
  /** Endgame: pay at most this price so we have profit if we win, e.g. 0.98 (default 0.98). */
  endgameMaxAsk?: number;
}

/** Persisted session state for cross-restart tracking. */
export interface PersistedSession {
  totalProfit: number;
  totalTradesExecuted: number;
  /** Trades with known positive profit (when settlement tracked) */
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
  /** Optional market traded volume in USD (from Gamma metadata). */
  volumeUsd?: number;
  /** Optional market liquidity in USD (from Gamma metadata). */
  liquidityUsd?: number;
}

/** Price snapshot for a Polymarket binary market */
export interface MarketPrices {
  market: PolymarketMarket;
  /** Best ask price for YES token (cost to buy YES) */
  yesBestAsk: number;
  /** Size available at best YES ask */
  yesBestAskSize?: number;
  /** Best ask price for NO token (cost to buy NO) */
  noBestAsk: number;
  /** Size available at best NO ask */
  noBestAskSize?: number;
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
  /** When set, distinguishes endgame vs directional for time-window and reporting. */
  opportunityType?: "directional" | "endgame";
  /** Kelly Criterion optimal fraction of bankroll (0..1) */
  kellyFraction?: number;
  /** Estimated win probability used for Kelly calculation */
  estimatedWinProbability?: number;
  /** Estimated dynamic taker fee as a percentage (e.g. 3.15 = 3.15%) */
  estimatedFeePercent?: number;
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
  /** True once settlement/exit has been accounted exactly once */
  settled?: boolean;
  /** True when window has ended but settlement is still pending (position released from open count) */
  pendingSettlement?: boolean;
  /** Set when a directional loss was capped by stop-loss (dashboard can show "capped") */
  lossCapped?: boolean;
  /** Set when a position was exited early to lock in profit (trailing take-profit) */
  profitTaken?: boolean;
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

/** Trade record for persistent logging */
export interface TradeRecord {
  id: string;
  timestamp: number;
  marketSlug: string;
  side: "UP" | "DOWN";
  type: "directional" | "arbitrage";
  entryPrice: number;
  size: number;
  cost: number;
  settled: boolean;
  settledAt?: number;
  profit?: number;
  outcome?: "win" | "loss";
  marketWindowStart: number;
  marketWindowEnd: number;
  btcPriceAtEntry: number;
  /** BTC price at official window start (for correct resolution); set for directional trades */
  btcPriceAtWindowStart?: number;
  btcPriceAtSettlement?: number;
  /** True if position was closed by stop-loss (not held to resolution) */
  lossCapped?: boolean;
  /** True if position was exited early by trailing take-profit */
  profitTaken?: boolean;
  /** Kelly Criterion fraction used for sizing this trade */
  kellyFraction?: number;
  /** Estimated win probability at entry */
  estimatedWinProbability?: number;
}
