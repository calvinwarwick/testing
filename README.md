# Polymarket 5-Minute BTC Directional Edge Bot

This bot is focused on a single strategy: **Directional Edge** on Polymarket BTC 5-minute markets.

It compares fast exchange BTC movement to Polymarket YES/NO pricing and enters only when the observed edge is strong enough.

## Strategy Focus: Directional Edge

Polymarket 5-minute BTC markets resolve to either:
- **UP / YES wins** if BTC ends above the window start reference
- **DOWN / NO wins** if BTC ends below the window start reference

The bot:
1. Captures BTC reference at window start
2. Tracks live exchange BTC price
3. Reads Polymarket YES/NO order books
4. Computes directional edge
5. Buys the single side (YES or NO) when thresholds pass

This repository is documented and tuned around directional execution only.

## Architecture

```
┌─────────────────┐     ┌──────────────────────┐
│  Binance WS     │────▶│  Exchange Feed        │
│  (BTC/USDT)     │     │  (real-time price)    │
└─────────────────┘     └──────────┬────────────┘
                                   │
┌─────────────────┐     ┌──────────▼────────────┐
│  Polymarket     │────▶│  Directional Detector  │
│  Gamma + CLOB   │     │  (edge + signal)       │
└─────────────────┘     └──────────┬────────────┘
                                   │
                        ┌──────────▼────────────┐
                        │  Risk Manager          │
                        │  • position caps       │
                        │  • spacing/rate limits │
                        │  • stop-loss handling  │
                        └──────────┬────────────┘
                                   │
                        ┌──────────▼────────────┐
                        │  Trader                │
                        │  • directional orders  │
                        │  • dry-run/live modes  │
                        └────────────────────────┘
```

## Project Structure

```
src/
├── index.ts                 # Entry point
├── bot.ts                   # Main orchestrator (discover → monitor → detect → execute)
├── config.ts                # Environment config loader
├── types.ts                 # Shared interfaces
├── feeds/
│   ├── exchange-feed.ts     # Exchange BTC pricing feed
│   └── polymarket-feed.ts   # Polymarket market + order book feed
├── arbitrage/
│   └── detector.ts          # Directional edge detection logic
├── execution/
│   └── trader.ts            # Directional order execution
└── utils/
    ├── logger.ts            # Logging + persistence
    ├── risk.ts              # Risk management
    └── time.ts              # 5-minute window helpers
```

## Setup

### Prerequisites

- Node.js 18+
- Binance market data access (public WS is enough)
- Polygon wallet + USDC only if using live order placement

### Install

```bash
npm install
cp .env.example .env
```

## Core Configuration

Directional behavior is controlled primarily by:

- `DIRECTIONAL_ONLY=true`
- `MIN_EDGE_PERCENT`
- `EXCHANGE_SIGNAL_THRESHOLD_PERCENT`
- `MIN_EXCHANGE_MOVE_PERCENT`
- `MIN_SECONDS_REMAINING_IN_WINDOW`
- `MAX_POSITION_SIZE_USDC`
- `MAX_OPEN_POSITIONS`
- `MIN_TIME_BETWEEN_TRADES_MS`

Data mode controls:

- `DRY_RUN=true|false`
- `FORCE_REAL_DATA=true|false`
- `SIMULATE_MARKETS=false` (recommended for realistic testing)

## Usage

### Recommended: Live Data + Demo Trading

```bash
DRY_RUN=true FORCE_REAL_DATA=true npm run dev
```

### Live Trading

```bash
DRY_RUN=false FORCE_REAL_DATA=true npm run dev
```

### Dashboard

Run the dashboard alongside the bot:

```bash
npm run dashboard
```

Open:
- `http://localhost:5173`

The dashboard connects to bot WebSocket state/logs (default `ws://localhost:8765`).

### Tests

```bash
npm test
```

## Risk Controls

The bot enforces:

- Max notional per trade
- Max open positions
- Minimum time between trades
- Per-minute rate limiting
- Directional entry window cutoff
- Stop-loss exit logic

## Disclaimer

This software is for research and educational use. Prediction market trading carries real risk. Start in dry-run mode and verify behavior before enabling live execution.
