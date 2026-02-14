import * as fs from "fs";
import * as path from "path";
import type { PersistedSession } from "./types";

/**
 * Load persisted session from disk. Returns null if file missing or invalid.
 */
export function loadSession(filePath: string): PersistedSession | null {
  try {
    const fullPath = path.resolve(filePath);
    if (!fs.existsSync(fullPath)) return null;
    const raw = fs.readFileSync(fullPath, "utf-8");
    const data = JSON.parse(raw) as unknown;
    if (typeof data !== "object" || data === null) return null;
    const s = data as Record<string, unknown>;
    if (
      typeof s.totalProfit !== "number" ||
      typeof s.totalTradesExecuted !== "number" ||
      typeof s.dailyPnL !== "number" ||
      typeof s.dailyResetTime !== "number"
    ) {
      return null;
    }
    return {
      totalProfit: s.totalProfit,
      totalTradesExecuted: s.totalTradesExecuted,
      profitableTrades: typeof s.profitableTrades === "number" ? s.profitableTrades : 0,
      firstRunAt: typeof s.firstRunAt === "number" ? s.firstRunAt : undefined,
      dailyPnL: s.dailyPnL,
      dailyResetTime: s.dailyResetTime,
      lastSavedAt: typeof s.lastSavedAt === "number" ? s.lastSavedAt : undefined,
    };
  } catch {
    return null;
  }
}

/**
 * Save session to disk atomically (write to temp file then rename).
 */
export function saveSession(filePath: string, data: PersistedSession): void {
  const fullPath = path.resolve(filePath);
  const dir = path.dirname(fullPath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  const payload: PersistedSession = {
    ...data,
    lastSavedAt: Date.now(),
  };
  const tmpPath = `${fullPath}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmpPath, JSON.stringify(payload, null, 2), "utf-8");
  fs.renameSync(tmpPath, fullPath);
}
