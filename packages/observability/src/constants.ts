import type { LogLevel } from "./types";

export const INSTRUMENTATION_NAME = "hootifactory";

export const LOG_LEVELS = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
} satisfies Record<LogLevel, number>;
