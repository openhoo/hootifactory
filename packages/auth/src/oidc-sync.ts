import { trimChar } from "@hootifactory/core";
import {
  and,
  db,
  eq,
  externalIdentities,
  groupMemberships,
  groups,
  inArray,
  memberships,
  organizations,
  users,
} from "@hootifactory/db";
import {
  OIDC_PROVIDER,
  type OidcGroupGrant,
  type SyncedOidcUser,
  type SyncOidcUserInput,
  type SyncOidcUserOptions,
} from "./oidc-types";

export class OidcEmailLinkRequiredError extends Error {
  constructor(
    public readonly userId: string,
    public readonly email: string,
  ) {
    super("oidc: email link confirmation required");
    this.name = "OidcEmailLinkRequiredError";
  }
}

function normalizeUsername(value: string | null, fallback: string): string {
  const collapsed = (value || fallback).toLowerCase().replace(/[^a-z0-9._-]+/g, "-");
  const base = trimChar(collapsed, "-").slice(0, 96);
  return base || `oidc-${crypto.randomUUID().slice(0, 8)}`;
}

async function uniqueUsername(value: string | null, fallback: string): Promise<string> {
  const base = normalizeUsername(value, fallback);
  for (let i = 0; i < 50; i++) {
    const candidate = i === 0 ? base : `${base.slice(0, 96)}-${i}`;
    const [existing] = await db
      .select({ id: users.id })
      .from(users)
      .where(eq(users.username, candidate))
      .limit(1);
    if (!existing) return candidate;
  }
  return `${base.slice(0, 80)}-${crypto.randomUUID().slice(0, 12)}`;
}

function managedGroupExternalKey(issuer: string, group: string): string {
  return JSON.stringify([issuer, group]);
}

function noMappedAccessError(input: SyncOidcUserInput): Error {
  return new Error(
    input.grants.length === 0 ? "oidc: no mapped groups" : "oidc: no mapped organizations exist",
  );
}

export async function oidcIdentityBelongsToAnotherUser(input: {
  issuer: string;
  subject: string;
  userId: string;
}): Promise<boolean> {
  const [existingIdentity] = await db
    .select({ userId: externalIdentities.userId })
    .from(externalIdentities)
    .where(
      and(
        eq(externalIdentities.provider, OIDC_PROVIDER),
        eq(externalIdentities.issuer, input.issuer),
        eq(externalIdentities.subject, input.subject),
      ),
    )
    .limit(1);
  return Boolean(existingIdentity && existingIdentity.userId !== input.userId);
}

