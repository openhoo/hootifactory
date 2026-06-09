/**
 * Seed a demo org + owner user. Idempotent for org/user/membership.
 * In dev/test the owner password defaults to "admin" (override with SEED_PASS)
 * and is reset on every run so local logins stay predictable as admin / admin.
 * Non-production runs mint and print a fresh owner token for local setup.
 * Production runs never print passwords or token secrets and never rewrite an
 * existing user's password.
 *
 *   bun run db:seed
 */
import { createApiToken, hashPassword } from "@hootifactory/auth";
import { and, db, eq, memberships, organizations, users } from "@hootifactory/db";

const isProduction = process.env.NODE_ENV === "production";

// Well-known local-dev password so you can sign in without copying a generated
// value. Only ever used outside production, and only when SEED_PASS is unset.
const DEV_DEFAULT_PASSWORD = "admin";

function envNonEmpty(name: string): string | null {
  const value = process.env[name]?.trim();
  return value ? value : null;
}

function seedPassword(): { value: string; source: "env" | "dev-default" } {
  const explicit = process.env.SEED_PASS;
  if (explicit && explicit.length > 0) return { value: explicit, source: "env" };
  if (isProduction) {
    throw new Error("SEED_PASS is required when running db:seed with NODE_ENV=production");
  }
  return { value: DEV_DEFAULT_PASSWORD, source: "dev-default" };
}

async function main() {
  const orgSlug = envNonEmpty("SEED_ORG") ?? "acme";
  const adminUser = envNonEmpty("SEED_USER");
  if (isProduction && !adminUser) {
    throw new Error("SEED_USER is required when running db:seed with NODE_ENV=production");
  }
  const username = adminUser ?? "admin";
  const password = seedPassword();
  const shouldMintToken = !isProduction;

  let [org] = await db.select().from(organizations).where(eq(organizations.slug, orgSlug)).limit(1);
  if (!org) {
    [org] = await db
      .insert(organizations)
      .values({ slug: orgSlug, displayName: "Acme Inc" })
      .returning();
    console.log(`created org ${orgSlug}`);
  }
  if (!org) throw new Error("org creation failed");

  let [user] = await db.select().from(users).where(eq(users.username, username)).limit(1);
  let userState: "created" | "reset" | "unchanged" = "unchanged";
  if (!user) {
    [user] = await db
      .insert(users)
      .values({
        username,
        email: `${username}@${orgSlug}.test`,
        displayName: "Administrator",
        passwordHash: await hashPassword(password.value),
      })
      .returning();
    userState = "created";
    console.log(`created user ${username}`);
  } else if (!isProduction) {
    // Keep local logins predictable: re-seeding always resets the owner to the
    // seed password. Production never silently rewrites an existing password.
    await db
      .update(users)
      .set({ passwordHash: await hashPassword(password.value) })
      .where(eq(users.id, user.id));
    userState = "reset";
    console.log(`reset password for user ${username}`);
  }
  if (!user) throw new Error("user creation failed");

  const [member] = await db
    .select()
    .from(memberships)
    .where(and(eq(memberships.userId, user.id), eq(memberships.orgId, org.id)))
    .limit(1);
  if (!member) {
    await db.insert(memberships).values({ orgId: org.id, userId: user.id, role: "owner" });
    console.log("created owner membership");
  }

  const token = shouldMintToken
    ? await createApiToken({
        orgId: org.id,
        ownerUserId: user.id,
        name: "seed-token",
        role: "owner",
      })
    : null;

  console.log("\n── seed complete ──────────────────────────────");
  console.log(`  org:    ${org.slug}  (${org.id})`);
  if (isProduction) {
    console.log(
      userState === "created"
        ? `  login:  ${username}  (password set from SEED_PASS)`
        : `  login:  ${username}  (existing user; password unchanged)`,
    );
  } else {
    const tags = [
      password.source === "dev-default" ? "dev default" : null,
      userState === "reset" ? "password reset" : null,
    ].filter(Boolean);
    const suffix = tags.length > 0 ? `  (${tags.join("; ")})` : "";
    console.log(`  login:  ${username} / ${password.value}${suffix}`);
  }
  console.log(token ? `  token:  ${token.secret}` : "  token:  not minted in production");
  console.log("───────────────────────────────────────────────");
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
