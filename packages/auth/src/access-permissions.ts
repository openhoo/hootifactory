import { and, db, eq, inArray, notInArray, permissionGrants, users } from "@hootifactory/db";
import type { PermissionKey, TokenGrant } from "@hootifactory/types";
import { getGroupInOrg } from "./access-groups";
import { PERMISSION_DESCRIPTIONS, PERMISSIONS } from "./permissions";
import type { Principal } from "./principal";
import { validateAssignablePermissionGrants } from "./token-grants";

export type PermissionGrantRow = typeof permissionGrants.$inferSelect;
export const SYSTEM_ADMIN_BOOTSTRAP_SOURCE = "bootstrap";

export interface PermissionCatalogEntry {
  key: PermissionKey;
  description: string;
}

export const permissionCatalog: PermissionCatalogEntry[] = PERMISSIONS.map((key) => ({
  key,
  description: PERMISSION_DESCRIPTIONS[key],
}));

export function tokenGrantToPermissionGrant(input: {
  orgId: string;
  groupId?: string;
  userId?: string;
  tokenId?: string;
  grant: TokenGrant;
  grantedByUserId?: string | null;
}) {
  return {
    orgId: input.orgId,
    groupId: input.groupId ?? null,
    userId: input.userId ?? null,
    tokenId: input.tokenId ?? null,
    permission: input.grant.permission,
    repositoryPattern: input.grant.repository ?? null,
    packagePattern: input.grant.package ?? null,
    artifactPattern: input.grant.artifact ?? null,
    policy: input.grant.policy ?? null,
    tokenTarget: input.grant.tokenTarget ?? null,
    targetTokenId: input.grant.tokenId ?? null,
    grantedByUserId: input.grantedByUserId ?? null,
  };
}

export async function replaceGroupGrants(input: {
  orgId: string;
  groupId: string;
  principal: Principal;
  grants: TokenGrant[];
  grantedByUserId?: string | null;
}): Promise<
  { ok: true } | { ok: false; code: "group_not_found" | "invalid_grant"; error: string }
> {
  const group = await getGroupInOrg(input.orgId, input.groupId);
  if (!group) return { ok: false, code: "group_not_found", error: "group not found" };

  const validation = await validateAssignablePermissionGrants({
    principal: input.principal,
    orgId: input.orgId,
    grants: input.grants,
  });
  if (!validation.ok) return { ok: false, code: "invalid_grant", error: validation.error };

  await db.transaction(async (tx) => {
    await tx
      .delete(permissionGrants)
      .where(
        and(eq(permissionGrants.orgId, input.orgId), eq(permissionGrants.groupId, input.groupId)),
      );
    if (input.grants.length > 0) {
      await tx.insert(permissionGrants).values(
        input.grants.map((grant) =>
          tokenGrantToPermissionGrant({
            orgId: input.orgId,
            groupId: input.groupId,
            grant,
            grantedByUserId: input.grantedByUserId,
          }),
        ),
      );
    }
  });
  return { ok: true };
}

export async function bootstrapSystemAdmins(userIds: string[]): Promise<{
  granted: string[];
  revoked: string[];
  missing: string[];
}> {
  const desiredUserIds = [...new Set(userIds)];
  const existingUsers =
    desiredUserIds.length > 0
      ? await db.select({ id: users.id }).from(users).where(inArray(users.id, desiredUserIds))
      : [];
  const existingUserIds = new Set(existingUsers.map((user) => user.id));
  const missing = desiredUserIds.filter((userId) => !existingUserIds.has(userId));

  return db.transaction(async (tx) => {
    const existingAdminRows =
      existingUsers.length > 0
        ? await tx
            .select({ userId: permissionGrants.userId })
            .from(permissionGrants)
            .where(
              and(
                eq(permissionGrants.permission, "system.admin"),
                inArray(
                  permissionGrants.userId,
                  existingUsers.map((user) => user.id),
                ),
              ),
            )
        : [];
    const existingAdminUserIds = new Set(
      existingAdminRows.flatMap((grant) => (grant.userId ? [grant.userId] : [])),
    );
    const managedRows = await tx
      .select({ userId: permissionGrants.userId })
      .from(permissionGrants)
      .where(
        and(
          eq(permissionGrants.permission, "system.admin"),
          eq(permissionGrants.source, SYSTEM_ADMIN_BOOTSTRAP_SOURCE),
        ),
      );
    const managedUserIds = new Set(
      managedRows.flatMap((grant) => (grant.userId ? [grant.userId] : [])),
    );
    const revoked = [...managedUserIds].filter((userId) => !existingUserIds.has(userId));
    if (revoked.length > 0 && existingUsers.length > 0) {
      await tx.delete(permissionGrants).where(
        and(
          eq(permissionGrants.permission, "system.admin"),
          eq(permissionGrants.source, SYSTEM_ADMIN_BOOTSTRAP_SOURCE),
          notInArray(
            permissionGrants.userId,
            existingUsers.map((user) => user.id),
          ),
        ),
      );
    } else if (revoked.length > 0) {
      await tx
        .delete(permissionGrants)
        .where(
          and(
            eq(permissionGrants.permission, "system.admin"),
            eq(permissionGrants.source, SYSTEM_ADMIN_BOOTSTRAP_SOURCE),
          ),
        );
    }
    const granted = existingUsers
      .map((user) => user.id)
      .filter((userId) => !existingAdminUserIds.has(userId));
    if (granted.length > 0) {
      await tx.insert(permissionGrants).values(
        granted.map((userId) => ({
          userId,
          permission: "system.admin" as const,
          source: SYSTEM_ADMIN_BOOTSTRAP_SOURCE,
        })),
      );
    }

    return { granted, revoked, missing };
  });
}
