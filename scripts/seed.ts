/**
 * Seed a demo org + owner user. Idempotent for org/user/membership.
 * Non-production runs mint and print a fresh owner token for local setup.
 *
 *   bun run db:seed
 */
import { randomBytes } from "node:crypto";
import { createApiToken, hashPassword } from "@hootifactory/auth";
import { and, db, eq, memberships, organizations, users } from "@hootifactory/db";

const isProduction = process.env.NODE_ENV === "production";

function envNonEmpty(name: string): string | null {
  const value = process.env[name]?.trim();
  return value ? value : null;
}

function seedPassword(): { value: string; generated: boolean } {
  const explicit = process.env.SEED_PASS;
  if (explicit && explicit.length > 0) return { value: explicit, generated: false };
  if (isProduction) {
    throw new Error("SEED_PASS is required when running db:seed with NODE_ENV=production");
  }
  return { value: randomBytes(24).toString("base64url"), generated: true };
}

async function main() {
  const orgSlug = envNonEmpty("SEED_ORG") ?? "acme";
  const adminUser = envNonEmpty("SEED_USER");
  if (isProduction && !adminUser) {
    throw new Error("SEED_USER is required when running db:seed with NODE_ENV=production");
  }
  const username = adminUser ?? "admin";
  const password = seedPassword();
  const shouldMintToken = !isProduction || process.env.SEED_PRINT_TOKEN === "true";

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
  let createdUser = false;
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
    createdUser = true;
    console.log(`created user ${username}`);
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
  if (createdUser) {
    console.log(
      `  login:  ${username} / ${password.value}${password.generated ? "  (generated)" : ""}`,
    );
  } else {
    console.log(`  login:  ${username}  (existing user; password unchanged)`);
  }
  console.log(
    token
      ? `  token:  ${token.secret}`
      : "  token:  not minted in production; set SEED_PRINT_TOKEN=true to print one",
  );
  console.log("───────────────────────────────────────────────");
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
