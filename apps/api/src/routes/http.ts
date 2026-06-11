import { type AuditEntry, writeAudit } from "@hootifactory/auth";
import { logger } from "@hootifactory/observability";

export { AUDIT_RESULT } from "@hootifactory/types";

import type { Context } from "hono";
import { clientIpOrUndefined } from "../request-ip";
import type { AppEnv } from "../types";

/**
 * Fire-and-forget audit write. Auditing must never fail a request, so the
 * promise is intentionally not awaited and failures are logged best-effort.
 * The client IP is derived from the request unless the entry already set one.
 */
export function audit(c: Context<AppEnv>, entry: AuditEntry): void {
  const enriched: AuditEntry =
    entry.ip === undefined ? { ...entry, ip: clientIpOrUndefined(c) } : entry;
  void writeAudit(enriched).catch((err) => {
    logger.warn("audit write failed", {
      action: entry.action,
      orgId: entry.orgId,
      resourceType: entry.resourceType,
      resourceId: entry.resourceId,
      error: err,
    });
  });
}
