import {
  getCurrentFiveMinWindow,
  getNextFiveMinWindow,
  secondsRemainingInWindow,
  buildMarketSlug,
  formatTimestamp,
} from "../src/utils/time";

describe("Time Utilities", () => {
  describe("getCurrentFiveMinWindow", () => {
    it("should return a window with 300-second duration", () => {
      const { startTime, endTime } = getCurrentFiveMinWindow();
      expect(endTime - startTime).toBe(300);
    });

    it("should have startTime aligned to a 5-minute boundary", () => {
      const { startTime } = getCurrentFiveMinWindow();
      expect(startTime % 300).toBe(0);
    });

    it("should contain the current time", () => {
      const now = Math.floor(Date.now() / 1000);
      const { startTime, endTime } = getCurrentFiveMinWindow();
      expect(now).toBeGreaterThanOrEqual(startTime);
      expect(now).toBeLessThan(endTime);
    });
  });

  describe("getNextFiveMinWindow", () => {
    it("should start where current window ends", () => {
      const current = getCurrentFiveMinWindow();
      const next = getNextFiveMinWindow();
      expect(next.startTime).toBe(current.endTime);
    });

    it("should also be 300 seconds", () => {
      const { startTime, endTime } = getNextFiveMinWindow();
      expect(endTime - startTime).toBe(300);
    });
  });

  describe("secondsRemainingInWindow", () => {
    it("should return a positive number", () => {
      const remaining = secondsRemainingInWindow();
      expect(remaining).toBeGreaterThan(0);
    });

    it("should be at most 300 seconds", () => {
      const remaining = secondsRemainingInWindow();
      expect(remaining).toBeLessThanOrEqual(300);
    });
  });

  describe("buildMarketSlug", () => {
    it("should format slug correctly", () => {
      const slug = buildMarketSlug("BTC", 5, 1707840000);
      expect(slug).toBe("btc-updown-5m-1707840000");
    });

    it("should lowercase the asset", () => {
      const slug = buildMarketSlug("ETH", 5, 1234567890);
      expect(slug).toBe("eth-updown-5m-1234567890");
    });
  });

  describe("formatTimestamp", () => {
    it("should return an ISO string", () => {
      const formatted = formatTimestamp(1707840000);
      expect(formatted).toContain("2024");
      expect(formatted).toContain("T");
    });
  });
});