export async function syncOidcUser(
  input: SyncOidcUserInput,
  options: SyncOidcUserOptions = {},
): Promise<SyncedOidcUser> {
  const mappedSlugs = [...new Set(input.grants.map((grant) => grant.org))];
  const orgRows =
    mappedSlugs.length > 0
      ? await db
          .select({ id: organizations.id, slug: organizations.slug })
          .from(organizations)
          .where(inArray(organizations.slug, mappedSlugs))
      : [];
  const orgBySlug = new Map(orgRows.map((org) => [org.slug, org.id]));
  const validGrants = input.grants
    .map((grant) => ({ ...grant, orgId: orgBySlug.get(grant.org) }))
    .filter((grant): grant is OidcGroupGrant & { orgId: string } => Boolean(grant.orgId));

  const result = await db.transaction(async (tx) => {
    const [linked] = await tx
      .select({ user: users })
      .from(externalIdentities)
      .innerJoin(users, eq(externalIdentities.userId, users.id))
      .where(
        and(
          eq(externalIdentities.provider, OIDC_PROVIDER),
          eq(externalIdentities.issuer, input.issuer),
          eq(externalIdentities.subject, input.subject),
        ),
      )
      .limit(1);

    let user = linked?.user ?? null;
    if (user && !user.isActive) throw new Error("oidc: linked user is disabled");
    if (!user && validGrants.length === 0) throw noMappedAccessError(input);

    if (!user && input.email) {
      const [existing] = await tx.select().from(users).where(eq(users.email, input.email)).limit(1);
      if (existing && !existing.isActive) {
        throw new Error("oidc: existing user is disabled");
      }
      if (existing && !input.emailVerified) {
        throw new Error("oidc: email claim is not verified");
      }
      if (existing && !options.allowExistingEmailLink) {
        throw new OidcEmailLinkRequiredError(existing.id, existing.email);
      }
      user = existing ?? null;
    }

    if (!user) {
      if (!input.email) throw new Error("oidc: email claim is required to create a user");
      if (!input.emailVerified) throw new Error("oidc: email claim is not verified");
      const username = await uniqueUsername(
        input.username,
        input.email.split("@")[0] ?? input.subject,
      );
      const [created] = await tx
        .insert(users)
        .values({
          email: input.email,
          username,
          displayName: input.displayName ?? username,
          passwordHash: null,
          externalIdp: { issuer: input.issuer, subject: input.subject },
        })
        .returning();
      if (!created) throw new Error("oidc: failed to create user");
      user = created;
    } else {
      await tx
        .update(users)
        .set({
          externalIdp: { issuer: input.issuer, subject: input.subject },
          displayName: user.displayName ?? input.displayName ?? user.username,
        })
        .where(eq(users.id, user.id));
    }

    await tx
      .insert(externalIdentities)
      .values({
        provider: OIDC_PROVIDER,
        issuer: input.issuer,
        subject: input.subject,
        userId: user.id,
        email: input.email,
        lastLoginAt: new Date(),
      })
      .onConflictDoUpdate({
        target: [
          externalIdentities.provider,
          externalIdentities.issuer,
          externalIdentities.subject,
        ],
        set: { userId: user.id, email: input.email, lastLoginAt: new Date() },
      });

    const validOrgIds = [...new Set(validGrants.map((grant) => grant.orgId))];
    if (validOrgIds.length > 0) {
      await tx
        .insert(memberships)
        .values(validOrgIds.map((orgId) => ({ orgId, userId: user.id })))
        .onConflictDoNothing();
    }

    await tx
      .delete(groupMemberships)
      .where(
        and(
          eq(groupMemberships.source, OIDC_PROVIDER),
          eq(groupMemberships.provider, OIDC_PROVIDER),
          eq(groupMemberships.externalKey, input.issuer),
          eq(groupMemberships.userId, user.id),
        ),
      );

    const syncedMemberships: (typeof groupMemberships.$inferInsert)[] = [];
    for (const grant of validGrants) {
      const expectedExternalKey = managedGroupExternalKey(input.issuer, grant.group);
      const [existingGroup] = await tx
        .select()
        .from(groups)
        .where(and(eq(groups.orgId, grant.orgId), eq(groups.slug, grant.group)))
        .limit(1);
      if (
        existingGroup &&
        (existingGroup.managedBy !== OIDC_PROVIDER ||
          existingGroup.externalKey !== expectedExternalKey)
      ) {
        throw new Error("oidc: mapped group slug collides with an existing local group");
      }
      const group =
        existingGroup ??
        (
          await tx
            .insert(groups)
            .values({
              orgId: grant.orgId,
              slug: grant.group,
              displayName: grant.group,
              managedBy: OIDC_PROVIDER,
              externalKey: expectedExternalKey,
            })
            .returning()
        )[0];
      if (!group) throw new Error("oidc: failed to create mapped group");
      syncedMemberships.push({
        orgId: grant.orgId,
        groupId: group.id,
        userId: user.id,
        source: OIDC_PROVIDER,
        provider: OIDC_PROVIDER,
        externalKey: input.issuer,
      });
    }
    if (syncedMemberships.length > 0) {
      await tx.insert(groupMemberships).values(syncedMemberships).onConflictDoNothing();
    }

    return {
      user: { id: user.id, username: user.username },
      hasMappedAccess: validGrants.length > 0,
    };
  });
  if (!result.hasMappedAccess) throw noMappedAccessError(input);
  return result.user;
}
