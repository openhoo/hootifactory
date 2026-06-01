import { and, authEmailTokens, db, eq, gt, isNull, sessions, users } from "@hootifactory/db";
import { hashPassword } from "./password";

export type AuthEmailTokenPurpose = "password_reset" | "oidc_link";

function sha256hex(input: string): string {
  const h = new Bun.CryptoHasher("sha256");
  h.update(input);
  return h.digest("hex");
}

function base64url(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64url");
}

export function hashAuthEmailToken(secret: string): string {
  return sha256hex(secret);
}

export function generateAuthEmailTokenSecret(): string {
  return `hoot_email_${base64url(crypto.getRandomValues(new Uint8Array(32)))}`;
}

export interface CreateAuthEmailTokenInput {
  purpose: AuthEmailTokenPurpose;
  userId: string;
  email: string;
  ttlSeconds: number;
  metadata?: Record<string, unknown>;
}

export type AuthEmailTokenRow = typeof authEmailTokens.$inferSelect;

export async function createAuthEmailToken(
  input: CreateAuthEmailTokenInput,
): Promise<{ token: AuthEmailTokenRow; secret: string }> {
  const secret = generateAuthEmailTokenSecret();
  const now = new Date();
  const expiresAt = new Date(now.getTime() + input.ttlSeconds * 1000);
  return db.transaction(async (tx) => {
    await tx
      .update(authEmailTokens)
      .set({ consumedAt: now })
      .where(
        and(
          eq(authEmailTokens.userId, input.userId),
          eq(authEmailTokens.purpose, input.purpose),
          isNull(authEmailTokens.consumedAt),
        ),
      );
    const [token] = await tx
      .insert(authEmailTokens)
      .values({
        purpose: input.purpose,
        userId: input.userId,
        email: input.email,
        tokenHash: sha256hex(secret),
        expiresAt,
        metadata: input.metadata ?? {},
      })
      .returning();
    if (!token) throw new Error("failed to create auth email token");
    return { token, secret };
  });
}

export async function consumeAuthEmailToken(
  purpose: AuthEmailTokenPurpose,
  secret: string,
): Promise<AuthEmailTokenRow | null> {
  const now = new Date();
  const [token] = await db
    .update(authEmailTokens)
    .set({ consumedAt: now })
    .where(
      and(
        eq(authEmailTokens.purpose, purpose),
        eq(authEmailTokens.tokenHash, sha256hex(secret)),
        isNull(authEmailTokens.consumedAt),
        gt(authEmailTokens.expiresAt, now),
      ),
    )
    .returning();
  return token ?? null;
}

export async function resetPasswordWithToken(
  secret: string,
  password: string,
): Promise<{ userId: string } | null> {
  const now = new Date();
  return db.transaction(async (tx) => {
    const [token] = await tx
      .update(authEmailTokens)
      .set({ consumedAt: now })
      .where(
        and(
          eq(authEmailTokens.purpose, "password_reset"),
          eq(authEmailTokens.tokenHash, sha256hex(secret)),
          isNull(authEmailTokens.consumedAt),
          gt(authEmailTokens.expiresAt, now),
        ),
      )
      .returning();
    if (!token) return null;
    await tx
      .update(users)
      .set({ passwordHash: await hashPassword(password) })
      .where(eq(users.id, token.userId));
    await tx
      .update(sessions)
      .set({ revokedAt: new Date() })
      .where(and(eq(sessions.userId, token.userId), isNull(sessions.revokedAt)));
    return { userId: token.userId };
  });
}
