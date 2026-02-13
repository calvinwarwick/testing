# Polymarket 5-Minute Crypto Arbitrage Bot

An arbitrage bot that exploits price delays between crypto exchanges (Binance) and Polymarket's 5-minute BTC prediction markets. When the combined cost of YES + NO tokens is less than $1.00, the bot buys both sides to lock in guaranteed profit.

## How It Works

### The Arbitrage

Polymarket's 5-minute crypto markets are binary markets — they resolve to either YES ($1.00) or NO ($1.00). Together, one YES + one NO token is always worth exactly $1.00 after resolution.

```
If YES costs $0.48 and NO costs $0.48:
  Total cost = $0.96
  Guaranteed payout = $1.00
  Profit = $0.04 per share pair (4.17%)
```

### The Price Delay

Crypto exchanges (Binance) update BTC prices in **milliseconds** via WebSocket feeds. Polymarket markets depend on oracle networks (Chainlink/UMA) which update in **seconds to minutes**. During this delay window, market makers on Polymarket may not have adjusted their quotes, creating temporary mispricings where both sides are cheap.

### Architecture

```
┌─────────────────┐     ┌──────────────────────┐
│  Binance WS     │────▶│  Exchange Feed        │
│  (BTC/USDT)     │     │  (real-time price)    │
└─────────────────┘     └──────────┬───────────-┘
                                   │
                        ┌──────────▼───────────-┐
                        │  Arbitrage Detector    │
                        │  • Pure arb (Y+N<$1)   │
                        │  • Directional edge    │
                        └──────────┬───────────-┘
                                   │
┌─────────────────┐     ┌──────────▼───────────-┐
│  Polymarket     │────▶│  Polymarket Feed       │
│  CLOB API       │     │  (YES/NO order books)  │
└─────────────────┘     └──────────┬───────────-┘
                                   │
                        ┌──────────▼───────────-┐
                        │  Risk Manager          │
                        │  • Position limits     │
                        │  • Daily loss cap      │
                        │  • Rate limiting       │
                        └──────────┬───────────-┘
                                   │
                        ┌──────────▼───────────-┐
                        │  Trader                │
                        │  • EIP-712 signing     │
                        │  • CLOB order placement│
                        │  • Concurrent execution│
                        └────────────────────────┘
```

## Project Structure

```
src/
├── index.ts                 # Entry point
├── bot.ts                   # Main orchestrator (discover → monitor → detect → execute)
├── config.ts                # Environment config loader
├── types.ts                 # TypeScript interfaces
├── feeds/
│   ├── exchange-feed.ts     # Binance BTC/USDT via WebSocket + REST fallback
│   └── polymarket-feed.ts   # Polymarket Gamma API (markets) + CLOB API (order books)
├── arbitrage/
│   └── detector.ts          # Arb detection: pure (Y+N<$1) and directional
├── execution/
│   └── trader.ts            # Polymarket CLOB order placement + EIP-712 signing
└── utils/
    ├── logger.ts            # Winston logger (console + file)
    ├── risk.ts              # Risk management (position/loss limits, rate limiting)
    └── time.ts              # 5-minute window helpers
```

## Setup

### Prerequisites

- Node.js 18+
- A Polygon wallet with USDC (for live trading)
- Binance API key (read-only, for price feeds)

### Installation

```bash
npm install
```

### Configuration

Copy the example env and fill in your keys:

```bash
cp .env.example .env
```

| Variable | Description | Required |
|----------|-------------|----------|
| `POLYGON_PRIVATE_KEY` | Wallet private key for Polymarket | Yes (live mode) |
| `POLYGON_RPC_URL` | Polygon RPC endpoint | No (defaults to polygon-rpc.com) |
| `BINANCE_API_KEY` | Binance API key (read-only) | No (WebSocket is public) |
| `MIN_PROFIT_THRESHOLD_CENTS` | Minimum profit in cents to trigger trade | No (default: 2) |
| `MAX_POSITION_SIZE_USDC` | Max USDC per trade | No (default: 100) |
| `POLL_INTERVAL_MS` | Price polling interval | No (default: 1000) |
| `DRY_RUN` | Paper trading mode | No (default: true) |

## Usage

### Dry Run (Paper Trading)

```bash
# Monitors prices and logs opportunities without placing real orders
DRY_RUN=true npm run dev
```

### Live Trading

```bash
# Places real orders — requires funded wallet and allowances set
DRY_RUN=false npm run dev
```

### Run Tests

```bash
npm test
```

## Two Trading Strategies

### 1. Pure Arbitrage (Guaranteed Profit)

When `YES_ask + NO_ask < $1.00`, buy both sides simultaneously. One side will pay $1.00 after resolution. This is risk-free profit.

**When this happens:** Market makers haven't updated both sides of the book. During volatile moments, one side gets repriced but the other lags behind.

### 2. Directional Edge (Probabilistic Profit)

When exchange BTC price moves sharply but Polymarket hasn't adjusted:
- BTC jumps on Binance → Buy YES (currently underpriced)
- BTC drops on Binance → Buy NO (currently underpriced)

**When this happens:** Oracle latency means Polymarket's implied probability lags behind the exchange by several seconds.

## Risk Management

The bot enforces:
- **Max position size**: Caps USDC per trade
- **Max open positions**: Limits concurrent exposure
- **Daily loss cap**: Stops trading after daily losses exceed threshold
- **Rate limiting**: Prevents rapid-fire orders
- **Sanity checks**: Rejects opportunities with >20% profit (likely data errors)

## Disclaimer

This bot is for educational and research purposes. Trading on prediction markets involves financial risk. Always start with dry run mode and small position sizes. The authors are not responsible for any trading losses.
