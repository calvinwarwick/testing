/**
 * Chainlink Data Streams feed for BTC/USD.
 * Uses the same feed Polymarket uses for resolution: BTC/USD Data Stream (RefPrice / CEX price).
 * @see https://data.chain.link/streams/btc-usd-cexprice-streams
 * Fetches price at a given Unix timestamp (e.g. window start/end). Resolves feed ID and decimals
 * from the API so prices match Polymarket resolution.
 * Requires CHAINLINK_DS_API_KEY and CHAINLINK_DS_API_SECRET when used.
 */

import { createClient, decodeReport } from "@chainlink/data-streams-sdk";
import type { DecodedV3Report } from "@chainlink/data-streams-sdk";
import type { Feed } from "@chainlink/data-streams-sdk";
import { logger } from "../utils/logger";

/** Fallback BTC/USD feed ID if listFeeds() cannot be used. Override via CHAINLINK_BTC_USD_FEED_ID. */
const DEFAULT_BTC_USD_FEED_ID = "0x000359843a543ee2deb684e7505fc3293734eff6b2d4b56975b8";

/** Fallback decimals when feed metadata is unavailable (Chainlink crypto streams typically use 8). */
const DEFAULT_PRICE_DECIMALS = 8;

let client: ReturnType<typeof createClient> | null = null;
let resolvedFeedId: string | null = null;
let resolvedDecimals: number = DEFAULT_PRICE_DECIMALS;
let decimalsResolved = false;
let initFeedIdOverride: string | undefined;

export function isChainlinkConfigured(): boolean {
  return client != null && resolvedFeedId != null;
}

/**
 * Resolve BTC/USD feed ID and decimals from Chainlink API (same feed as Polymarket resolution).
 * Uses listFeeds() to get the feed's decimals so prices match Polymarket.
 */
async function resolveBtcUsdFeed(): Promise<void> {
  if (!client || decimalsResolved) return;
  try {
    const feeds = (await client.listFeeds()) as Feed[];
    const preferredId = initFeedIdOverride?.trim();
    const btcUsd = feeds.find(
      (f) =>
        (preferredId && f.feedID?.toLowerCase() === preferredId.toLowerCase()) ||
        (!preferredId && (f.asset?.toUpperCase().includes("BTC") && f.quoteAsset?.toUpperCase().includes("USD"))) ||
        (!preferredId && f.name && /btc.*usd|BTC.*USD/i.test(f.name))
    );
    if (btcUsd) {
      if (!preferredId) resolvedFeedId = btcUsd.feedID;
      resolvedDecimals = typeof btcUsd.decimals === "number" && btcUsd.decimals >= 0 ? btcUsd.decimals : DEFAULT_PRICE_DECIMALS;
      logger.debug("Chainlink BTC/USD feed resolved", { feedID: resolvedFeedId, decimals: resolvedDecimals });
    }
  } catch (err) {
    logger.debug("Chainlink listFeeds failed, using default decimals", { error: String(err) });
    resolvedDecimals = DEFAULT_PRICE_DECIMALS;
  }
  decimalsResolved = true;
}

/**
 * Initialize the Chainlink client and optionally set BTC/USD feed ID.
 * Call once at startup when Chainlink credentials are set.
 */
export function initChainlinkFeed(
  apiKey: string,
  apiSecret: string,
  feedIdOverride?: string
): void {
  if (client) return;
  try {
    client = createClient({
      apiKey,
      userSecret: apiSecret,
      endpoint: "https://api.dataengine.chain.link",
      wsEndpoint: "wss://ws.dataengine.chain.link",
      timeout: 15000,
    });
    initFeedIdOverride = feedIdOverride;
    resolvedFeedId = feedIdOverride?.trim() || DEFAULT_BTC_USD_FEED_ID;
    logger.info("Chainlink Data Streams client initialized for window start price");
  } catch (err) {
    logger.warn("Chainlink Data Streams init failed", { error: String(err) });
    client = null;
    resolvedFeedId = null;
  }
}

/**
 * Get BTC/USD price at a given Unix timestamp (seconds).
 * Uses the same Chainlink Data Stream as Polymarket resolution; decimals are taken from feed metadata.
 * Returns null on error or if Chainlink is not configured.
 */
export async function getBtcPriceAtTimestamp(unixSeconds: number): Promise<number | null> {
  if (!client || !resolvedFeedId) return null;
  await resolveBtcUsdFeed();
  if (!resolvedFeedId) return null;
  try {
    const report = await client.getReportByTimestamp(resolvedFeedId, unixSeconds);
    const decoded = decodeReport(report.fullReport, report.feedID) as DecodedV3Report;
    if (decoded.version !== "V3" || decoded.price == null) {
      logger.debug("Chainlink report not V3 or missing price", {
        version: (decoded as { version?: string }).version,
      });
      return null;
    }
    const price = Number(decoded.price) / 10 ** resolvedDecimals;
    if (!Number.isFinite(price) || price <= 0) return null;
    return price;
  } catch (err) {
    logger.debug("Chainlink getReportByTimestamp failed", { unixSeconds, error: String(err) });
    return null;
  }
}
