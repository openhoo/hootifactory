import {
  and,
  db,
  eq,
  groupMemberships,
  inArray,
  isNull,
  or,
  permissionGrants,
} from "@hootifactory/db";
import type { PermissionKey } from "@hootifactory/types";
import { permissionImplies } from "./permissions";
import type { ResourceRef } from "./principal";
import { patternMatches } from "./scope";

export type PermissionGrantRow = typeof permissionGrants.$inferSelect;
export type CreatePermissionGrantInput = typeof permissionGrants.$inferInsert;

export async function createPermissionGrant(
  input: CreatePermissionGrantInput,
): Promise<PermissionGrantRow> {
  const [grant] = await db.insert(permissionGrants).values(input).returning();
  if (!grant) throw new Error("failed to create permission grant");
  return grant;
}

export async function replaceSubjectPermissionGrants(input: {
  orgId?: string | null;
  userId?: string | null;
  groupId?: string | null;
  tokenId?: string | null;
  grants: CreatePermissionGrantInput[];
}): Promise<void> {
  const subject = input.userId
    ? eq(permissionGrants.userId, input.userId)
    : input.groupId
      ? eq(permissionGrants.groupId, input.groupId)
      : input.tokenId
        ? eq(permissionGrants.tokenId, input.tokenId)
        : undefined;
  if (!subject) throw new Error("permission grant subject is required");
  await db.transaction(async (tx) => {
    await tx
      .delete(permissionGrants)
      .where(
        and(
          subject,
          input.orgId === undefined
            ? undefined
            : input.orgId === null
              ? isNull(permissionGrants.orgId)
              : eq(permissionGrants.orgId, input.orgId),
        ),
      );
    if (input.grants.length > 0) await tx.insert(permissionGrants).values(input.grants);
  });
}

export async function permissionGrantsForUser(
  userId: string,
  orgId?: string | null,
): Promise<PermissionGrantRow[]> {
  const direct = await db
    .select()
    .from(permissionGrants)
    .where(
      and(
        eq(permissionGrants.userId, userId),
        orgId ? or(eq(permissionGrants.orgId, orgId), isNull(permissionGrants.orgId)) : undefined,
      ),
    );
  if (!orgId) return direct;
  const memberships = await db
    .select({ groupId: groupMemberships.groupId })
    .from(groupMemberships)
    .where(and(eq(groupMemberships.userId, userId), eq(groupMemberships.orgId, orgId)));
  const groupIds = memberships.map((membership) => membership.groupId);
  if (groupIds.length === 0) return direct;
  const groupGrants = await db
    .select()
    .from(permissionGrants)
    .where(and(inArray(permissionGrants.groupId, groupIds), eq(permissionGrants.orgId, orgId)));
  return [...direct, ...groupGrants];
}

export async function permissionGrantsForToken(tokenId: string): Promise<PermissionGrantRow[]> {
  return db.select().from(permissionGrants).where(eq(permissionGrants.tokenId, tokenId));
}

function scopeMatches(grant: PermissionGrantRow, resource: ResourceRef): boolean {
  if (grant.permission === "system.admin") {
    return (
      grant.orgId === null &&
      grant.repositoryId === null &&
      grant.repositoryPattern === null &&
      grant.packagePattern === null &&
      grant.artifactPattern === null &&
      grant.policy === null &&
      grant.tokenTarget === null &&
      grant.targetTokenId === null
    );
  }
  if (!grant.orgId || grant.orgId !== resource.orgId) return false;
  if (grant.repositoryId && grant.repositoryId !== resource.repositoryId) return false;
  if (grant.repositoryPattern) {
    if (
      !resource.repositoryName ||
      !patternMatches(grant.repositoryPattern, resource.repositoryName)
    ) {
      return false;
    }
  }
  if (grant.packagePattern) {
    if (!resource.packageName || !patternMatches(grant.packagePattern, resource.packageName)) {
      return false;
    }
  }
  if (grant.artifactPattern) {
    if (!resource.artifactRef || !patternMatches(grant.artifactPattern, resource.artifactRef)) {
      return false;
    }
  }
  if (grant.policy && grant.policy !== "*" && grant.policy !== resource.policy) return false;
  if (grant.tokenTarget && grant.tokenTarget !== resource.tokenTarget) return false;
  if (grant.targetTokenId && grant.targetTokenId !== resource.tokenId) return false;
  return true;
}

export function permissionGrantAllows(
  grant: PermissionGrantRow,
  required: PermissionKey,
  resource: ResourceRef,
): boolean {
  return permissionImplies(grant.permission, required) && scopeMatches(grant, resource);
}

export function permissionGrantsAllow(
  grants: PermissionGrantRow[],
  required: PermissionKey,
  resource: ResourceRef,
): boolean {
  return grants.some((grant) => permissionGrantAllows(grant, required, resource));
}
