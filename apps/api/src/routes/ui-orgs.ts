import { type RoleName, roleOutranks } from "@hootifactory/auth";
import { db, eq, externalRoleGrants, memberships, organizations } from "@hootifactory/db";

export type AccessibleOrg = {
  id: string;
  slug: string;
  displayName: string;
  role: RoleName;
};

export function mergeAccessibleOrgs(
  membershipOrgs: AccessibleOrg[],
  externalOrgs: AccessibleOrg[],
): AccessibleOrg[] {
  const byId = new Map<string, AccessibleOrg>();
  for (const org of [...membershipOrgs, ...externalOrgs]) {
    const existing = byId.get(org.id);
    if (!existing || roleOutranks(org.role, existing.role)) byId.set(org.id, org);
  }
  return [...byId.values()].sort((a, b) => a.slug.localeCompare(b.slug));
}

export async function listAccessibleOrgs(userId: string): Promise<AccessibleOrg[]> {
  const membershipOrgs = await db
    .select({
      id: organizations.id,
      slug: organizations.slug,
      displayName: organizations.displayName,
      role: memberships.role,
    })
    .from(memberships)
    .innerJoin(organizations, eq(memberships.orgId, organizations.id))
    .where(eq(memberships.userId, userId));
  const externalOrgs = await db
    .select({
      id: organizations.id,
      slug: organizations.slug,
      displayName: organizations.displayName,
      role: externalRoleGrants.role,
    })
    .from(externalRoleGrants)
    .innerJoin(organizations, eq(externalRoleGrants.orgId, organizations.id))
    .where(eq(externalRoleGrants.userId, userId));

  return mergeAccessibleOrgs(membershipOrgs, externalOrgs);
}
