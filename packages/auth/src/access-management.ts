import {
  and,
  apiTokens,
  db,
  desc,
  eq,
  groupMemberships,
  groups,
  ilike,
  inArray,
  memberships,
  notInArray,
  or,
  permissionGrants,
  sessions,
  users,
} from "@hootifactory/db";
import type { PermissionKey, TokenGrant } from "@hootifactory/types";
import { hashPassword } from "./password";
import { PERMISSION_DESCRIPTIONS, PERMISSIONS } from "./permissions";
import type { Principal } from "./principal";
import { randomSecret } from "./secret";
import { activeSessionsForUser } from "./sessions";
import { validateAssignablePermissionGrants } from "./token-grants";

export type UserRow = typeof users.$inferSelect;
export type GroupRow = typeof groups.$inferSelect;
export type GroupMembershipRow = typeof groupMemberships.$inferSelect;
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

export async function listUsers(input: { query?: string; limit: number; offset: number }) {
  const filters = input.query
    ? [
        ilike(users.username, `%${input.query}%`),
        ilike(users.email, `%${input.query}%`),
        ilike(users.displayName, `%${input.query}%`),
      ]
    : [];
  const where = filters.length > 0 ? or(...filters) : undefined;
  return db
    .select()
    .from(users)
    .where(where)
    .orderBy(desc(users.createdAt))
    .limit(input.limit)
    .offset(input.offset);
}

export async function getUserById(userId: string): Promise<UserRow | null> {
  const [user] = await db.select().from(users).where(eq(users.id, userId)).limit(1);
  return user ?? null;
}

export async function createAdminUser(input: {
  username: string;
  email: string;
  displayName?: string | null;
  passwordMode: "none" | "temporary";
}): Promise<{ user: UserRow; temporaryPassword: string | null }> {
  const temporaryPassword =
    input.passwordMode === "temporary" ? randomSecret("hoot_temp_").slice(0, 32) : null;
  const [user] = await db
    .insert(users)
    .values({
      username: input.username,
      email: input.email,
      displayName: input.displayName ?? null,
      passwordHash: temporaryPassword ? await hashPassword(temporaryPassword) : null,
    })
    .returning();
  if (!user) throw new Error("failed to create user");
  return { user, temporaryPassword };
}

export async function updateUserProfile(
  userId: string,
  input: { username?: string; email?: string; displayName?: string | null },
): Promise<UserRow | null> {
  const [user] = await db
    .update(users)
    .set({ ...input, updatedAt: new Date() })
    .where(eq(users.id, userId))
    .returning();
  return user ?? null;
}

export async function setTemporaryPassword(userId: string): Promise<string | null> {
  const temporaryPassword = randomSecret("hoot_temp_").slice(0, 32);
  const [user] = await db
    .update(users)
    .set({ passwordHash: await hashPassword(temporaryPassword), updatedAt: new Date() })
    .where(eq(users.id, userId))
    .returning({ id: users.id });
  return user ? temporaryPassword : null;
}

export async function setUserActive(userId: string, isActive: boolean): Promise<UserRow | null> {
  return db.transaction(async (tx) => {
    const [user] = await tx
      .update(users)
      .set({ isActive, updatedAt: new Date() })
      .where(eq(users.id, userId))
      .returning();
    if (!user) return null;
    if (!isActive) {
      await tx.update(sessions).set({ revokedAt: new Date() }).where(activeSessionsForUser(userId));
      await tx
        .update(apiTokens)
        .set({
          revokedAt: new Date(),
          revokedByUserId: userId,
          revocationReason: "owner deactivated",
          updatedAt: new Date(),
        })
        .where(eq(apiTokens.ownerUserId, userId));
      await tx.delete(groupMemberships).where(eq(groupMemberships.userId, userId));
      await tx.delete(memberships).where(eq(memberships.userId, userId));
      await tx.delete(permissionGrants).where(eq(permissionGrants.userId, userId));
    }
    return user;
  });
}

