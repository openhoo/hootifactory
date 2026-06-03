import type { Context } from "hono";
import type { AppEnv } from "./types";

export const UNKNOWN_CLIENT_IP = "unknown";

export function clientIp(_c: Context<AppEnv>): string {
  return UNKNOWN_CLIENT_IP;
}
