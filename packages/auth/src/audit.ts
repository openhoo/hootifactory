import { auditLog, db } from "@hootifactory/db";
import type { Principal } from "./principal";

export interface AuditEntry {
  orgId?: string | null;
  action: string;
  result: "allow" | "deny" | "success" | "failure";
  resourceType?: string;
  resourceId?: string;
  ip?: string;
  detail?: Record<string, unknown>;
  principal?: Principal;
}

export async function writeAudit(entry: AuditEntry): Promise<void> {
  const p = entry.principal;
  const actorUserId = p?.kind === "user" ? p.userId : p?.kind === "token" ? p.ownerUserId : null;
  const actorTokenId = p?.kind === "token" ? p.tokenId : null;
  const actorLabel =
    p?.kind === "user" ? p.username : p?.kind === "token" ? `token:${p.tokenId}` : "anonymous";

  await db.insert(auditLog).values({
    orgId: entry.orgId ?? null,
    actorUserId,
    actorTokenId,
    actorLabel,
    action: entry.action,
    resourceType: entry.resourceType,
    resourceId: entry.resourceId,
    result: entry.result,
    ip: entry.ip,
    detail: entry.detail ?? null,
  });
}
