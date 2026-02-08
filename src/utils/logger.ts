import { config } from "../config.js";

type LogLevel = "debug" | "info" | "warn" | "error";

const LOG_LEVELS: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

function shouldLog(level: LogLevel): boolean {
  return LOG_LEVELS[level] >= LOG_LEVELS[config.logLevel];
}

function formatMessage(level: LogLevel, message: string, meta?: object): string {
  const timestamp = new Date().toISOString();
  const metaStr = meta ? ` ${JSON.stringify(meta)}` : "";
  return `[${timestamp}] [${level.toUpperCase()}] ${message}${metaStr}`;
}

export const logger = {
  debug(message: string, meta?: object): void {
    if (shouldLog("debug")) {
      console.error(formatMessage("debug", message, meta));
    }
  },

  info(message: string, meta?: object): void {
    if (shouldLog("info")) {
      console.error(formatMessage("info", message, meta));
    }
  },

  warn(message: string, meta?: object): void {
    if (shouldLog("warn")) {
      console.error(formatMessage("warn", message, meta));
    }
  },

  error(message: string, meta?: object): void {
    if (shouldLog("error")) {
      console.error(formatMessage("error", message, meta));
    }
  },

  tool(
    toolName: string,
    params: object,
    durationMs: number,
    resultCount?: number
  ): void {
    if (shouldLog("info")) {
      const meta = {
        tool: toolName,
        params,
        duration_ms: durationMs,
        ...(resultCount !== undefined && { result_count: resultCount }),
      };
      console.error(formatMessage("info", `Tool call: ${toolName}`, meta));
    }
  },
};
