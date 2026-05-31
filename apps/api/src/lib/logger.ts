import { env } from "@hootifactory/config";
import type { Logger } from "@hootifactory/core";

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 } as const;
const threshold = LEVELS[env.LOG_LEVEL];

function emit(level: keyof typeof LEVELS, msg: string, meta?: unknown): void {
  if (LEVELS[level] < threshold) return;
  const line: Record<string, unknown> = { t: new Date().toISOString(), level, msg };
  if (meta !== undefined) line.meta = meta;
  // eslint-disable-next-line no-console
  console.log(JSON.stringify(line));
}

export const logger: Logger = {
  debug: (msg, meta) => emit("debug", msg, meta),
  info: (msg, meta) => emit("info", msg, meta),
  warn: (msg, meta) => emit("warn", msg, meta),
  error: (msg, meta) => emit("error", msg, meta),
};
