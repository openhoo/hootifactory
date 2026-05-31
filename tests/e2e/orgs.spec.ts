import { expect, test } from "@playwright/test";
import { anonContext, setupOwner, uniq } from "./helpers";

test.describe("organizations", () => {
  test("create org -> creator becomes owner; appears in /api/orgs", async ({ baseURL }) => {
    const owner = await setupOwner(baseURL!);
    const orgs = await (await owner.ctx.get("/api/orgs")).json();
    const mine = orgs.orgs.find((o: { id: string }) => o.id === owner.orgId);
    expect(mine).toBeTruthy();
    expect(mine.role).toBe("owner");
  });

  test("anonymous cannot create org -> 401", async ({ baseURL }) => {
    const anon = await anonContext(baseURL!);
    const res = await anon.post("/api/orgs", { data: { slug: uniq("x"), displayName: "X" } });
    expect(res.status()).toBe(401);
  });

  test("invalid slug -> 400", async ({ baseURL }) => {
    const owner = await setupOwner(baseURL!);
    const res = await owner.ctx.post("/api/orgs", {
      data: { slug: "Invalid Slug!", displayName: "Bad" },
    });
    expect(res.status()).toBe(400);
  });

  test("duplicate slug -> 409", async ({ baseURL }) => {
    const owner = await setupOwner(baseURL!);
    const slug = uniq("dupe-org");
    expect((await owner.ctx.post("/api/orgs", { data: { slug, displayName: "A" } })).status()).toBe(
      201,
    );
    const again = await owner.ctx.post("/api/orgs", { data: { slug, displayName: "B" } });
    expect(again.status()).toBe(409);
  });
});
