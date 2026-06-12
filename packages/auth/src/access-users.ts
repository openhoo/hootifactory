import {
  and,
  apiTokens,
  count,
  db,
  desc,
  eq,
  groupMemberships,
  groups,
  ilike,
  inArray,
  memberships,
  or,
  organizations,
  permissionGrants,
  repositories,
  sessions,
  userDeactivationSnapshots,
  users,
} from "@hootifactory/db";
import { hashPassword } from "./password";
import { randomSecret } from "./secret";
import { activeSessionsForUser } from "./sessions";

export type UserRow = typeof users.$inferSelect;

function userListFilter(query?: string) {
  if (!query) return undefined;
  return or(
    ilike(users.username, `%${query}%`),
    ilike(users.email, `%${query}%`),
    ilike(users.displayName, `%${query}%`),
  );
}

export async function listUsers(input: { query?: string; limit: number; offset: number }) {
  return db
    .select()
    .from(users)
    .where(userListFilter(input.query))
    .orderBy(desc(users.createdAt))
    .limit(input.limit)
    .offset(input.offset);
}

export async function countUsers(query?: string): Promise<number> {
  const rows = await db.select({ value: count() }).from(users).where(userListFilter(query));
  return rows[0]?.value ?? 0;
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
      email: input.email.toLowerCase(),
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
    .set({
      ...input,
      ...(input.email !== undefined ? { email: input.email.toLowerCase() } : {}),
      updatedAt: new Date(),
    })
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

/** The drizzle transaction handle passed to `db.transaction` callbacks. */
type DbTransaction = Parameters<Parameters<typeof db.transaction>[0]>[0];

function uniqueIds(ids: (string | null)[]): string[] {
  return [...new Set(ids.flatMap((id) => (id ? [id] : [])))];
}

/**
 * Capture the access a deactivation is about to delete so reactivation can
 * restore it. Insert-only on purpose: deactivating an already-deactivated
 * user keeps the original snapshot instead of overwriting it with the
 * now-empty state.
 */
async function snapshotAccessForDeactivation(tx: DbTransaction, userId: string): Promise<void> {
  const groupRows = await tx
    .select()
    .from(groupMemberships)
    .where(eq(groupMemberships.userId, userId));
  const membershipRows = await tx.select().from(memberships).where(eq(memberships.userId, userId));
  const grantRows = await tx
    .select()
    .from(permissionGrants)
    .where(eq(permissionGrants.userId, userId));
  await tx
    .insert(userDeactivationSnapshots)
    .values({
      userId,
      memberships: membershipRows.map((row) => ({ orgId: row.orgId })),
      groupMemberships: groupRows.map((row) => ({
        orgId: row.orgId,
        groupId: row.groupId,
        source: row.source,
        provider: row.provider,
        externalKey: row.externalKey,
      })),
      permissionGrants: grantRows.map((row) => ({
        orgId: row.orgId,
        permission: row.permission,
        repositoryId: row.repositoryId,
        repositoryPattern: row.repositoryPattern,
        packagePattern: row.packagePattern,
        artifactPattern: row.artifactPattern,
        policy: row.policy,
        tokenTarget: row.tokenTarget,
        targetTokenId: row.targetTokenId,
        grantedByUserId: row.grantedByUserId,
        source: row.source,
      })),
      deactivatedAt: new Date(),
    })
    .onConflictDoNothing();
}

/**
 * Restore the memberships and grants captured by the user's deactivation
 * snapshot, then consume the snapshot. Users deactivated before snapshots
 * existed have no row, so reactivating them restores nothing (the legacy
 * behavior). Referenced rows that were deleted while the user was inactive
 * (orgs, groups, repositories, target tokens) are skipped rather than failing
 * the whole reactivation, and re-granted duplicates (e.g. a bootstrap
 * system.admin grant re-issued at boot) are ignored via ON CONFLICT.
 */
async function restoreAccessFromSnapshot(tx: DbTransaction, userId: string): Promise<void> {
  const [snapshot] = await tx
    .delete(userDeactivationSnapshots)
    .where(eq(userDeactivationSnapshots.userId, userId))
    .returning();
  if (!snapshot) return;

  const orgIds = uniqueIds([
    ...snapshot.memberships.map((m) => m.orgId),
    ...snapshot.permissionGrants.map((g) => g.orgId),
  ]);
  const orgRows =
    orgIds.length > 0
      ? await tx
          .select({ id: organizations.id })
          .from(organizations)
          .where(inArray(organizations.id, orgIds))
      : [];
  const existingOrgs = new Set(orgRows.map((row) => row.id));

  const membershipValues = snapshot.memberships
    .filter((m) => existingOrgs.has(m.orgId))
    .map((m) => ({ orgId: m.orgId, userId }));
  if (membershipValues.length > 0) {
    await tx.insert(memberships).values(membershipValues).onConflictDoNothing();
  }

  const groupIds = uniqueIds(snapshot.groupMemberships.map((g) => g.groupId));
  const groupRows =
    groupIds.length > 0
      ? await tx
          .select({ id: groups.id, orgId: groups.orgId })
          .from(groups)
          .where(inArray(groups.id, groupIds))
      : [];
  const existingGroups = new Set(groupRows.map((row) => `${row.orgId}/${row.id}`));
  const groupMembershipValues = snapshot.groupMemberships
    .filter((g) => existingGroups.has(`${g.orgId}/${g.groupId}`))
    .map((g) => ({
      orgId: g.orgId,
      groupId: g.groupId,
      userId,
      source: g.source,
      provider: g.provider,
      externalKey: g.externalKey,
    }));
  if (groupMembershipValues.length > 0) {
    await tx.insert(groupMemberships).values(groupMembershipValues).onConflictDoNothing();
  }

  const repositoryIds = uniqueIds(snapshot.permissionGrants.map((g) => g.repositoryId));
  const repositoryRows =
    repositoryIds.length > 0
      ? await tx
          .select({ id: repositories.id })
          .from(repositories)
          .where(inArray(repositories.id, repositoryIds))
      : [];
  const existingRepositories = new Set(repositoryRows.map((row) => row.id));
  const targetTokenIds = uniqueIds(snapshot.permissionGrants.map((g) => g.targetTokenId));
  const targetTokenRows =
    targetTokenIds.length > 0
      ? await tx
          .select({ id: apiTokens.id })
          .from(apiTokens)
          .where(inArray(apiTokens.id, targetTokenIds))
      : [];
  const existingTargetTokens = new Set(targetTokenRows.map((row) => row.id));
  const granterIds = uniqueIds(snapshot.permissionGrants.map((g) => g.grantedByUserId));
  const granterRows =
    granterIds.length > 0
      ? await tx.select({ id: users.id }).from(users).where(inArray(users.id, granterIds))
      : [];
  const existingGranters = new Set(granterRows.map((row) => row.id));

  const grantValues = snapshot.permissionGrants
    .filter(
      (g) =>
        (g.orgId === null || existingOrgs.has(g.orgId)) &&
        (g.repositoryId === null || existingRepositories.has(g.repositoryId)) &&
        (g.targetTokenId === null || existingTargetTokens.has(g.targetTokenId)),
    )
    .map((g) => ({
      userId,
      orgId: g.orgId,
      permission: g.permission,
      repositoryId: g.repositoryId,
      repositoryPattern: g.repositoryPattern,
      packagePattern: g.packagePattern,
      artifactPattern: g.artifactPattern,
      policy: g.policy,
      tokenTarget: g.tokenTarget,
      targetTokenId: g.targetTokenId,
      // grantedByUserId has an ON DELETE SET NULL FK; a granter deleted while
      // the user was inactive becomes null rather than an FK violation.
      grantedByUserId:
        g.grantedByUserId && existingGranters.has(g.grantedByUserId) ? g.grantedByUserId : null,
      source: g.source,
    }));
  if (grantValues.length > 0) {
    await tx.insert(permissionGrants).values(grantValues).onConflictDoNothing();
  }
}

/**
 * Deactivation revokes sessions and API tokens, then removes the user's group
 * memberships, org memberships, and user-subject permission grants — after
 * snapshotting them so `setUserActive(true)` can put them back. Reactivation
 * restores from that snapshot and consumes it; users deactivated before
 * snapshots existed (no row) are reactivated with no access restored, exactly
 * as before. Bootstrap system admins regain system.admin at the next boot via
 * `bootstrapSystemAdmins` regardless of the snapshot.
 */
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
      await snapshotAccessForDeactivation(tx, userId);
      await tx.delete(groupMemberships).where(eq(groupMemberships.userId, userId));
      await tx.delete(memberships).where(eq(memberships.userId, userId));
      await tx.delete(permissionGrants).where(eq(permissionGrants.userId, userId));
    } else {
      await restoreAccessFromSnapshot(tx, userId);
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
