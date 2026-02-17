# Dashboard Deployment Guide

This document explains how the dashboard is deployed on Railway.

## Architecture

- **Bot Server**: Node.js/TypeScript server that runs the trading bot
- **Dashboard**: React/Vite frontend that connects to the bot via WebSocket
- **Deployment**: Single Railway service that serves both the bot API and the dashboard frontend

## How It Works

1. **Build Process**: When Railway builds the project, it runs `npm run build` which:
   - Builds the bot TypeScript code (`npm run build:bot`)
   - Builds the dashboard React app (`npm run build:dashboard`)
   - The dashboard is built to `dashboard/dist/` as static files

2. **Runtime**: When the bot starts (`node dist/index.js`):
   - The bot server starts on the `PORT` environment variable (set by Railway)
   - The `DashboardServer` serves static files from `dashboard/dist/` via HTTP
   - WebSocket connections are handled on the same port for real-time data

3. **WebSocket Connection**: The dashboard automatically connects to:
   - Production: `wss://your-domain.railway.app` (or `ws://` if not HTTPS)
   - Development: `ws://localhost:8765` (or `VITE_WS_URL` env var)

## Railway Configuration

The `railway.json` file configures:
- **Build Command**: `npm run build` (builds both bot and dashboard)
- **Start Command**: `node dist/index.js` (starts the bot server)
- **Health Check**: `/` (serves the dashboard index.html)

## Environment Variables

- `PORT`: Set automatically by Railway (used for both HTTP and WebSocket)
- `DASHBOARD_WS_PORT`: Used for local development (defaults to 8765)
- `VITE_WS_URL`: Optional override for dashboard WebSocket URL

## Local Development

For local development, run:
```bash
npm run dev
```

This starts both:
- Bot server on port 8765 (or DASHBOARD_WS_PORT)
- Dashboard dev server on port 5173 (Vite default)

## Troubleshooting

### Dashboard not loading
- Check that `dashboard/dist/` exists after build
- Verify Railway build logs show successful dashboard build
- Check that `PORT` environment variable is set

### WebSocket connection fails
- Verify the dashboard is using the correct protocol (wss:// for HTTPS, ws:// for HTTP)
- Check Railway logs for WebSocket connection errors
- Ensure `PORT` is being used (not hardcoded port numbers)

### Static files not found
- Verify `dashboard/dist/` is built during Railway build
- Check file paths in `dashboard-server.ts` match the build output
- Ensure `.gitignore` doesn't exclude necessary files
