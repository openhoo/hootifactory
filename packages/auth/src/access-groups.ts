import {
  and,
  db,
  desc,
  eq,
  groupMemberships,
  groups,
  memberships,
  permissionGrants,
  users,
} from "@hootifactory/db";
import type { Principal } from "./principal";
import { validateAssignablePermissionGrants } from "./token-grants";
import { permissionGrantToTokenGrant } from "./tokens";

export type GroupRow = typeof groups.$inferSelect;
export type GroupMembershipRow = typeof groupMemberships.$inferSelect;

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

export type AddGroupMemberResult =
  | { ok: true }
  | {
      ok: false;
      code: "group_not_found" | "user_not_member" | "grant_escalation";
      error: string;
    };

export async function addGroupMember(input: {
  orgId: string;
  groupId: string;
  userId: string;
  principal: Principal;
}): Promise<AddGroupMemberResult> {
  const group = await getGroupInOrg(input.orgId, input.groupId);
  if (!group) return { ok: false, code: "group_not_found", error: "group not found" };

  // Group membership conveys every grant the group holds, so adding a member
  // is equivalent to assigning those grants directly. Require the acting
  // principal to dominate the group's current grants using the same machinery
  // as the grant-assignment path (replaceGroupGrants); otherwise a caller
  // holding only group.member.manage could escalate by adding themselves (or
  // anyone) to a higher-privileged group. allowSystemAdmin is set because we
  // are checking existing grants rather than assigning new ones: a group that
  // already holds system.admin may only gain members through an actor who
  // holds system.admin themselves. Removing a member needs no such check — it
  // only ever reduces access.
  const groupGrants = await grantsForGroup(input.orgId, input.groupId);
  if (groupGrants.length > 0) {
    const validation = await validateAssignablePermissionGrants({
      principal: input.principal,
      orgId: input.orgId,
      grants: groupGrants.map(permissionGrantToTokenGrant),
      allowSystemAdmin: true,
    });
    if (!validation.ok) {
      return {
        ok: false,
        code: "grant_escalation",
        error: `adding a member to this group would grant permissions beyond your own (${validation.error})`,
      };
    }
  }

  return db.transaction(async (tx): Promise<AddGroupMemberResult> => {
    const [membership] = await tx
      .select({ id: memberships.id })
      .from(memberships)
      .where(and(eq(memberships.orgId, input.orgId), eq(memberships.userId, input.userId)))
      .limit(1);
    if (!membership) {
      return {
        ok: false,
        code: "user_not_member",
        error: "user is not a member of this organization",
      };
    }

    await tx
      .insert(groupMemberships)
      .values({ orgId: input.orgId, groupId: input.groupId, userId: input.userId })
      .onConflictDoNothing();
    return { ok: true };
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
