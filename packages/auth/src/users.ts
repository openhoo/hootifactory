import { db, eq, users } from "@hootifactory/db";
import { hashPassword, verifyPassword } from "./password";
import type { Principal } from "./principal";

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