export async function listOrgMembers(orgId: string) {
  return db
    .select({ membership: memberships, user: users })
    .from(memberships)
    .innerJoin(users, eq(memberships.userId, users.id))
    .where(eq(memberships.orgId, orgId))
    .orderBy(desc(memberships.createdAt));
}

export async function addOrgMember(orgId: string, userId: string) {
  await db.insert(memberships).values({ orgId, userId }).onConflictDoNothing();
}

export async function removeOrgMember(orgId: string, userId: string) {
  await db.transaction(async (tx) => {
    await tx
      .delete(groupMemberships)
      .where(and(eq(groupMemberships.orgId, orgId), eq(groupMemberships.userId, userId)));
    await tx
      .delete(permissionGrants)
      .where(and(eq(permissionGrants.orgId, orgId), eq(permissionGrants.userId, userId)));
    await tx
      .delete(memberships)
      .where(and(eq(memberships.orgId, orgId), eq(memberships.userId, userId)));
  });
}

export async function listGroups(orgId: string) {
  return db.select().from(groups).where(eq(groups.orgId, orgId)).orderBy(desc(groups.createdAt));
}

export async function getGroupById(groupId: string): Promise<GroupRow | null> {
  const [group] = await db.select().from(groups).where(eq(groups.id, groupId)).limit(1);
  return group ?? null;
}

export async function getGroupInOrg(orgId: string, groupId: string): Promise<GroupRow | null> {
  const [group] = await db
    .select()
    .from(groups)
    .where(and(eq(groups.id, groupId), eq(groups.orgId, orgId)))
    .limit(1);
  return group ?? null;
}

export async function createGroup(input: {
  orgId: string;
  slug: string;
  displayName: string;
  description?: string | null;
}) {
  const [group] = await db.insert(groups).values(input).returning();
  if (!group) throw new Error("failed to create group");
  return group;
}

export async function updateGroup(
  orgId: string,
  groupId: string,
  input: { slug?: string; displayName?: string; description?: string | null },
) {
  const [group] = await db
    .update(groups)
    .set({ ...input, updatedAt: new Date() })
    .where(and(eq(groups.id, groupId), eq(groups.orgId, orgId)))
    .returning();
  return group ?? null;
}

export async function deleteGroup(orgId: string, groupId: string): Promise<boolean> {
  const deleted = await db
    .delete(groups)
    .where(and(eq(groups.id, groupId), eq(groups.orgId, orgId)))
    .returning({ id: groups.id });
  return deleted.length > 0;
}

export async function listGroupMembers(orgId: string, groupId: string) {
  return db
    .select({ membership: groupMemberships, user: users })
    .from(groupMemberships)
    .innerJoin(users, eq(groupMemberships.userId, users.id))
    .where(and(eq(groupMemberships.orgId, orgId), eq(groupMemberships.groupId, groupId)))
    .orderBy(desc(groupMemberships.createdAt));
}

export async function addGroupMember(input: {
  orgId: string;
  groupId: string;
  userId: string;
}): Promise<"added" | "group_not_found" | "user_not_member"> {
  return db.transaction(async (tx) => {
    const [group] = await tx
      .select({ id: groups.id })
      .from(groups)
      .where(and(eq(groups.id, input.groupId), eq(groups.orgId, input.orgId)))
      .limit(1);
    if (!group) return "group_not_found";

    const [membership] = await tx
      .select({ id: memberships.id })
      .from(memberships)
      .where(and(eq(memberships.orgId, input.orgId), eq(memberships.userId, input.userId)))
      .limit(1);
    if (!membership) return "user_not_member";

    await tx.insert(groupMemberships).values(input).onConflictDoNothing();
    return "added";
  });
}

export async function removeGroupMember(orgId: string, groupId: string, userId: string) {
  await db
    .delete(groupMemberships)
    .where(
      and(
        eq(groupMemberships.orgId, orgId),
        eq(groupMemberships.groupId, groupId),
        eq(groupMemberships.userId, userId),
      ),
    );
}

export async function grantsForGroup(orgId: string, groupId: string) {
  return db
    .select()
    .from(permissionGrants)
    .where(and(eq(permissionGrants.orgId, orgId), eq(permissionGrants.groupId, groupId)));
}

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
