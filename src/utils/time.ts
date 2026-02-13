/**
 * Get the current 5-minute window boundaries.
 * Polymarket 5-min markets run from :00 to :55 every hour,
 * each covering a discrete 5-minute period.
 */
export function getCurrentFiveMinWindow(): {
  startTime: number;
  endTime: number;
} {
  const now = Math.floor(Date.now() / 1000);
  // Round down to nearest 5-minute boundary
  const startTime = now - (now % 300);
  const endTime = startTime + 300;
  return { startTime, endTime };
}

/**
 * Get the next upcoming 5-minute window.
 */
export function getNextFiveMinWindow(): { startTime: number; endTime: number } {
  const current = getCurrentFiveMinWindow();
  return {
    startTime: current.endTime,
    endTime: current.endTime + 300,
  };
}

/**
 * Seconds remaining in the current 5-minute window.
 */
export function secondsRemainingInWindow(): number {
  const { endTime } = getCurrentFiveMinWindow();
  return endTime - Math.floor(Date.now() / 1000);
}

/**
 * Format a Unix timestamp as an ISO string.
 */
export function formatTimestamp(unixSeconds: number): string {
  return new Date(unixSeconds * 1000).toISOString();
}

/**
 * Build the market slug for a BTC 5-min up/down market.
 * Polymarket uses slugs like: btc-updown-5m-{timestamp}
 */
export function buildMarketSlug(
  asset: string,
  intervalMinutes: number,
  startTimestamp: number
): string {
  return `${asset.toLowerCase()}-updown-${intervalMinutes}m-${startTimestamp}`;
}
