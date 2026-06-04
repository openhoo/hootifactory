import { BoundedLruCache } from "@hootifactory/core";
import { and, apiTokens, db, desc, eq, users } from "@hootifactory/db";
import type { TokenGrant, TokenScope, TokenType } from "@hootifactory/types";
import type { RoleName } from "./permissions";
import type { Principal } from "./principal";
import { repositoryGrantsAsScopes } from "./scope";
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
  /** Legacy pre-v1 input, normalized to repository grants before storage. */
  scopes?: TokenScope[];
  role?: RoleName | null;
  expiresAt?: Date | null;
}

export type ApiTokenRow = typeof apiTokens.$inferSelect;

export type ApiTokenWithOwner = {
  token: ApiTokenRow;
  ownerUsername: string | null;
};

const TOKEN_LAST_USED_WRITE_INTERVAL_MS = 60_000;
const TOKEN_LAST_USED_CACHE_LIMIT = 10_000;
const tokenLastUsedWrites = new BoundedLruCache<string, number>(TOKEN_LAST_USED_CACHE_LIMIT);

export async function createApiToken(
  input: CreateTokenInput,
): Promise<{ token: ApiTokenRow; secret: string }> {
  const { secret, prefix, hash } = generateTokenSecret();
  const grants =
    input.grants ??
    input.scopes?.map(
      (scope): TokenGrant => ({
        resource: "repository",
        repository: scope.repository,
        actions: [...scope.actions],
      }),
    ) ??
    [];
  const [token] = await db
    .insert(apiTokens)
    .values({
      orgId: input.orgId,
      ownerUserId: input.ownerUserId ?? null,
      name: input.name,
      type: input.type ?? "personal",
      tokenHash: hash,
      tokenPrefix: prefix,
      grants,
      role: input.role ?? null,
      expiresAt: input.expiresAt ?? null,
    })
    .returning();
  if (!token) throw new Error("failed to create token");
  return { token, secret };
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
  return row ?? null;
}

export async function listOrgTokens(orgId: string): Promise<ApiTokenWithOwner[]> {
  return db
    .select({ token: apiTokens, ownerUsername: users.username })
    .from(apiTokens)
    .leftJoin(users, eq(apiTokens.ownerUserId, users.id))
    .where(eq(apiTokens.orgId, orgId))
    .orderBy(desc(apiTokens.createdAt));
}

export async function listOrgTokensOwnedBy(
  orgId: string,
  ownerUserId: string,
): Promise<ApiTokenWithOwner[]> {
  return db
    .select({ token: apiTokens, ownerUsername: users.username })
    .from(apiTokens)
    .leftJoin(users, eq(apiTokens.ownerUserId, users.id))
    .where(and(eq(apiTokens.orgId, orgId), eq(apiTokens.ownerUserId, ownerUserId)))
    .orderBy(desc(apiTokens.createdAt));
}

export async function recordTokenLastUsed(tokenId: string, now = Date.now()): Promise<boolean> {
  const previous = tokenLastUsedWrites.get(tokenId);
  if (previous !== undefined && now - previous < TOKEN_LAST_USED_WRITE_INTERVAL_MS) {
    return false;
  }
  tokenLastUsedWrites.set(tokenId, now);
  await db
    .update(apiTokens)
    .set({ lastUsedAt: new Date(now) })
    .where(eq(apiTokens.id, tokenId));
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
  const grants = row.token.grants ?? [];

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
    scopes: repositoryGrantsAsScopes(grants),
    role: row.token.role,
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
