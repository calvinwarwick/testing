import winston from "winston";
import Transport from "winston-transport";

const { combine, timestamp, printf, colorize } = winston.format;

const botFormat = printf(({ level, message, timestamp, ...meta }) => {
  const metaStr = Object.keys(meta).length ? ` ${JSON.stringify(meta)}` : "";
  return `${timestamp} [${level}] ${message}${metaStr}`;
});

export interface DashboardLogEntry {
  level: string;
  message: string;
  timestamp: string;
  meta?: string;
}

let dashboardBroadcast: ((entry: DashboardLogEntry) => void) | null = null;

export function setDashboardLogBroadcast(fn: ((entry: DashboardLogEntry) => void) | null): void {
  dashboardBroadcast = fn;
}

class DashboardTransport extends Transport {
  log(
    info: { level: string; message: string; timestamp?: string; [key: string]: unknown },
    callback: () => void
  ): void {
    if (dashboardBroadcast) {
      const meta = Object.keys(info).filter(
        (k) => !["level", "message", "timestamp"].includes(k)
      );
      dashboardBroadcast({
        level: info.level,
        message: info.message,
        timestamp: (info.timestamp as string) ?? new Date().toISOString(),
        meta:
          meta.length
            ? JSON.stringify(Object.fromEntries(meta.map((k) => [k, info[k]])))
            : undefined,
      });
    }
    setImmediate(() => this.emit("logged", info));
    callback();
  }
}

export const logger = winston.createLogger({
  level: process.env.LOG_LEVEL || "info",
  format: combine(timestamp({ format: "YYYY-MM-DD HH:mm:ss.SSS" }), botFormat),
  transports: [
    new winston.transports.Console({
      format: combine(colorize(), timestamp({ format: "HH:mm:ss.SSS" }), botFormat),
    }),
    new winston.transports.File({
      filename: "bot-error.log",
      level: "error",
    }),
    new winston.transports.File({
      filename: "bot.log",
    }),
    new DashboardTransport(),
  ],
});
