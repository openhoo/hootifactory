import { db, eq, sessions } from "@hootifactory/db";

function sha256hex(input: string): string {
  const h = new Bun.CryptoHasher("sha256");
  h.update(input);
  return h.digest("hex");
}

const DEFAULT_TTL_SECONDS = 60 * 60 * 24 * 7;

export interface CreateSessionOptions {
  ttlSeconds?: number;
  ip?: string;
  userAgent?: string;
}

export async function createSession(
  userId: string,
  opts: CreateSessionOptions = {},
): Promise<{ secret: string; expiresAt: Date }> {
  const secret = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64url");
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
