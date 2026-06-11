import { BoundedLruCache } from "@hootifactory/core";
import { and, apiTokens, db, desc, eq, inArray, permissionGrants, users } from "@hootifactory/db";
import { PERMISSION_KEYS, type TokenGrant, type TokenType } from "@hootifactory/types";
import type { Principal } from "./principal";
import { randomSecret, sha256hex } from "./secret";

export const TOKEN_PREFIX = "hoot_";

export function hashToken(secret: string): string {
  return sha256hex(secret);
}

export interface GeneratedToken {
  secret: string;
  prefix: string;
  hash: string;
}

/** Generate a high-entropy opaque token. Only the hash + prefix are persisted. */
export function generateTokenSecret(): GeneratedToken {
  const secret = randomSecret(TOKEN_PREFIX);
  return { secret, prefix: secret.slice(0, 12), hash: sha256hex(secret) };
}

export interface CreateTokenInput {
  orgId: string;
  ownerUserId?: string | null;
  name: string;
  type?: TokenType;
  grants?: TokenGrant[];
  expiresAt?: Date | null;
}

export type ApiTokenRow = typeof apiTokens.$inferSelect;

export type ApiTokenWithOwner = {
  token: ApiTokenRow;
  ownerUsername: string | null;
  grants: TokenGrant[];
};

const TOKEN_LAST_USED_WRITE_INTERVAL_MS = 60_000;
const TOKEN_LAST_USED_CACHE_LIMIT = 10_000;
const tokenLastUsedWrites = new BoundedLruCache<string, number>(TOKEN_LAST_USED_CACHE_LIMIT);

export async function createApiToken(
  input: CreateTokenInput,
): Promise<{ token: ApiTokenRow; secret: string }> {
  const { secret, prefix, hash } = generateTokenSecret();
  const grants = input.grants ?? [];
  if (grants.some((grant) => grant.permission === "system.admin")) {
    throw new Error("system.admin cannot be granted to API tokens");
  }
  const token = await db.transaction(async (tx) => {
    const [created] = await tx
      .insert(apiTokens)
      .values({
        orgId: input.orgId,
        ownerUserId: input.ownerUserId ?? null,
        name: input.name,
        type: input.type ?? "personal",
        tokenHash: hash,
        tokenPrefix: prefix,
        expiresAt: input.expiresAt ?? null,
      })
      .returning();
    if (!created) throw new Error("failed to create token");
    if (grants.length > 0) {
      await tx.insert(permissionGrants).values(
        grants.map((grant) => ({
          orgId: input.orgId,
          tokenId: created.id,
          permission: grant.permission,
          repositoryPattern: grant.repository ?? null,
          packagePattern: grant.package ?? null,
          artifactPattern: grant.artifact ?? null,
          policy: grant.policy ?? null,
          tokenTarget: grant.tokenTarget ?? null,
          targetTokenId: grant.tokenId ?? null,
          source: "token",
        })),
      );
    }
    return created;
  });
  return { token, secret };
}

export function permissionGrantToTokenGrant(
  grant: typeof permissionGrants.$inferSelect,
): TokenGrant {
  return {
    permission: grant.permission,
    ...(grant.repositoryPattern ? { repository: grant.repositoryPattern } : {}),
    ...(grant.packagePattern ? { package: grant.packagePattern } : {}),
    ...(grant.artifactPattern ? { artifact: grant.artifactPattern } : {}),
    ...(grant.policy ? { policy: grant.policy } : {}),
    ...(grant.tokenTarget ? { tokenTarget: grant.tokenTarget } : {}),
    ...(grant.targetTokenId ? { tokenId: grant.targetTokenId } : {}),
  };
}

function tokenGrantSortKey(grant: TokenGrant): string {
  const permissionOrder = PERMISSION_KEYS.indexOf(grant.permission);
  return [
    String(permissionOrder).padStart(3, "0"),
    grant.repository ?? "",
    grant.package ?? "",
    grant.artifact ?? "",
    grant.policy ?? "",
    grant.tokenTarget ?? "",
    grant.tokenId ?? "",
  ].join("\0");
}

function sortTokenGrants(grants: TokenGrant[]): TokenGrant[] {
  return grants.sort((a, b) => tokenGrantSortKey(a).localeCompare(tokenGrantSortKey(b)));
}

export async function getTokenGrants(tokenId: string): Promise<TokenGrant[]> {
  const rows = await db
    .select()
    .from(permissionGrants)
    .where(eq(permissionGrants.tokenId, tokenId));
  return sortTokenGrants(rows.map(permissionGrantToTokenGrant));
}

async function tokenGrantsByTokenId(tokenIds: string[]): Promise<Map<string, TokenGrant[]>> {
  const map = new Map<string, TokenGrant[]>();
  for (const tokenId of tokenIds) map.set(tokenId, []);
  if (tokenIds.length === 0) return map;
  const rows = await db
    .select()
    .from(permissionGrants)
    .where(inArray(permissionGrants.tokenId, tokenIds));
  for (const row of rows) {
    if (!row.tokenId) continue;
    map.get(row.tokenId)?.push(permissionGrantToTokenGrant(row));
  }
  for (const grants of map.values()) sortTokenGrants(grants);
  return map;
}

