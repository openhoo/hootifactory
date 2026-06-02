import {
  type AuditEntry,
  type Decision,
  httpStatusForDenial,
  writeAudit,
} from "@hootifactory/auth";
import type { Context } from "hono";
import type { AppEnv } from "../types";

/**
 * Fire-and-forget audit write. Auditing must never fail a request, so the
 * promise is intentionally not awaited and its errors are swallowed.
 */
export function audit(entry: AuditEntry): void {
  void writeAudit(entry).catch(() => {});
}

/**
 * Standard JSON error response for an authorization denial: unauthenticated
 * principals get 401 (re-auth), everything else 403.
 */
export function denied(c: Context<AppEnv>, decision: Decision): Response {
  return c.json({ error: decision.reason }, httpStatusForDenial(decision));
}
