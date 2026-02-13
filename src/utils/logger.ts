import winston from "winston";

const { combine, timestamp, printf, colorize } = winston.format;

const botFormat = printf(({ level, message, timestamp, ...meta }) => {
  const metaStr = Object.keys(meta).length ? ` ${JSON.stringify(meta)}` : "";
  return `${timestamp} [${level}] ${message}${metaStr}`;
});

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
  ],
});
