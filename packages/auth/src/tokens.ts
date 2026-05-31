import { apiTokens, db, eq, type TokenScope } from "@hootifactory/db";
import type { RoleName } from "./permissions";
import type { Principal } from "./principal";

export const TOKEN_PREFIX = "hoot_";

function sha256hex(input: string): string {
  const h = new Bun.CryptoHasher("sha256");
  h.update(input);
  return h.digest("hex");
}

function base64url(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64url");
}

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
  const raw = crypto.getRandomValues(new Uint8Array(32));
  const secret = `${TOKEN_PREFIX}${base64url(raw)}`;
  return { secret, prefix: secret.slice(0, 12), hash: sha256hex(secret) };
}

export interface CreateTokenInput {
  orgId: string;
  ownerUserId?: string | null;
  name: string;
  type?: "personal" | "robot";
  scopes?: TokenScope[];
  role?: RoleName | null;
  expiresAt?: Date | null;
}

export type ApiTokenRow = typeof apiTokens.$inferSelect;

export async function createApiToken(
  input: CreateTokenInput,
): Promise<{ token: ApiTokenRow; secret: string }> {
  const { secret, prefix, hash } = generateTokenSecret();
  const [token] = await db
    .insert(apiTokens)
    .values({
      orgId: input.orgId,
      ownerUserId: input.ownerUserId ?? null,
      name: input.name,
      type: input.type ?? "personal",
      tokenHash: hash,
      tokenPrefix: prefix,
      scopes: input.scopes ?? [],
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
    orgId: row.orgId,
    ownerUserId: row.ownerUserId,
    scopes: row.scopes,
    role: row.role,
    isRobot: row.type === "robot",
  };
}

export async function revokeToken(id: string): Promise<void> {
  await db.update(apiTokens).set({ revokedAt: new Date() }).where(eq(apiTokens.id, id));
}
