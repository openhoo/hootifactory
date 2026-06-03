import {
  type AuditEntry,
  type Decision,
  httpStatusForDenial,
  writeAudit,
} from "@hootifactory/auth";
import { logger } from "@hootifactory/observability";
import type { Context } from "hono";
import type { AppEnv } from "../types";

/**
 * Fire-and-forget audit write. Auditing must never fail a request, so the
 * promise is intentionally not awaited and failures are logged best-effort.
 */
export function audit(entry: AuditEntry): void {
  void writeAudit(entry).catch((err) => {
    logger.warn("audit write failed", {
      action: entry.action,
      orgId: entry.orgId,
      resourceType: entry.resourceType,
      resourceId: entry.resourceId,
      error: err,
    });
  });
}

/**
 * Standard JSON error response for an authorization denial: unauthenticated
 * principals get 401 (re-auth), everything else 403.
 */
export function denied(c: Context<AppEnv>, decision: Decision): Response {
  return c.json({ error: decision.reason }, httpStatusForDenial(decision));
}
