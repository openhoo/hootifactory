/**
 * Seed a demo org + admin user (owner) + an owner-scoped API token.
 * Idempotent for org/user/membership; always mints a fresh token.
 *
 *   bun run db:seed
 */
import { createApiToken, hashPassword } from "@hootifactory/auth";
import { and, db, eq, memberships, organizations, users } from "@hootifactory/db";

const ORG_SLUG = process.env.SEED_ORG ?? "acme";
const ADMIN_USER = process.env.SEED_USER ?? "admin";
const ADMIN_PASS = process.env.SEED_PASS ?? "admin123";

async function main() {
  let [org] = await db
    .select()
    .from(organizations)
    .where(eq(organizations.slug, ORG_SLUG))
    .limit(1);
  if (!org) {
    [org] = await db
      .insert(organizations)
      .values({ slug: ORG_SLUG, displayName: "Acme Inc" })
      .returning();
    console.log(`created org ${ORG_SLUG}`);
  }
  if (!org) throw new Error("org creation failed");

  let [user] = await db.select().from(users).where(eq(users.username, ADMIN_USER)).limit(1);
  if (!user) {
    [user] = await db
      .insert(users)
      .values({
        username: ADMIN_USER,
        email: `${ADMIN_USER}@${ORG_SLUG}.test`,
        displayName: "Administrator",
        passwordHash: await hashPassword(ADMIN_PASS),
      })
      .returning();
    console.log(`created user ${ADMIN_USER}`);
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

  const { secret } = await createApiToken({
    orgId: org.id,
    ownerUserId: user.id,
    name: "seed-token",
    role: "owner",
  });

  console.log("\n── seed complete ──────────────────────────────");
  console.log(`  org:    ${org.slug}  (${org.id})`);
  console.log(`  login:  ${ADMIN_USER} / ${ADMIN_PASS}`);
  console.log(`  token:  ${secret}`);
  console.log("───────────────────────────────────────────────");
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