export async function getApiTokenById(id: string): Promise<ApiTokenRow | null> {
  const [token] = await db.select().from(apiTokens).where(eq(apiTokens.id, id)).limit(1);
  return token ?? null;
}

export async function getApiTokenWithOwner(id: string): Promise<ApiTokenWithOwner | null> {
  const [row] = await db
    .select({ token: apiTokens, ownerUsername: users.username })
    .from(apiTokens)
    .leftJoin(users, eq(apiTokens.ownerUserId, users.id))
    .where(eq(apiTokens.id, id))
    .limit(1);
  if (!row) return null;
  return { ...row, grants: await getTokenGrants(row.token.id) };
}

export async function listOrgTokens(orgId: string): Promise<ApiTokenWithOwner[]> {
  const rows = await db
    .select({ token: apiTokens, ownerUsername: users.username })
    .from(apiTokens)
    .leftJoin(users, eq(apiTokens.ownerUserId, users.id))
    .where(eq(apiTokens.orgId, orgId))
    .orderBy(desc(apiTokens.createdAt));
  const grantsByTokenId = await tokenGrantsByTokenId(rows.map((row) => row.token.id));
  return rows.map((row) => ({ ...row, grants: grantsByTokenId.get(row.token.id) ?? [] }));
}

export async function listOrgTokensOwnedBy(
  orgId: string,
  ownerUserId: string,
): Promise<ApiTokenWithOwner[]> {
  const rows = await db
    .select({ token: apiTokens, ownerUsername: users.username })
    .from(apiTokens)
    .leftJoin(users, eq(apiTokens.ownerUserId, users.id))
    .where(and(eq(apiTokens.orgId, orgId), eq(apiTokens.ownerUserId, ownerUserId)))
    .orderBy(desc(apiTokens.createdAt));
  const grantsByTokenId = await tokenGrantsByTokenId(rows.map((row) => row.token.id));
  return rows.map((row) => ({ ...row, grants: grantsByTokenId.get(row.token.id) ?? [] }));
}

export async function recordTokenLastUsed(tokenId: string, now = Date.now()): Promise<boolean> {
  const previous = tokenLastUsedWrites.get(tokenId);
  if (previous !== undefined && now - previous < TOKEN_LAST_USED_WRITE_INTERVAL_MS) {
    return false;
  }
  await db
    .update(apiTokens)
    .set({ lastUsedAt: new Date(now) })
    .where(eq(apiTokens.id, tokenId));
  // Advance the debounce marker only after a successful write so a failed update
  // does not suppress the next attempt for the whole debounce interval.
  tokenLastUsedWrites.set(tokenId, now);
  return true;
}

/** Resolve a presented secret to a token Principal, or null if invalid/expired/revoked. */
export async function resolveToken(secret: string): Promise<Principal | null> {
  if (!secret.startsWith(TOKEN_PREFIX)) return null;
  const hash = hashToken(secret);
  const [row] = await db
    .select({ token: apiTokens, ownerIsActive: users.isActive, ownerUsername: users.username })
    .from(apiTokens)
    .leftJoin(users, eq(apiTokens.ownerUserId, users.id))
    .where(eq(apiTokens.tokenHash, hash))
    .limit(1);
  if (!row || row.token.revokedAt) return null;
  if (row.token.expiresAt && row.token.expiresAt.getTime() < Date.now()) return null;
  let ownerUsername: string | null = null;
  if (row.token.ownerUserId) {
    if (!row.ownerIsActive) return null;
    ownerUsername = row.ownerUsername;
  }
  const grants = await getTokenGrants(row.token.id);

  // Best-effort, display-only bookkeeping. Debounce writes so install storms
  // against one token do not turn every authenticated read into a hot-row update.
  void recordTokenLastUsed(row.token.id).catch(() => {});

  return {
    kind: "token",
    tokenId: row.token.id,
    tokenName: row.token.name,
    orgId: row.token.orgId,
    ownerUserId: row.token.ownerUserId,
    ownerUsername,
    grants,
    isRobot: row.token.type === "robot",
  };
}

export interface TokenActor {
  userId?: string | null;
  tokenId?: string | null;
}

export async function revokeToken(
  id: string,
  actor: TokenActor = {},
  reason?: string | null,
): Promise<void> {
  await db
    .update(apiTokens)
    .set({
      revokedAt: new Date(),
      revokedByUserId: actor.userId ?? null,
      revokedByTokenId: actor.tokenId ?? null,
      revocationReason: reason ?? null,
      updatedAt: new Date(),
    })
    .where(eq(apiTokens.id, id));
}

export async function rotateToken(
  id: string,
  actor: TokenActor = {},
): Promise<{ token: ApiTokenRow; secret: string } | null> {
  const { secret, prefix, hash } = generateTokenSecret();
  const [token] = await db
    .update(apiTokens)
    .set({
      tokenHash: hash,
      tokenPrefix: prefix,
      rotatedAt: new Date(),
      rotatedByUserId: actor.userId ?? null,
      rotatedByTokenId: actor.tokenId ?? null,
      updatedAt: new Date(),
    })
    .where(eq(apiTokens.id, id))
    .returning();
  return token ? { token, secret } : null;
}
