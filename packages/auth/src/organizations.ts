import { db, eq, externalRoleGrants, memberships, organizations } from "@hootifactory/db";
import type { RoleName } from "./permissions";
import { roleOutranks } from "./permissions";

export type OrganizationRow = typeof organizations.$inferSelect;

export type AccessibleOrg = {
  id: string;
  slug: string;
  displayName: string;
  role: RoleName;
};

export type CreateOrganizationInput = {
  slug: string;
  displayName: string;
  description?: string;
  ownerUserId: string;
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

export async function getOrganizationById(orgId: string): Promise<OrganizationRow | null> {
  const [org] = await db.select().from(organizations).where(eq(organizations.id, orgId)).limit(1);
  return org ?? null;
}

export async function createOrganizationWithOwner(
  input: CreateOrganizationInput,
): Promise<OrganizationRow> {
  return db.transaction(async (tx) => {
    const [org] = await tx
      .insert(organizations)
      .values({
        slug: input.slug,
        displayName: input.displayName,
        description: input.description,
      })
      .returning();
    if (!org) throw new Error("failed to create org");
    await tx.insert(memberships).values({
      orgId: org.id,
      userId: input.ownerUserId,
      role: "owner",
    });
    return org;
  });
}
