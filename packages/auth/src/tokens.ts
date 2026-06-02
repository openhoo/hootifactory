import { apiTokens, db, eq, type TokenGrant, type TokenScope, users } from "@hootifactory/db";
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
  type?: "personal" | "robot";
  grants?: TokenGrant[];
  /** Legacy pre-v1 input, normalized to repository grants before storage. */
  scopes?: TokenScope[];
  role?: RoleName | null;
  expiresAt?: Date | null;
}

export type ApiTokenRow = typeof apiTokens.$inferSelect;

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

/** Resolve a presented secret to a token Principal, or null if invalid/expired/revoked. */
export async function resolveToken(secret: string): Promise<Principal | null> {
  if (!secret.startsWith(TOKEN_PREFIX)) return null;
  const hash = hashToken(secret);
  const [row] = await db.select().from(apiTokens).where(eq(apiTokens.tokenHash, hash)).limit(1);
  if (!row || row.revokedAt) return null;
  if (row.expiresAt && row.expiresAt.getTime() < Date.now()) return null;
  let ownerUsername: string | null = null;
  if (row.ownerUserId) {
    const [owner] = await db
      .select({ isActive: users.isActive, username: users.username })
      .from(users)
      .where(eq(users.id, row.ownerUserId))
      .limit(1);
    if (!owner?.isActive) return null;
    ownerUsername = owner.username;
  }
  const grants = row.grants ?? [];

  // best-effort last-used bookkeeping. `.catch()` both executes the lazy Drizzle
  // query (a bare `void db.update(...)` is never sent) and swallows transient
  // failures so they don't surface as an unhandled rejection on every request.
  void db
    .update(apiTokens)
    .set({ lastUsedAt: new Date() })
    .where(eq(apiTokens.id, row.id))
    .catch(() => {});

  return {
    kind: "token",
    tokenId: row.id,
    tokenName: row.name,
    orgId: row.orgId,
    ownerUserId: row.ownerUserId,
    ownerUsername,
    grants,
    scopes: repositoryGrantsAsScopes(grants),
    role: row.role,
    isRobot: row.type === "robot",
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
