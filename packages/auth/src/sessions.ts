import { and, db, eq, isNull, sessions } from "@hootifactory/db";
import { randomSecret, sha256hex } from "./secret";

const DEFAULT_TTL_SECONDS = 60 * 60 * 24 * 7;

/** Predicate matching a user's non-revoked sessions. */
export function activeSessionsForUser(userId: string) {
  return and(eq(sessions.userId, userId), isNull(sessions.revokedAt));
}

export interface CreateSessionOptions {
  ttlSeconds?: number;
  ip?: string;
  userAgent?: string;
}

export async function createSession(
  userId: string,
  opts: CreateSessionOptions = {},
): Promise<{ secret: string; expiresAt: Date }> {
  const secret = randomSecret();
  const ttl = opts.ttlSeconds ?? DEFAULT_TTL_SECONDS;
  const expiresAt = new Date(Date.now() + ttl * 1000);
  await db.insert(sessions).values({
    userId,
    tokenHash: sha256hex(secret),
    expiresAt,
    ip: opts.ip,
    userAgent: opts.userAgent,
  });
  return { secret, expiresAt };
}

export async function resolveSession(secret: string): Promise<{ userId: string } | null> {
  const [row] = await db
    .select()
    .from(sessions)
    .where(eq(sessions.tokenHash, sha256hex(secret)))
    .limit(1);
  if (!row || row.revokedAt || row.expiresAt.getTime() < Date.now()) return null;
  return { userId: row.userId };
}

export async function revokeSession(secret: string): Promise<void> {
  await db
    .update(sessions)
    .set({ revokedAt: new Date() })
    .where(eq(sessions.tokenHash, sha256hex(secret)));
}

export async function revokeSessionsForUser(userId: string): Promise<void> {
  await db.update(sessions).set({ revokedAt: new Date() }).where(activeSessionsForUser(userId));
}
