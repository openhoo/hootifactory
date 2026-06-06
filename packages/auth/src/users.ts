import { authEmailTokens, db, eq, sql, users } from "@hootifactory/db";
import { hashPassword, verifyPassword } from "./password";
import type { Principal } from "./principal";
import { randomSecret, sha256hex } from "./secret";

export type AuthUserRow = typeof users.$inferSelect;

export interface CreateLocalUserInput {
  username: string;
  email: string;
  password: string;
  displayName?: string | null;
}

export interface PasswordResetUser {
  id: string;
  email: string;
}

export async function createLocalUser(input: CreateLocalUserInput): Promise<AuthUserRow> {
  const [user] = await db
    .insert(users)
    .values({
      username: input.username,
      email: input.email,
      displayName: input.displayName ?? null,
      passwordHash: await hashPassword(input.password),
    })
    .returning();
  if (!user) throw new Error("failed to create user");
  return user;
}

export async function userPrincipalById(userId: string): Promise<Principal | null> {
  const [user] = await db
    .select({ id: users.id, username: users.username, isActive: users.isActive })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);
  if (!user?.isActive) return null;
  return { kind: "user", userId: user.id, username: user.username };
}

// Equalizes login timing for absent usernames by still running password verify.
let dummyPasswordHash: Promise<string> | null = null;
const timingHash = () => (dummyPasswordHash ??= hashPassword("hootifactory-timing-equalizer"));

export async function authenticateUserPassword(
  username: string,
  password: string,
): Promise<Principal | null> {
  const [user] = await db.select().from(users).where(eq(users.username, username)).limit(1);
  const ok = await verifyPassword(password, user?.passwordHash ?? (await timingHash()));
  if (!user?.isActive || !user.passwordHash || !ok) return null;
  return { kind: "user", userId: user.id, username: user.username };
}

export async function findPasswordResetUser(email: string): Promise<PasswordResetUser | null> {
  const [user] = await db
    .select({
      id: users.id,
      email: users.email,
      isActive: users.isActive,
      passwordHash: users.passwordHash,
    })
    .from(users)
    .where(eq(users.email, email))
    .limit(1);
  if (!user?.isActive || !user.passwordHash) return null;
  return { id: user.id, email: user.email };
}

// Equalizes password-reset request timing for unknown/inactive emails by doing
// work equivalent to the real request path without persisting anything or
// sending mail. Mirrors the login timing-equalizer above so attackers cannot
// distinguish registered accounts from unknown ones via response latency.
//
// The real path awaits two DB round-trips before responding: the
// createAuthEmailToken transaction (invalidate + insert) and the enqueueEmail
// queue insert. We mirror both with read-only no-op round-trips, plus the
// sha256 token-hash, so the no-user branch costs the same.
export async function dummyPasswordResetWork(): Promise<void> {
  // sha256 over a freshly generated secret mirrors createAuthEmailToken's hash.
  sha256hex(randomSecret("hoot_email_"));
  // A read-only transaction mirrors the token-creation transaction's round-trip
  // and BEGIN/COMMIT overhead without writing or invalidating any token.
  await db.transaction(async (tx) => {
    await tx.select({ one: sql`1` }).from(authEmailTokens).limit(0);
  });
  // A second read-only round-trip mirrors the enqueueEmail queue insert.
  await db.select({ one: sql`1` }).from(authEmailTokens).limit(0);
}
