import { db, eq, memberships, organizations, permissionGrants } from "@hootifactory/db";
import type { PermissionKey } from "@hootifactory/types";
import { permissionGrantsForUser } from "./permission-grants";
import { PERMISSIONS } from "./permissions";

export type OrganizationRow = typeof organizations.$inferSelect;

export type AccessibleOrg = {
  id: string;
  slug: string;
  displayName: string;
  permissions: PermissionKey[];
};

export type CreateOrganizationInput = {
  slug: string;
  displayName: string;
  description?: string;
  ownerUserId: string;
};

const SYSTEM_SCOPED_PERMISSIONS: PermissionKey[] = [
  "system.admin",
  "user.read",
  "user.create",
  "user.update",
  "user.deactivate",
  "user.reset_password",
  "permission.read",
];

export const ORG_OWNER_PERMISSIONS = PERMISSIONS.filter(
  (permission) => !SYSTEM_SCOPED_PERMISSIONS.includes(permission as PermissionKey),
) as PermissionKey[];

function sortedUniquePermissions(permissions: Iterable<PermissionKey>): PermissionKey[] {
  return [...new Set(permissions)].sort();
}

export async function listAccessibleOrgs(userId: string): Promise<AccessibleOrg[]> {
  const rows = await db
    .select({
      id: organizations.id,
      slug: organizations.slug,
      displayName: organizations.displayName,
    })
    .from(memberships)
    .innerJoin(organizations, eq(memberships.orgId, organizations.id))
    .where(eq(memberships.userId, userId));

  const orgs = await Promise.all(
    rows.map(async (org) => {
      const grants = await permissionGrantsForUser(userId, org.id);
      return {
        ...org,
        permissions: sortedUniquePermissions(grants.map((grant) => grant.permission)),
      };
    }),
  );
  return orgs.sort((a, b) => a.slug.localeCompare(b.slug));
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
    });
    await tx.insert(permissionGrants).values(
      ORG_OWNER_PERMISSIONS.map((permission) => ({
        orgId: org.id,
        userId: input.ownerUserId,
        permission,
      })),
    );
    return org;
  });
}
